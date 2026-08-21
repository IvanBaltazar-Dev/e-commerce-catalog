-- 0144 · Evidencia por código: una fila por observación, un resumen derivado.
--
-- El embudo se venía calculando al vuelo en un script. Eso servía para mirar,
-- no para saber: cada corrida lo recalculaba desde cero y nadie podía preguntar
-- «¿qué sabemos de SH-496?» sin volver a recorrer los ficheros.
--
-- Dos tablas, y la separación entre ellas es lo que importa:
--
--   code_evidence          una fila por OBSERVACIÓN real, con su fuente y fecha
--   code_evidence_summary  la lectura acumulada, derivada, recalculable
--
-- Y una regla que evita destruir información: el resumen NO guarda un único
-- estado. Un código puede estar a la vez en el catálogo vigente, en la historia
-- aduanera y en el catálogo de otro distribuidor, y las tres cosas son ciertas.
-- Obligar a elegir una perdería justamente lo que hace útil el cruce.
--
--   SH-496
--     CURRENT_CATALOG = true
--     TRADE_HISTORY   = true
--     OTHER_DISTRIBUTOR = true
--
-- El «estado» que se enseña se deriva de esas banderas, no las sustituye.

begin;

create table if not exists public.code_evidence (
  id uuid primary key default gen_random_uuid(),

  -- La forma de comparación: sin guiones, espacios ni almohadilla, en
  -- mayúsculas. «SH-496», «SH 496» y «#SH496» son el mismo código.
  normalized_code text not null,
  observed_code text not null,

  evidence_type text not null,

  source_id uuid references public.catalog_sources(id) on delete set null,
  snapshot_id uuid references public.catalog_source_snapshots(id) on delete set null,
  source_record_id uuid references public.catalog_source_records(id) on delete set null,
  -- Quién declaró u observó. Un mismo código puede venir de dos operadores
  -- distintos, y eso es información, no ruido.
  actor_key text,

  observed_name text,
  observed_brand text,
  observed_presentation text,
  observed_at timestamptz not null,
  raw_text text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint code_evidence_code_not_blank
    check (length(trim(normalized_code)) > 0 and length(trim(observed_code)) > 0),
  constraint code_evidence_type_allowed check (evidence_type in (
    'CURRENT_CATALOG',        -- el catálogo vigente del propio operador
    'CURRENTLY_UNAVAILABLE',  -- la ficha existe y la fuente la declara agotada
    'TRADE_HISTORY',          -- importación registrada, con fecha
    'COMMERCIAL_INVOICE',     -- factura, boleta o lista de precios emitida
    'MARKETPLACE_CURRENT',
    'MARKETPLACE_HISTORICAL',
    'REGULATORY',             -- NSO, rotulado, acto administrativo
    'TECHNICAL_DOCUMENT',
    'OTHER_DISTRIBUTOR'       -- lo publica otro operador del mismo ecosistema
  )),
  constraint code_evidence_metadata_object check (jsonb_typeof(metadata) = 'object')
);

-- La misma observación, del mismo registro, no se cuenta dos veces.
create unique index if not exists code_evidence_unica_idx
  on public.code_evidence (
    normalized_code, evidence_type,
    coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(source_record_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
create index if not exists code_evidence_codigo_idx on public.code_evidence (normalized_code);
create index if not exists code_evidence_tipo_idx on public.code_evidence (evidence_type, observed_at desc);

comment on table public.code_evidence is
  'Una fila por observación real de un código en una fuente. No se deduplica '
  'por código: si tres fuentes lo vieron, son tres evidencias.';

-- ── La lectura acumulada ────────────────────────────────────────────────────
-- Vista, no tabla: se deriva de la evidencia y no puede quedar desincronizada.
-- Si mañana llega una observación nueva, el resumen cambia solo.
create or replace view public.code_evidence_summary_v1
with (security_invoker = true) as
select
  e.normalized_code,
  bool_or(e.evidence_type = 'CURRENT_CATALOG') as current_catalog_seen,
  bool_or(e.evidence_type = 'CURRENTLY_UNAVAILABLE') as currently_unavailable_seen,
  bool_or(e.evidence_type = 'TRADE_HISTORY') as trade_history_seen,
  bool_or(e.evidence_type = 'COMMERCIAL_INVOICE') as commercial_invoice_seen,
  bool_or(e.evidence_type in ('MARKETPLACE_CURRENT', 'MARKETPLACE_HISTORICAL')) as marketplace_seen,
  bool_or(e.evidence_type = 'REGULATORY') as regulatory_seen,
  bool_or(e.evidence_type = 'TECHNICAL_DOCUMENT') as technical_document_seen,
  bool_or(e.evidence_type = 'OTHER_DISTRIBUTOR') as other_distributor_seen,
  min(e.observed_at) as first_seen_at,
  max(e.observed_at) as last_seen_at,
  max(e.observed_at) filter (where e.evidence_type = 'CURRENT_CATALOG') as latest_current_seen_at,
  count(distinct e.source_id) as source_count,
  count(*) as observation_count,
  count(distinct e.actor_key) filter (where e.actor_key is not null) as actor_count,
  -- Identificado y vigente son cosas distintas, y por eso el estado se lee en
  -- este orden: primero si se vende hoy, después si lo vende otro, después si
  -- solo existe en la historia. Ninguno borra a los demás — las banderas de
  -- arriba siguen ahí para quien necesite el detalle.
  case
    when bool_or(e.evidence_type = 'CURRENT_CATALOG') then 'IDENTIFIED_CURRENT'
    when bool_or(e.evidence_type = 'MARKETPLACE_CURRENT') then 'IDENTIFIED_CURRENT'
    when bool_or(e.evidence_type = 'OTHER_DISTRIBUTOR') then 'IDENTIFIED_EXTERNAL'
    when bool_or(e.evidence_type = 'CURRENTLY_UNAVAILABLE') then 'IDENTIFIED_BUT_SCOPE_UNKNOWN'
    when bool_or(e.evidence_type = 'TRADE_HISTORY') then 'IDENTIFIED_HISTORICAL'
    when bool_or(e.evidence_type = 'COMMERCIAL_INVOICE') then 'IDENTIFIED_HISTORICAL'
    when bool_or(e.evidence_type = 'REGULATORY') then 'IDENTIFIED_REGULATORY'
    when bool_or(e.evidence_type = 'TECHNICAL_DOCUMENT') then 'IDENTIFIED_REGULATORY'
    else 'IDENTIFIED_BUT_SCOPE_UNKNOWN'
  end as best_identity_status,
  -- La confianza sube con fuentes independientes, no con observaciones
  -- repetidas de la misma: cinco tiendas copiando el mismo feed no son cinco
  -- confirmaciones.
  least(1.0, 0.4 + 0.3 * least(2, count(distinct e.source_id) - 1)
             + case when bool_or(e.evidence_type = 'CURRENT_CATALOG') then 0.3 else 0 end)::numeric(4,3)
    as identity_confidence
from public.code_evidence e
group by e.normalized_code;

comment on view public.code_evidence_summary_v1 is
  'Lectura acumulada por código. Las banderas conviven: un código puede estar a '
  'la vez vigente, en historia aduanera y en otro distribuidor. best_identity_status '
  'es una derivación para mostrar, no un sustituto de las banderas.';

alter table public.code_evidence enable row level security;
create policy "admins manage code evidence" on public.code_evidence
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.code_evidence to authenticated, service_role;
grant select on public.code_evidence_summary_v1 to authenticated, service_role;

commit;

-- Añadido al primer intento de carga: un índice con coalesce() no puede ser
-- objetivo de ON CONFLICT, así que cada corrida habría duplicado la evidencia en
-- vez de reconocerla. La llave natural pasa a columna generada y almacenada.
alter table public.code_evidence
  add column if not exists evidence_key text generated always as (
    normalized_code || '|' || evidence_type || '|' ||
    coalesce(source_id::text, '-') || '|' || coalesce(source_record_id::text, '-')
  ) stored;
drop index if exists code_evidence_unica_idx;
alter table public.code_evidence drop constraint if exists code_evidence_natural_key;
alter table public.code_evidence add constraint code_evidence_natural_key unique (evidence_key);
