-- 0140 · El namespace del identificador, no solo su emisor.
--
-- La unicidad real de un identificador no es `tipo + valor` ni siquiera
-- `emisor + tipo + valor`: es el NAMESPACE en el que fue asignado, y cada tipo
-- tiene el suyo.
--
--   GTIN / EAN / UPC      GLOBAL_GS1        el mismo en todo el mundo
--   MANUFACTURER_SKU      el fabricante     Masglo numera aparte de Admiss
--   MPN                   el fabricante
--   SUPPLIER_SKU          el proveedor      SAC-4 de Konsung ≠ SAC-4 de Candy Secret
--   SOURCE_EXTERNAL_ID    la fuente         el id interno de una tienda
--   BELLAROSHE_SKU        BELLAROSHE        el nuestro
--
-- La diferencia importa en las dos direcciones. `SAC-4` bajo dos proveedores
-- distintos NO choca: son dos códigos que se escriben igual. Pero el mismo
-- `SAC-4` bajo Konsung asignado a dos variantes activas SÍ es un conflicto, y
-- hasta ahora la base no podía verlo porque el índice solo miraba la variante.
--
-- Y el sentido inverso: cinco tiendas que publican el mismo EAN no crean cinco
-- identidades. Son cinco evidencias del mismo identificador — el GTIN vive en un
-- namespace global y no pertenece a quien lo observó.

begin;

-- ── Lado comercial ──────────────────────────────────────────────────────────
alter table public.variant_identifiers
  add column if not exists namespace_kind text,
  add column if not exists namespace_key text;

update public.variant_identifiers set
  namespace_kind = case identifier_type
    when 'GTIN' then 'GLOBAL_GS1'
    when 'EAN' then 'GLOBAL_GS1'
    when 'UPC' then 'GLOBAL_GS1'
    when 'BELLAROSHE_SKU' then 'BELLAROSHE'
    when 'MANUFACTURER_SKU' then 'BRAND'
    when 'MPN' then 'BRAND'
    when 'SUPPLIER_SKU' then 'SUPPLIER'
    when 'SOURCE_EXTERNAL_ID' then 'SOURCE'
  end,
  namespace_key = case identifier_type
    when 'GTIN' then 'GS1'
    when 'EAN' then 'GS1'
    when 'UPC' then 'GS1'
    when 'BELLAROSHE_SKU' then 'BELLAROSHE'
    -- El emisor ya lo veníamos guardando: para marca y proveedor ES el
    -- namespace, solo que sin nombre. Ahora lo tiene.
    else coalesce(nullif(trim(issuer), ''), 'DESCONOCIDO')
  end
where namespace_kind is null;

alter table public.variant_identifiers
  alter column namespace_kind set not null,
  alter column namespace_key set not null;

alter table public.variant_identifiers
  drop constraint if exists variant_identifiers_namespace_allowed;
alter table public.variant_identifiers
  add constraint variant_identifiers_namespace_allowed
  check (namespace_kind in ('GLOBAL_GS1', 'BRAND', 'SUPPLIER', 'SOURCE', 'BELLAROSHE'));

-- Un identificador global no puede colgar de un emisor particular: si dos
-- fuentes publican el mismo EAN, es el mismo EAN.
alter table public.variant_identifiers
  drop constraint if exists variant_identifiers_gs1_sin_emisor;
alter table public.variant_identifiers
  add constraint variant_identifiers_gs1_sin_emisor
  check (namespace_kind <> 'GLOBAL_GS1' or namespace_key = 'GS1');

drop index if exists variant_identifiers_unicos_idx;
create unique index if not exists variant_identifiers_unicos_idx
  on public.variant_identifiers (variant_id, identifier_type, namespace_kind, namespace_key, value);

-- El conflicto que antes no se podía ver: un mismo código, en un mismo
-- namespace, reclamado por dos variantes activas distintas. Se detecta, no se
-- impide — puede ser un duplicado real del catálogo, y eso lo decide la dueña.
create or replace view public.variant_identifier_collisions_v1
with (security_invoker = true) as
select
  identifier_type, namespace_kind, namespace_key, value,
  count(*) as variantes,
  array_agg(variant_id order by variant_id) as variant_ids
from public.variant_identifiers
where status = 'active' and namespace_kind <> 'BELLAROSHE'
group by 1, 2, 3, 4
having count(*) > 1;

comment on view public.variant_identifier_collisions_v1 is
  'Un mismo código del mismo namespace reclamado por dos variantes activas. No '
  'incluye BELLAROSHE porque nuestro correlativo es único por construcción.';

grant select on public.variant_identifier_collisions_v1 to authenticated, service_role;

-- ── Lado referencia ─────────────────────────────────────────────────────────
alter table public.catalog_reference_identifiers
  add column if not exists namespace_kind text,
  add column if not exists namespace_key text;

alter table public.catalog_reference_identifiers
  drop constraint if exists catalog_reference_identifiers_namespace_allowed;
alter table public.catalog_reference_identifiers
  add constraint catalog_reference_identifiers_namespace_allowed
  check (namespace_kind is null or namespace_kind in ('GLOBAL_GS1', 'BRAND', 'SUPPLIER', 'SOURCE', 'BELLAROSHE'));

-- La misma observación repetida en dos rastreos no es un identificador nuevo.
-- Sin esto, cada backfill duplicaría los 3.406 y la memoria engordaría sin
-- aprender nada.
create unique index if not exists catalog_reference_identifiers_unicos_idx
  on public.catalog_reference_identifiers (
    coalesce(reference_product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(reference_variant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    identifier_kind,
    normalized_value
  );

comment on column public.catalog_reference_identifiers.namespace_kind is
  'En qué espacio se asignó el código. Un GTIN es global; un SKU pertenece al '
  'fabricante que lo emitió, y por eso SAC-4 de Konsung no es SAC-4 de Candy Secret.';

commit;

-- Añadido tras el primer intento de backfill: el índice con coalesce() no puede
-- ser objetivo de ON CONFLICT, así que cada corrida habría duplicado los 17.110
-- identificadores en vez de reconocerlos. target_ref es columna generada y
-- almacenada, así que la restricción sí usa columnas planas.
alter table public.catalog_reference_identifiers
  drop constraint if exists catalog_reference_identifiers_natural_key;
alter table public.catalog_reference_identifiers
  add constraint catalog_reference_identifiers_natural_key
  unique (target_ref, identifier_kind, normalized_value);
