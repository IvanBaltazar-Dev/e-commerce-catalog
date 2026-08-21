-- 0152 · Retirar de circulación lo que una interpretación equivocada produjo.
--
-- El RAW anterior de Cherimoya se conserva: su snapshot, sus registros de fuente
-- y sus observaciones siguen intactos como historia. Lo que no puede seguir
-- circulando son dos derivaciones que hoy sabemos falsas:
--
--   1.395 «variantes» que eran una por producto. La Store API dice que hay 65
--         productos variables con 231 variaciones reales; las 1.395 salían de
--         aplanar cada ficha en su propia variante.
--
--   1.395 precios multiplicados por 100. La API declara currency_minor_unit = 2,
--         así que «1800» son 18,00. Guardados como soles, un producto de S/18
--         figuraba como S/1.800, y el máximo del catálogo como S/200.000.
--
-- ── Por qué no vale ninguno de los estados que ya existen ────────────────────
--
-- presence_status dice si el ítem sigue estando en la fuente: present,
-- missing_from_source, retired. Ninguno encaja — esas variantes no «faltan de la
-- fuente», es que nunca existieron. Y el precio no está ausente, está mal
-- escalado.
--
-- knowledge_status dice qué hemos decidido sobre el ítem: adopted, rejected,
-- needs_research. Tampoco: no rechazamos el producto, retiramos NUESTRA lectura
-- de él.
--
-- Son ejes distintos y mezclarlos perdería información. Un producto puede estar
-- presente en la fuente, aceptado por nosotros, y aun así tener una derivación
-- superseded. Por eso va en su propio eje.

begin;

-- ── El eje nuevo ────────────────────────────────────────────────────────────
alter table public.catalog_reference_variants
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by_snapshot_id uuid references public.catalog_source_snapshots(id),
  add column if not exists superseded_reason text;

alter table public.catalog_reference_prices
  add column if not exists superseded_at timestamptz,
  add column if not exists superseded_by_snapshot_id uuid references public.catalog_source_snapshots(id),
  add column if not exists superseded_reason text;

comment on column public.catalog_reference_variants.superseded_at is
  'Cuándo se retiró esta derivación de circulación. La fila se conserva como '
  'historia; las lecturas activas deben excluirla. Es un eje distinto de '
  'presence_status (si sigue en la fuente) y de knowledge_status (qué decidimos).';

create index if not exists catalog_reference_variants_vigentes_idx
  on public.catalog_reference_variants (primary_source_id) where superseded_at is null;
create index if not exists catalog_reference_prices_vigentes_idx
  on public.catalog_reference_prices (source_id) where superseded_at is null;

-- ── Marcar lo de Cherimoya, apuntando a lo que lo sustituye ─────────────────
with woo as (
  select s.id
  from public.catalog_source_snapshots s
  join public.catalog_sources f on f.id = s.source_id
  where f.source_key = 'cherimoya-pe-official'
    and s.metadata->>'via' = 'woocommerce_store_api'
  order by s.created_at desc limit 1
),
antiguas as (
  select v.id
  from public.catalog_reference_variants v
  join public.catalog_sources f on f.id = v.primary_source_id
  join public.catalog_source_records r on r.id = v.primary_source_record_id
  where f.source_key = 'cherimoya-pe-official'
    and r.external_id not like 'woo-%'
)
update public.catalog_reference_variants v
set superseded_at = now(),
    superseded_by_snapshot_id = (select id from woo),
    superseded_reason =
      'Variante producida al aplanar cada ficha en su propia variante. La Store API '
      'declara 65 productos variables con 231 variaciones reales; estas 1.395 no '
      'corresponden a ninguna variación publicada.'
where v.id in (select id from antiguas) and v.superseded_at is null;

with woo as (
  select s.id
  from public.catalog_source_snapshots s
  join public.catalog_sources f on f.id = s.source_id
  where f.source_key = 'cherimoya-pe-official'
    and s.metadata->>'via' = 'woocommerce_store_api'
  order by s.created_at desc limit 1
)
update public.catalog_reference_prices p
set superseded_at = now(),
    superseded_by_snapshot_id = (select id from woo),
    superseded_reason =
      'Importe en unidades menores leído como unidad de moneda. La Store API declara '
      'currency_minor_unit = 2, así que el valor guardado está multiplicado por 100.'
from public.catalog_sources f
where f.id = p.source_id and f.source_key = 'cherimoya-pe-official'
  and p.superseded_at is null;

-- ── Las lecturas activas dejan de verlas ────────────────────────────────────
-- Se añade el filtro a las tres vistas que consumen estas tablas. Una vista que
-- no filtre es exactamente el agujero que esto quiere cerrar: la fila seguiría
-- disponible y nadie lo notaría.
create or replace view public.catalog_reference_variants_vigentes_v1
with (security_invoker = true) as
  select * from public.catalog_reference_variants where superseded_at is null;

create or replace view public.catalog_reference_prices_vigentes_v1
with (security_invoker = true) as
  select * from public.catalog_reference_prices where superseded_at is null;

comment on view public.catalog_reference_variants_vigentes_v1 is
  'Variantes de referencia en circulación. Toda lectura activa debe entrar por '
  'aquí; la tabla base conserva además las derivaciones retiradas.';

grant select on public.catalog_reference_variants_vigentes_v1 to authenticated, service_role;
grant select on public.catalog_reference_prices_vigentes_v1 to authenticated, service_role;

do $$
declare v_sup integer; p_sup integer; v_viv integer;
begin
  select count(*) into v_sup from public.catalog_reference_variants where superseded_at is not null;
  select count(*) into p_sup from public.catalog_reference_prices where superseded_at is not null;
  select count(*) into v_viv from public.catalog_reference_variants_vigentes_v1 v
    join public.catalog_sources f on f.id = v.primary_source_id
    where f.source_key = 'cherimoya-pe-official';
  raise notice 'variantes retiradas: % · precios retirados: % · variantes vigentes de Cherimoya: %',
    v_sup, p_sup, v_viv;
end $$;

commit;
