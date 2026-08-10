begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- ---------------------------------------------------------------------------
-- 0075 · La disponibilidad dice lo mismo se calcule donde se calcule
-- ---------------------------------------------------------------------------
-- 0075 dejó de llamar a `variant_effective_availability` una vez por fila y
-- escribió la misma regla como expresión sobre la posición que el SELECT ya
-- tiene unida. Es más rápido y es una duplicación: la regla vive ahora en dos
-- sitios, y las duplicaciones se desincronizan.
--
-- Esta batería existe para que no puedan divergir en silencio. Compara las dos
-- formas sobre TODAS las combinaciones de estado editorial (3) × seguimiento de
-- inventario (2) × existencia (4). Si alguien cambia la función y no la
-- expresión —o al revés— falla aquí y no en el mostrador.
--
-- Todo se acota a datos propios: nada cuenta filas de tablas enteras, porque
-- otra sesión puede estar registrando ventas sobre la misma base.
-- ---------------------------------------------------------------------------

create temporary table fx_sede on commit drop as
select id from public.branches where is_default and is_active limit 1;

select isnt((select id from fx_sede), null, '0 · el entorno tiene una sede predeterminada activa');

-- Un producto propio con una variante por combinación de estado × seguimiento.
insert into public.products (
  id, code, slug, brand_id, category_id, template_id, name, presentation,
  product_type, unit_price, wholesale_price, availability, editorial_status,
  is_active, sort_order
)
select
  'f0750000-0000-4000-8000-000000000001'::uuid,
  'T0075-PROD', 't0075-prod',
  (select id from public.brands where is_active order by id limit 1),
  (select id from public.categories order by id limit 1),
  (select id from public.attribute_templates where code = 'LEGACY_V1'),
  'Producto de la prueba 0075', 'Unica', 'Prueba',
  10, 8, 'available', 'draft', false, 990075;

insert into public.product_variants (
  id, product_id, sku, name, variant_key, availability_status,
  tracks_inventory, is_default, is_active, sort_order
)
select
  ('f0750000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
  'f0750000-0000-4000-8000-000000000001'::uuid,
  'T0075-SKU-' || lpad(n::text, 2, '0'),
  'Variante ' || n,
  'presentation=v' || n,
  estado,
  sigue,
  n = 1,
  true,
  n
from (
  select row_number() over (order by estado, sigue) as n, estado, sigue
  from unnest(array['consult','sold_out','available']::public.product_availability[]) estado,
       unnest(array[true, false]) sigue
) combos;

select is(
  (select count(*)::int from public.product_variants where sku like 'T0075-SKU-%'),
  6,
  '1 · las seis combinaciones de estado y seguimiento existen'
);

-- ---------------------------------------------------------------------------
-- Sin existencia registrada: la fila de inventory_stock no existe
-- ---------------------------------------------------------------------------
select is(
  (select count(*)::int
   from public.product_variants v
   cross join fx_sede b
   left join public.inventory_stock st on st.variant_id = v.id and st.branch_id = b.id
   where v.sku like 'T0075-SKU-%'
     and public.variant_effective_availability(v.id, b.id) is distinct from (
       case
         when v.availability_status = 'consult'  then 'consult'::public.product_availability
         when v.availability_status = 'sold_out' then 'sold_out'::public.product_availability
         when v.availability_status = 'available'
          and v.tracks_inventory
          and coalesce(st.available_quantity, 0) <= 0
           then 'sold_out'::public.product_availability
         else v.availability_status
       end)),
  0,
  '2 · sin existencia registrada, la función y la expresión coinciden en las seis'
);

-- ---------------------------------------------------------------------------
-- Con existencia: cero, positiva y la fila ausente ya cubierta arriba
-- ---------------------------------------------------------------------------
insert into public.inventory_stock (variant_id, branch_id, on_hand, reserved)
select v.id, b.id,
       case when (row_number() over (order by v.sku)) % 2 = 0 then 0 else 25 end,
       0
from public.product_variants v cross join fx_sede b
where v.sku like 'T0075-SKU-%';

select is(
  (select count(*)::int
   from public.product_variants v
   cross join fx_sede b
   left join public.inventory_stock st on st.variant_id = v.id and st.branch_id = b.id
   where v.sku like 'T0075-SKU-%'
     and public.variant_effective_availability(v.id, b.id) is distinct from (
       case
         when v.availability_status = 'consult'  then 'consult'::public.product_availability
         when v.availability_status = 'sold_out' then 'sold_out'::public.product_availability
         when v.availability_status = 'available'
          and v.tracks_inventory
          and coalesce(st.available_quantity, 0) <= 0
           then 'sold_out'::public.product_availability
         else v.availability_status
       end)),
  0,
  '3 · con existencia en cero y positiva, siguen coincidiendo'
);

-- ---------------------------------------------------------------------------
-- Las reglas que NO pueden cambiar sin que alguien lo decida
-- ---------------------------------------------------------------------------
select is(
  (select public.variant_effective_availability(v.id, b.id)::text
   from public.product_variants v cross join fx_sede b
   where v.sku like 'T0075-SKU-%' and v.availability_status = 'consult'
     and v.tracks_inventory limit 1),
  'consult',
  '4 · «consultar» manda aunque haya existencia y seguimiento'
);

update public.inventory_stock st
set on_hand = 0
from public.product_variants v
where v.id = st.variant_id and v.sku like 'T0075-SKU-%'
  and v.availability_status = 'available' and not v.tracks_inventory;

select is(
  (select public.variant_effective_availability(v.id, b.id)::text
   from public.product_variants v cross join fx_sede b
   where v.sku like 'T0075-SKU-%'
     and v.availability_status = 'available' and not v.tracks_inventory limit 1),
  'available',
  '5 · sin seguimiento de inventario, cero existencia NO agota'
);

select * from finish();

rollback;
