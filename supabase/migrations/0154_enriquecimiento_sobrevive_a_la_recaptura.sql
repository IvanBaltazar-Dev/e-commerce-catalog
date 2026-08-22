-- 0154 · El enriquecimiento pertenece a la identidad, no al snapshot.
--
-- Tercera vez que muerde el mismo fallo, y las dos anteriores las arreglé como
-- si fueran casos aislados de barcode. No lo son.
--
--   Los 295 códigos de barras de Masglo se cosecharon uno a uno abriendo 304
--   fichas individuales, porque products.json no devuelve ese campo. Después se
--   recargó la fuente, la recarga creó un snapshot nuevo con registros nuevos, y
--   el snapshot vigente pasó a tener CERO códigos. Los 295 seguían ahí, en un
--   snapshot anterior, invisibles para todo.
--
-- La confusión de fondo es de qué cuelga cada cosa:
--
--   snapshot                    evidencia de UNA captura. Es inmutable y
--                               desechable: mañana hay otro.
--   producto/variante de
--   referencia                  identidad persistente. Sobrevive a las capturas.
--   enriquecimiento validado    pertenece a la IDENTIDAD, no a la captura que lo
--                               descubrió. Sobrevive mientras conserve su
--                               procedencia y nadie lo contradiga.
--
-- Un código de barras no deja de ser cierto porque volvamos a leer la tienda.
-- Tampoco un atributo, una imagen o una medida obtenidos con esfuerzo. Guardarlos
-- colgando del snapshot los condena a desaparecer en la siguiente recaptura, y de
-- la peor forma: sin error, sin aviso, y con el dato todavía en la base.

begin;

create table if not exists public.catalog_enrichment_facts (
  id uuid primary key default gen_random_uuid(),

  -- La identidad a la que pertenece el dato, expresada de forma que sobreviva a
  -- que se reconstruya la fila de referencia: (fuente, tipo, id externo). El id
  -- externo se guarda ya sin prefijo, porque su forma ha cambiado dos veces
  -- —«v:123», «shopify-variant:123»— y la identidad no cambió con ella.
  source_id uuid not null references public.catalog_sources(id) on delete cascade,
  entity_kind text not null,
  external_id text not null,

  -- Qué se enriqueció. No es una columna fija: hoy es barcode, mañana un
  -- atributo o una medida, y el mecanismo tiene que servir igual.
  field text not null,
  value text not null,

  -- Procedencia. Sin esto el dato no es enriquecimiento validado, es un dato
  -- suelto que nadie sabe de dónde salió.
  obtained_by text not null,
  obtained_at timestamptz not null default now(),
  evidence_url text,
  source_record_id uuid references public.catalog_source_records(id) on delete set null,
  rule_code text,
  rule_version integer,
  confidence numeric(4,3),

  -- Y el mismo eje de retirada que en el resto: se retira, no se borra.
  superseded_at timestamptz,
  superseded_reason text,
  superseded_by uuid references public.catalog_enrichment_facts(id),

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint catalog_enrichment_facts_entity_allowed
    check (entity_kind in ('product', 'variant')),
  constraint catalog_enrichment_facts_no_blank
    check (length(trim(external_id)) > 0 and length(trim(field)) > 0 and length(trim(value)) > 0),
  constraint catalog_enrichment_facts_obtained_by_no_blank
    check (length(trim(obtained_by)) > 0),
  -- El mismo hecho, del mismo campo, para la misma identidad, no se guarda dos
  -- veces. Un valor DISTINTO sí entra: dos valores en conflicto son información,
  -- y se resuelven retirando uno, no impidiendo que exista.
  constraint catalog_enrichment_facts_unico
    unique (source_id, entity_kind, external_id, field, value)
);

create index if not exists catalog_enrichment_facts_identidad_idx
  on public.catalog_enrichment_facts (source_id, entity_kind, external_id) where superseded_at is null;
create index if not exists catalog_enrichment_facts_campo_idx
  on public.catalog_enrichment_facts (field) where superseded_at is null;

comment on table public.catalog_enrichment_facts is
  'Enriquecimiento que pertenece a la identidad del producto o variante, no al '
  'snapshot que lo descubrió. Sobrevive a las recapturas mientras conserve su '
  'procedencia y nadie lo contradiga.';

-- ── Lo vigente, y los conflictos a la vista ─────────────────────────────────
create or replace view public.catalog_enrichment_vigente_v1
with (security_invoker = true) as
select
  e.source_id, f.source_key, e.entity_kind, e.external_id, e.field,
  e.value, e.obtained_by, e.obtained_at, e.evidence_url, e.rule_code, e.confidence,
  count(*) over (partition by e.source_id, e.entity_kind, e.external_id, e.field) as valores_para_este_campo
from public.catalog_enrichment_facts e
join public.catalog_sources f on f.id = e.source_id
where e.superseded_at is null;

comment on view public.catalog_enrichment_vigente_v1 is
  'Enriquecimiento en circulación. valores_para_este_campo > 1 señala un '
  'conflicto: dos valores distintos para el mismo campo de la misma identidad.';

grant select on public.catalog_enrichment_facts to authenticated, service_role;
grant select on public.catalog_enrichment_vigente_v1 to authenticated, service_role;
alter table public.catalog_enrichment_facts enable row level security;
create policy "admins manage enrichment" on public.catalog_enrichment_facts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- ── Rescatar los 295 códigos, de cualquier snapshot en que estén ────────────
-- Se toman de donde estén, incluidos los snapshots ya superados, porque el dato
-- no caduca con la captura que lo encontró.
insert into public.catalog_enrichment_facts
  (source_id, entity_kind, external_id, field, value, obtained_by, obtained_at, source_record_id, rule_code, confidence, metadata)
select distinct on (r.source_id, r.entity_type, split_part(r.external_id, ':', 2))
  r.source_id,
  r.entity_type,
  split_part(r.external_id, ':', 2),
  'barcode',
  r.barcode,
  'cosechar-barcodes-marca',
  coalesce(r.captured_at, now()),
  r.id,
  'GTIN_FICHA_INDIVIDUAL',
  1.0,
  jsonb_build_object(
    'nota', 'EAN-13 leido de la ficha individual porque products.json no devuelve el campo',
    'snapshot_origen', r.snapshot_id)
from public.catalog_source_records r
where r.barcode is not null
  and r.entity_type in ('product', 'variant')
order by r.source_id, r.entity_type, split_part(r.external_id, ':', 2), r.captured_at desc
on conflict do nothing;

do $$
declare n integer;
begin
  select count(*) into n from public.catalog_enrichment_facts where field = 'barcode';
  raise notice 'códigos de barras rescatados a enriquecimiento: %', n;
end $$;

commit;
