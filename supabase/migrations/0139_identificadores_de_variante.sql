-- 0139 · Un identificador, un tipo, una procedencia.
--
-- `product_variants.sku` lleva hoy cinco cosas distintas metidas en la misma
-- columna, y la historia del proyecto lo demuestra: una plantilla de Masglo
-- decía «SKU generado internamente; no corresponde al código del fabricante», y
-- una posterior sustituyó esos mismos identificadores por los oficiales. Dos
-- decisiones opuestas sobre la misma columna, ninguna equivocada en su momento.
--
-- La auditoría del 2026-08-20 sobre las 1.570 variantes:
--
--     729  código largo generado por la importación (GEN-DEC-ABD9C6-…)
--     622  correlativo interno (MAS014, CHE017)
--     189  numérico puro, que sí es del fabricante
--      30  otros
--
-- 1.351 de 1.570 no son SKU de fabricante. Convertir en regla global lo que se
-- decidió para Masglo sería repetir el error de origen en dirección contraria.
--
-- Y `sku` no es solo una etiqueta: está denormalizado a propósito en siete
-- tablas transaccionales —sale_lines, inventory_movements, goods_receipt_lines,
-- return_lines, reservation_lines, inventory_transfer_lines, low_stock_alerts—
-- porque cada una guarda el código tal como era el día de la operación. Hoy
-- están todas vacías y cambiarlo no rompe nada; en cuanto haya una venta, sí.
--
-- Así que en vez de seguir sobrecargando la columna, cada identificador pasa a
-- tener su tipo, su emisor y su evidencia. `sku` se queda como es —el código
-- comprable de Bellaroshé, que es lo que el POS teclea y el albarán imprime— y
-- el del fabricante vive al lado sin pelearse con él.

begin;

create table if not exists public.variant_identifiers (
  id uuid primary key default gen_random_uuid(),
  variant_id uuid not null references public.product_variants(id) on delete cascade,

  identifier_type text not null,
  value text not null,

  -- Quién emite el código. «310028» sin emisor no dice si es de Masglo o de
  -- otra numeración que empieza igual; con emisor, dos códigos iguales de
  -- emisores distintos dejan de ser un choque.
  issuer text,

  -- De dónde salió. La referencia y el registro de rastreo dicen exactamente
  -- qué ficha, en qué corrida y en qué instante lo publicó.
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete set null,
  source_id uuid references public.catalog_sources(id) on delete set null,
  source_record_id uuid references public.catalog_source_records(id) on delete set null,
  reconciliation_case_id uuid references public.catalog_reconciliation_cases(id) on delete set null,
  research_run_id uuid references public.catalog_research_runs(id) on delete set null,

  -- El primario de cada tipo es el que contesta cuando alguien pregunta «¿cuál
  -- es el SKU de fabricante de esto?». Puede haber varios históricos.
  is_primary boolean not null default true,
  status text not null default 'active',

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint variant_identifiers_type_allowed check (identifier_type in (
    'BELLAROSHE_SKU',      -- el correlativo nuestro; el que sale en las hojas
    'MANUFACTURER_SKU',    -- el del fabricante
    'SUPPLIER_SKU',        -- el del proveedor que nos lo vende
    'GTIN',                -- genérico cuando no se distingue la familia
    'EAN',
    'UPC',
    'MPN',
    'SOURCE_EXTERNAL_ID'   -- el id que la tienda usa internamente
  )),
  constraint variant_identifiers_status_allowed check (status in ('active', 'superseded', 'rejected')),
  constraint variant_identifiers_value_not_blank check (length(trim(value)) > 0),
  constraint variant_identifiers_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint variant_identifiers_seen_consistent check (first_seen_at <= last_seen_at)
);

-- El mismo valor del mismo tipo no se repite en una variante. Dos filas iguales
-- serían dos respuestas a la misma pregunta.
create unique index if not exists variant_identifiers_unicos_idx
  on public.variant_identifiers (variant_id, identifier_type, value);

-- Un solo primario por tipo y variante, y solo entre los activos: un histórico
-- superado no compite por contestar.
create unique index if not exists variant_identifiers_primario_idx
  on public.variant_identifiers (variant_id, identifier_type)
  where is_primary and status = 'active';

-- Buscar por código es la operación que hace posible reconciliar un lote nuevo
-- sin recorrer el catálogo entero.
create index if not exists variant_identifiers_valor_idx
  on public.variant_identifiers (identifier_type, lower(value)) where status = 'active';
create index if not exists variant_identifiers_variante_idx
  on public.variant_identifiers (variant_id, identifier_type) where status = 'active';

comment on table public.variant_identifiers is
  'Cada código que identifica una variante, con su tipo y su procedencia. '
  'Existe porque product_variants.sku llevaba cinco significados a la vez y la '
  'historia del proyecto contiene dos decisiones opuestas sobre qué debía ser.';
comment on column public.variant_identifiers.identifier_type is
  'Qué clase de código es. BELLAROSHE_SKU es el nuestro y no se sustituye por '
  'el del fabricante: son datos distintos, no versiones del mismo.';
comment on column public.variant_identifiers.issuer is
  'Quién emitió el código. Sin emisor, dos numeraciones que coinciden por '
  'casualidad parecen el mismo producto — así se confundió CHE017.';

alter table public.variant_identifiers enable row level security;
create policy "admins manage variant identifiers" on public.variant_identifiers
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.variant_identifiers to authenticated, service_role;

-- ── Poblado desde lo que ya sabemos ─────────────────────────────────────────
-- No inventa nada: mueve a su sitio lo que ya está en columnas del catálogo.

-- El correlativo Bellaroshé. Si la variante ya migró a SKU de fabricante, el
-- correlativo vive en sku_interno; si no, es el propio sku.
insert into public.variant_identifiers (variant_id, identifier_type, value, issuer, metadata)
select v.id, 'BELLAROSHE_SKU', coalesce(v.sku_interno, v.sku), 'Bellaroshé',
       jsonb_build_object('origen', 'columna product_variants')
from public.product_variants v
where coalesce(v.sku_interno, v.sku) is not null
on conflict (variant_id, identifier_type, value) do nothing;

-- El del fabricante, solo donde está confirmado contra la ficha oficial.
insert into public.variant_identifiers (variant_id, identifier_type, value, issuer, metadata)
select v.id, 'MANUFACTURER_SKU', v.sku, b.name,
       jsonb_build_object('origen', 'columna product_variants', 'skuOrigen', v.sku_origen)
from public.product_variants v
join public.products p on p.id = v.product_id
join public.brands b on b.id = p.brand_id
where v.sku_origen = 'OFICIAL_MARCA' and v.sku is not null
on conflict (variant_id, identifier_type, value) do nothing;

-- El del proveedor. Entran como NO primarios y después se promueve uno.
--
-- Un código de proveedor enlazado al producto se reparte entre todas sus
-- variantes, así que una sola variante puede recibir varios. Insertarlos todos
-- como primarios choca contra el índice —que es justo lo que debe hacer— y el
-- arreglo no puede venir después: el índice actúa durante la inserción, no al
-- final de la migración.
insert into public.variant_identifiers (variant_id, identifier_type, value, issuer, is_primary, metadata)
select distinct on (v.id, ps.supplier_sku)
       v.id, 'SUPPLIER_SKU', ps.supplier_sku, s.trade_name, false,
       jsonb_build_object('origen', 'product_suppliers')
from public.product_suppliers ps
join public.suppliers s on s.id = ps.supplier_id
join public.product_variants v
  on (ps.variant_id = v.id or (ps.variant_id is null and ps.product_id = v.product_id))
where ps.supplier_sku is not null and trim(ps.supplier_sku) <> ''
on conflict (variant_id, identifier_type, value) do nothing;

-- Cuál manda: el enlazado a la variante concreta si lo hay, y si no el primero
-- por orden estable. Elegir por azar haría que dos corridas dieran respuestas
-- distintas a la misma pregunta.
update public.variant_identifiers vi
set is_primary = true
where vi.identifier_type = 'SUPPLIER_SKU'
  and vi.id = (
    select id from public.variant_identifiers otro
    where otro.variant_id = vi.variant_id
      and otro.identifier_type = 'SUPPLIER_SKU'
      and otro.status = 'active'
    order by otro.value
    limit 1
  );

commit;
