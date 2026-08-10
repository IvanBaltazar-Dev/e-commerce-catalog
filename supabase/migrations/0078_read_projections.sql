-- ---------------------------------------------------------------------------
-- 0078 · Las proyecciones de lectura salen de las tablas de negocio
-- ---------------------------------------------------------------------------
-- LA EVIDENCIA. Rellenar el documento de búsqueda de 200 000 variantes tardaba
-- más de 17 minutos. Con los disparadores apagados, 1 minuto 54. La diferencia
-- no es el cálculo del documento: es que `search_document` es una columna de
-- `product_variants`, así que escribirla es un UPDATE normal sobre esa tabla y
-- arrastra sus TRECE disparadores — validación de publicación fila a fila,
-- auditoría comercial, exigir variante predeterminada, tocar los metadatos del
-- catálogo, recalcular el precio inicial, recalcular facetas.
--
-- Renombrar una marca reescribe el documento de todas sus variantes. Con la
-- columna dentro, eso significaba también auditar 5 000 filas, validar 5 000
-- publicaciones y recalcular 5 000 precios que nadie cambió.
--
-- LA REGLA QUE ESTABLECE ESTA MIGRACIÓN:
--
--   Una proyección puede depender de las tablas de negocio.
--   Las tablas de negocio NUNCA dependen de una proyección.
--   Y escribir en una proyección no dispara auditoría, ni validación de
--   publicación, ni kardex, ni recálculo de precios, ni ninguna otra regla
--   transaccional.
--
-- POR QUÉ SEPARADAS Y NO UNA CACHÉ GRANDE. El defecto apareció justamente
-- porque conceptos distintos reaccionaban al MISMO update. Cada proyección
-- tiene su propio disparador y su propio evento:
--
--   variant_search_projection   ← nombre, marca, línea, tono, atributos
--                                 buscables, SKU, código de barras
--   variant_search_codes        ← solo los identificadores
--   product_catalog_projection  ← documento agregado del producto (búsqueda
--                                 pública) y precio inicial, cada uno con su
--                                 disparador
--   catalog_facet_presence      ← publicación, clasificación y atributos (0076)
--   inventory_stock             ← la posición. NO se duplica aquí.
--
-- LA DISPONIBILIDAD NO SE PROYECTA. Ya tiene su sitio y el POS la lee de ahí
-- con la clave (variant_id, branch_id). Duplicarla sería repetir el error que
-- esta migración corrige, una capa más arriba.
--
-- MIGRACIÓN NO DESTRUCTIVA. Las columnas y disparadores viejos siguen ahí.
-- Se retiran en una migración aparte, y solo cuando no queden consumidores.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. De qué se compone el texto buscable, definido UNA vez
-- ---------------------------------------------------------------------------
-- Separado en dos partes a propósito. Lo del PRODUCTO (nombre, marca, línea)
-- es igual para sus 164 tonos; repetirlo 164 veces en el documento agregado
-- del producto lo haría enorme sin añadir nada.
create or replace view public.variant_search_parts
with (security_invoker = true) as
select
  variant.id        as variant_id,
  variant.product_id,
  public.search_normalize(
    coalesce(product.code, '') || ' ' ||
    coalesce(product.name, '') || ' ' ||
    coalesce(product.presentation, '') || ' ' ||
    coalesce(product.product_type, '') || ' ' ||
    coalesce(brand.name, '') || ' ' ||
    coalesce(line.name, '')
  ) as texto_producto,
  public.search_normalize(
    coalesce(variant.name, '') || ' ' ||
    coalesce(variant.sku, '') || ' ' ||
    coalesce(variant.barcode, '') || ' ' ||
    coalesce(shade.name, '') || ' ' ||
    coalesce(shade.code, '') || ' ' ||
    coalesce(atributos.texto, '')
  ) as texto_variante
from public.product_variants variant
join public.products product on product.id = variant.product_id
left join public.brands brand on brand.id = product.brand_id
left join public.color_shades shade on shade.id = variant.color_shade_id
left join public.product_lines line on line.id = shade.product_line_id
left join (
  select
    value.variant_id,
    string_agg(
      coalesce(option.value, '') || ' ' ||
      coalesce(option.label, '') || ' ' ||
      coalesce(value.value_text, ''), ' ') as texto
  from public.variant_attribute_values value
  join public.attribute_definitions definition
    on definition.id = value.attribute_definition_id
   and definition.is_active
   and definition.is_searchable
  left join public.attribute_options option on option.id = value.option_id
  group by value.variant_id
) atributos on atributos.variant_id = variant.id;

revoke all on public.variant_search_parts from public, anon, authenticated;

-- Los identificadores, como FILAS. Un tipo nuevo de código mañana es otro
-- `code_type`, no otra rama OR en cinco consultas.
create or replace view public.variant_code_source
with (security_invoker = true) as
select variant.id as variant_id, 'sku'::text as code_type,
       public.search_normalize(variant.sku) as normalized_code
from public.product_variants variant
where variant.sku is not null and public.search_normalize(variant.sku) is not null
union all
select variant.id, 'barcode',
       public.search_normalize(variant.barcode)
from public.product_variants variant
where variant.barcode is not null and public.search_normalize(variant.barcode) is not null
union all
select variant.id, 'internal_code',
       public.search_normalize(product.code)
from public.product_variants variant
join public.products product on product.id = variant.product_id
where public.search_normalize(product.code) is not null
union all
select variant.id, 'shade_code',
       public.search_normalize(shade.code)
from public.product_variants variant
join public.color_shades shade on shade.id = variant.color_shade_id
where shade.code is not null and public.search_normalize(shade.code) is not null
union all
select variant.id, 'supplier_code',
       public.search_normalize(supplier.supplier_sku)
from public.product_variants variant
join public.product_suppliers supplier
  on supplier.variant_id = variant.id
  or (supplier.variant_id is null and supplier.product_id = variant.product_id)
where supplier.supplier_sku is not null
  and public.search_normalize(supplier.supplier_sku) is not null;

revoke all on public.variant_code_source from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Las proyecciones
-- ---------------------------------------------------------------------------
create table if not exists public.variant_search_projection (
  variant_id uuid primary key references public.product_variants(id) on delete cascade,
  product_id uuid not null references public.products(id) on delete cascade,
  search_document text not null,
  updated_at timestamptz not null default now()
);

comment on table public.variant_search_projection is
  'Documento buscable por variante. Proyección de lectura: se reconstruye cuando cambia algo buscable y su escritura no dispara ninguna regla de negocio. La verdad sigue en products, product_variants, brands, product_lines, color_shades y variant_attribute_values.';

create index if not exists variant_search_projection_trgm_idx
  on public.variant_search_projection using gin (search_document public.gin_trgm_ops);

create index if not exists variant_search_projection_product_idx
  on public.variant_search_projection (product_id);

create table if not exists public.variant_search_codes (
  variant_id uuid not null references public.product_variants(id) on delete cascade,
  code_type text not null,
  normalized_code text not null,
  primary key (variant_id, code_type, normalized_code)
);

comment on table public.variant_search_codes is
  'Los identificadores de una variante como filas: sku, internal_code, barcode, shade_code, supplier_code. Existe para que buscar por uno o dos caracteres sea UN recorrido de rango sobre una columna indexada, en vez de cinco comparaciones con OR sobre cuatro tablas — que es el patrón que 0072 vino a eliminar y que 0077 reintrodujo sin querer.';

-- NO parcial, a propósito. El índice parcial de SKU que traía 0077 exigía
-- `sku is not null` en la consulta para poder usarse, y la consulta no lo
-- decía: el planificador lo ignoraba y recorría la tabla. Un índice que
-- depende de que quien consulta recuerde una condición es un índice que no se
-- usa.
create index if not exists variant_search_codes_prefix_idx
  on public.variant_search_codes (normalized_code text_pattern_ops);

create index if not exists variant_search_codes_variant_idx
  on public.variant_search_codes (variant_id);

create table if not exists public.product_catalog_projection (
  product_id uuid primary key references public.products(id) on delete cascade,
  search_document text not null,
  starting_price numeric(12,2),
  updated_at timestamptz not null default now()
);

comment on table public.product_catalog_projection is
  'Lo que el catálogo público necesita de un producto para buscarlo y ordenarlo: el documento agregado de sus variantes y el precio minorista vigente más bajo. Las dos columnas tienen disparadores DISTINTOS: cambiar un precio no reconstruye el documento, y renombrar una marca no recalcula el precio.';

create index if not exists product_catalog_projection_trgm_idx
  on public.product_catalog_projection using gin (search_document public.gin_trgm_ops);

create index if not exists product_catalog_projection_price_idx
  on public.product_catalog_projection (starting_price nulls last);

-- Ninguna es superficie: las leen los contratos, que son SECURITY DEFINER.
alter table public.variant_search_projection enable row level security;
alter table public.variant_search_codes enable row level security;
alter table public.product_catalog_projection enable row level security;

revoke all on public.variant_search_projection from public, anon, authenticated;
revoke all on public.variant_search_codes from public, anon, authenticated;
revoke all on public.product_catalog_projection from public, anon, authenticated;

grant select, insert, update, delete on public.variant_search_projection to service_role;
grant select, insert, update, delete on public.variant_search_codes to service_role;
grant select, insert, update, delete on public.product_catalog_projection to service_role;

-- `inventory_board` es SECURITY INVOKER por diseño —se apoya en la RLS y en los
-- privilegios de quien pregunta, no los suplanta— así que necesita permiso
-- explícito para leer el documento. Se le da a `authenticated` y NUNCA a
-- `anon`: el tablero de existencias es del mostrador, no del público. El
-- documento no contiene nada que no esté ya en la ficha.
drop policy if exists "variant search projection readable by staff" on public.variant_search_projection;
create policy "variant search projection readable by staff"
on public.variant_search_projection
for select
to authenticated
using (true);

grant select on public.variant_search_projection to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- 3. Reconstrucción: una función por responsabilidad
-- ---------------------------------------------------------------------------
-- Que sean funciones distintas no es orden cosmético: es lo que permite que un
-- cambio de precio no toque el documento de búsqueda, y que renombrar una marca
-- no recalcule precios. Cuando las dos cosas colgaban del mismo UPDATE pasaba
-- justo lo contrario, y eso es lo que costaba quince minutos.

begin;

create or replace function public.refresh_variant_search_projection(p_variant_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_variant_ids is null or array_length(p_variant_ids, 1) is null then return 0; end if;

  insert into public.variant_search_projection (variant_id, product_id, search_document, updated_at)
  select partes.variant_id, partes.product_id,
         btrim(coalesce(partes.texto_producto, '') || ' ' || coalesce(partes.texto_variante, '')),
         now()
  from public.variant_search_parts partes
  join unnest(p_variant_ids) as pedido(id) on pedido.id = partes.variant_id
  on conflict (variant_id) do update
  set product_id = excluded.product_id,
      search_document = excluded.search_document,
      updated_at = now()
  where public.variant_search_projection.search_document is distinct from excluded.search_document;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.rebuild_variant_search_projection()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  truncate public.variant_search_projection;
  insert into public.variant_search_projection (variant_id, product_id, search_document)
  select partes.variant_id, partes.product_id,
         btrim(coalesce(partes.texto_producto, '') || ' ' || coalesce(partes.texto_variante, ''))
  from public.variant_search_parts partes;
  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.refresh_variant_search_codes(p_variant_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_variant_ids is null or array_length(p_variant_ids, 1) is null then return 0; end if;

  delete from public.variant_search_codes codigos
  where codigos.variant_id = any(p_variant_ids);

  insert into public.variant_search_codes (variant_id, code_type, normalized_code)
  select distinct fuente.variant_id, fuente.code_type, fuente.normalized_code
  from public.variant_code_source fuente
  join unnest(p_variant_ids) as pedido(id) on pedido.id = fuente.variant_id
  on conflict do nothing;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.rebuild_variant_search_codes()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  truncate public.variant_search_codes;
  insert into public.variant_search_codes (variant_id, code_type, normalized_code)
  select distinct variant_id, code_type, normalized_code from public.variant_code_source;
  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

-- El documento del PRODUCTO: su texto una vez, y el de sus variantes activas
-- agregado. Es lo que permite al catálogo buscar contra 100 000 filas indexadas
-- en vez de preguntar, producto por producto, si alguna de sus variantes
-- coincide.
create or replace function public.refresh_product_catalog_search(p_product_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_product_ids is null or array_length(p_product_ids, 1) is null then return 0; end if;

  insert into public.product_catalog_projection (product_id, search_document, updated_at)
  select agregado.product_id, agregado.documento, now()
  from (
    select partes.product_id,
           btrim(coalesce(max(partes.texto_producto), '') || ' ' ||
                 coalesce(string_agg(distinct partes.texto_variante, ' '), '')) as documento
    from public.variant_search_parts partes
    join public.product_variants variante
      on variante.id = partes.variant_id and variante.is_active
    join unnest(p_product_ids) as pedido(id) on pedido.id = partes.product_id
    group by partes.product_id
  ) agregado
  on conflict (product_id) do update
  set search_document = excluded.search_document,
      updated_at = now()
  where public.product_catalog_projection.search_document is distinct from excluded.search_document;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.rebuild_product_catalog_search()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  insert into public.product_catalog_projection (product_id, search_document)
  select partes.product_id,
         btrim(coalesce(max(partes.texto_producto), '') || ' ' ||
               coalesce(string_agg(distinct partes.texto_variante, ' '), ''))
  from public.variant_search_parts partes
  join public.product_variants variante on variante.id = partes.variant_id and variante.is_active
  group by partes.product_id
  on conflict (product_id) do update
  set search_document = excluded.search_document, updated_at = now();
  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

-- El precio, con su PROPIA función y su propio disparador. Cambiar un precio no
-- puede reconstruir documentos de búsqueda, ni al revés.
create or replace function public.refresh_product_catalog_price(p_product_ids uuid[])
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  if p_product_ids is null or array_length(p_product_ids, 1) is null then return 0; end if;

  insert into public.product_catalog_projection (product_id, search_document, starting_price, updated_at)
  select pedido.id, '', calculado.precio, now()
  from unnest(p_product_ids) as pedido(id)
  cross join lateral (
    select min(price.amount) as precio
    from public.product_variants variante
    join public.variant_prices price on price.variant_id = variante.id
    join public.price_lists lista on lista.id = price.price_list_id
    where variante.product_id = pedido.id
      and variante.is_active and price.is_active and price.validity @> now()
      and lista.is_active and lista.is_public and lista.price_type = 'retail'
  ) calculado
  on conflict (product_id) do update
  set starting_price = excluded.starting_price, updated_at = now()
  where public.product_catalog_projection.starting_price is distinct from excluded.starting_price;

  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

create or replace function public.rebuild_product_catalog_price()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare v_total integer;
begin
  update public.product_catalog_projection destino
  set starting_price = calculado.precio, updated_at = now()
  from (
    select p.id as product_id, min(price.amount) as precio
    from public.products p
    join public.product_variants variante on variante.product_id = p.id and variante.is_active
    join public.variant_prices price on price.variant_id = variante.id and price.is_active
    join public.price_lists lista on lista.id = price.price_list_id
    where price.validity @> now() and lista.is_active and lista.is_public and lista.price_type = 'retail'
    group by p.id
  ) calculado
  where destino.product_id = calculado.product_id
    and destino.starting_price is distinct from calculado.precio;
  get diagnostics v_total = row_count;
  return v_total;
end;
$fn$;

revoke execute on function public.refresh_variant_search_projection(uuid[]) from public;
revoke execute on function public.rebuild_variant_search_projection() from public;
revoke execute on function public.refresh_variant_search_codes(uuid[]) from public;
revoke execute on function public.rebuild_variant_search_codes() from public;
revoke execute on function public.refresh_product_catalog_search(uuid[]) from public;
revoke execute on function public.rebuild_product_catalog_search() from public;
revoke execute on function public.refresh_product_catalog_price(uuid[]) from public;
revoke execute on function public.rebuild_product_catalog_price() from public;

grant execute on function public.rebuild_variant_search_projection() to service_role;
grant execute on function public.rebuild_variant_search_codes() to service_role;
grant execute on function public.rebuild_product_catalog_search() to service_role;
grant execute on function public.rebuild_product_catalog_price() to service_role;

commit;
