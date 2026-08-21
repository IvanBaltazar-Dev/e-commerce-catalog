-- 0146 · Una fila por URL descubierta. El cierre deja de ser una opinión.
--
-- El fallo que obliga a esto ya ocurrió dos veces, y las dos se disfrazó de
-- éxito:
--
--   1. La captura por buscador informó «COMPLETE · 649 productos». Era cierto
--      para el índice de búsqueda y falso para el catálogo, que tiene 2.583. No
--      había con qué contrastar, así que nadie lo notó durante meses.
--
--   2. La captura por sitemap informó «0 URLs fallidas» con 2.142 de 2.583
--      capturadas. El nombre de fichero de caché colisionaba, unas fichas
--      sobrescribían a otras, y el rastreo veía «ya existe el fichero» y daba la
--      URL por hecha. Cero fallidas y 441 desaparecidas al mismo tiempo.
--
-- Lo que las une no es el bug: es que el recuento agregado NO PUEDE detectarlas.
-- Un total no sabe qué le falta. Por eso aquí cada URL descubierta tiene su
-- propia fila y su propio desenlace, y el cierre se calcula comprobando que la
-- suma cuadre:
--
--   descubiertas = intentadas = capturadas + ausencias + permanentes + pendientes
--
-- Si la ecuación no cuadra, hay URLs sin explicar y la campaña no puede
-- declararse completa por mucho que el recuento parezca bonito.

begin;

create table if not exists public.capture_url_ledger (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.catalog_source_snapshots(id) on delete cascade,
  source_id uuid not null references public.catalog_sources(id) on delete cascade,

  url text not null,
  -- El SHA-256 de la URL es a la vez la llave de comparación y el nombre del
  -- fichero de caché. Que sean lo mismo es deliberado: así una ficha guardada
  -- puede rastrearse hasta su URL sin depender de ningún índice externo.
  url_sha256 text not null,

  outcome text not null,
  http_status integer,
  -- Por qué falló, en una etiqueta con la que se pueda decidir. «error» a secas
  -- no distingue entre una ficha retirada y un corte de red.
  error_class text,
  error_detail text,

  attempts integer not null default 0,
  first_attempt_at timestamptz,
  last_attempt_at timestamptz,

  -- Nombre del artefacto en caché. Presente si y solo si se capturó: es lo que
  -- permite demostrar que «capturada» no es una afirmación sino un fichero.
  artifact_sha256 text,
  artifact_bytes integer,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint capture_url_ledger_url_not_blank check (length(trim(url)) > 0),
  constraint capture_url_ledger_sha_shape check (url_sha256 ~ '^[0-9a-f]{64}$'),
  constraint capture_url_ledger_outcome_allowed check (outcome in (
    'CAPTURED',                 -- hay artefacto y es de esta URL
    'VALID_ABSENCE',            -- la fuente dice que no existe, y le creemos (404, 410)
    'PERMANENT_ERROR',          -- no se podrá recuperar reintentando
    'TEMPORARY_ERROR_PENDING'   -- puede recuperarse: la campaña NO está completa
  )),
  -- Capturada obliga a artefacto, y artefacto obliga a capturada. Sin esto,
  -- «capturada» vuelve a ser una palabra en un recuento.
  constraint capture_url_ledger_artifact_coherente check (
    (outcome = 'CAPTURED' and artifact_sha256 is not null)
    or (outcome <> 'CAPTURED' and artifact_sha256 is null)
  ),
  -- Un fallo sin clasificar es un fallo que nadie va a saber tratar.
  constraint capture_url_ledger_error_clasificado check (
    outcome not in ('PERMANENT_ERROR', 'TEMPORARY_ERROR_PENDING') or error_class is not null
  ),
  constraint capture_url_ledger_intentada check (
    attempts > 0 or outcome = 'TEMPORARY_ERROR_PENDING'
  ),
  constraint capture_url_ledger_unica unique (snapshot_id, url_sha256)
);

create index if not exists capture_url_ledger_snapshot_idx on public.capture_url_ledger (snapshot_id, outcome);
create index if not exists capture_url_ledger_artifact_idx on public.capture_url_ledger (snapshot_id, artifact_sha256);

comment on table public.capture_url_ledger is
  'Una fila por URL descubierta en una captura, con su desenlace. El cierre se '
  'demuestra sumando filas, no confiando en un contador.';

comment on column public.capture_url_ledger.artifact_sha256 is
  'Nombre del fichero en caché, que es el SHA-256 de la URL. Presente si y solo '
  'si outcome = CAPTURED.';

-- ── La auditoría de cierre ───────────────────────────────────────────────────
-- Todo lo que hace falta para decidir si una campaña puede llamarse completa,
-- y —más importante— para explicar por qué no puede cuando no puede.
create or replace view public.capture_closure_audit_v1
with (security_invoker = true) as
with conteo as (
  select
    l.snapshot_id,
    count(*)                                                          as descubiertas,
    count(*) filter (where l.attempts > 0)                            as intentadas,
    count(*) filter (where l.outcome = 'CAPTURED')                    as capturadas,
    count(*) filter (where l.outcome = 'VALID_ABSENCE')               as ausencias,
    count(*) filter (where l.outcome = 'PERMANENT_ERROR')             as permanentes,
    count(*) filter (where l.outcome = 'TEMPORARY_ERROR_PENDING')     as pendientes,
    count(distinct l.artifact_sha256) filter (where l.artifact_sha256 is not null) as artefactos_distintos,
    count(*) filter (where l.artifact_sha256 is not null)             as artefactos_referidos
  from public.capture_url_ledger l
  group by l.snapshot_id
)
select
  c.snapshot_id,
  s.source_id,
  f.source_key,
  (s.metadata->>'declared_total')::integer as declarado_por_la_fuente,
  c.descubiertas,
  c.intentadas,
  c.capturadas,
  c.ausencias,
  c.permanentes,
  c.pendientes,
  -- Dos URLs distintas no pueden compartir artefacto. Si lo hacen, una ha
  -- sobrescrito a la otra: es exactamente el fallo de 2.583 → 2.142.
  (c.artefactos_referidos - c.artefactos_distintos) as colisiones_de_artefacto,
  (c.descubiertas = c.intentadas) as todas_intentadas,
  (c.intentadas = c.capturadas + c.ausencias + c.permanentes + c.pendientes) as suma_cuadra,
  -- El total declarado por la fuente es un testigo externo. Si el sitemap dice
  -- 2.583 y descubrimos 649, el problema está en el descubrimiento, no en la
  -- captura, y ningún recuento interno lo habría revelado.
  case
    when (s.metadata->>'declared_total') is null then null
    else (c.descubiertas = (s.metadata->>'declared_total')::integer)
  end as coincide_con_lo_declarado,
  (
        c.descubiertas > 0
    and c.descubiertas = c.intentadas
    and c.intentadas = c.capturadas + c.ausencias + c.permanentes + c.pendientes
    and c.pendientes = 0
    and c.artefactos_referidos = c.artefactos_distintos
    and coalesce(c.descubiertas = (s.metadata->>'declared_total')::integer, true)
  ) as puede_declararse_completa,
  case
    when c.descubiertas = 0 then 'no se descubrió ninguna URL'
    when c.descubiertas <> c.intentadas then
      format('%s URLs descubiertas nunca se intentaron', c.descubiertas - c.intentadas)
    when c.intentadas <> c.capturadas + c.ausencias + c.permanentes + c.pendientes then
      format('%s URLs sin desenlace registrado',
        c.intentadas - (c.capturadas + c.ausencias + c.permanentes + c.pendientes))
    when c.artefactos_referidos <> c.artefactos_distintos then
      format('%s artefactos compartidos por más de una URL: hubo sobrescritura',
        c.artefactos_referidos - c.artefactos_distintos)
    when c.pendientes > 0 then
      format('%s URLs con error temporal por reintentar', c.pendientes)
    when coalesce(c.descubiertas <> (s.metadata->>'declared_total')::integer, false) then
      format('la fuente declara %s y solo se descubrieron %s',
        s.metadata->>'declared_total', c.descubiertas)
    else 'cuadra'
  end as motivo
from conteo c
join public.catalog_source_snapshots s on s.id = c.snapshot_id
join public.catalog_sources f on f.id = s.source_id;

comment on view public.capture_closure_audit_v1 is
  'Demuestra el cierre: descubiertas = intentadas = capturadas + ausencias + '
  'permanentes + pendientes, sin colisiones de artefacto y cuadrando con el '
  'total que declara la fuente. El motivo explica por qué no, cuando no.';

alter table public.capture_url_ledger enable row level security;
create policy "admins manage capture ledger" on public.capture_url_ledger
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.capture_url_ledger to authenticated, service_role;
grant select on public.capture_closure_audit_v1 to authenticated, service_role;

commit;
