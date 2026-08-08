begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- El circuito que prueba esto es el segundo del negocio: se vendió, bajó el
-- stock, se está agotando, hay que reponer. Se montan tres variantes que
-- responden a las tres situaciones posibles:
--
--   · una agotada,
--   · una que vende rápido y le quedan pocos días de cobertura,
--   · y una con stock que NO se ha vendido nunca, donde la cobertura no es
--     calculable y hay que decirlo en vez de inventar un umbral.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f9000000-0000-4000-8000-000000000001','authenticated','authenticated','inv-board-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','');

insert into public.admin_profiles(id, role, full_name) values
  ('f9000000-0000-4000-8000-000000000001','admin','Propietaria del inventario');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'INVBOARD', 'Sede del inventario', 'Lima', false, 949
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.branches where code = 'INVBOARD') as branch_id,
  (select id from public.brands where is_active order by created_at limit 1) as brand_id,
  (select id from public.categories where is_active order by created_at limit 1) as category_id,
  (select id from public.attribute_templates order by created_at limit 1) as template_id,
  (select ao.id from public.attribute_options ao
     join public.attribute_definitions ad on ad.id = ao.attribute_definition_id
    where ad.code = 'color_family' and ao.is_active
    order by ao.sort_order limit 1) as family_id;

grant select on fx to authenticated;

insert into public.staff_branches (staff_id, branch_id)
select 'f9000000-0000-4000-8000-000000000001', fx.branch_id from fx;

insert into public.products (code, slug, brand_id, category_id, template_id, name, presentation,
                             product_type, unit_price, wholesale_price, wholesale_min_quantity,
                             availability, is_active)
select 'INV-ESM', 'inv-esmalte-board', fx.brand_id, fx.category_id, fx.template_id,
       'Esmalte Board', '13.5 ml', 'Esmalte tradicional', 12.00, 9.00, 3, 'available', true
from fx;

insert into public.color_shades (brand_id, name, code, color_family_option_id, is_active)
select fx.brand_id, 'Carmesí Board', 'BRD-001', fx.family_id, true from fx
union all
select fx.brand_id, 'Nude Board', 'BRD-002', fx.family_id, true from fx
union all
select fx.brand_id, 'Perla Board', 'BRD-003', fx.family_id, true from fx;

insert into public.product_variants (product_id, sku, name, variant_key, color_shade_id,
                                     availability_status, is_active, tracks_inventory, sort_order)
select p.id, 'INV-AGOTADO', 'Carmesí Board', 'carmesi-board',
       (select id from public.color_shades where code = 'BRD-001'),
       'available'::public.product_availability, true, true, 1
from public.products p where p.code = 'INV-ESM'
union all
select p.id, 'INV-RAPIDO', 'Nude Board', 'nude-board',
       (select id from public.color_shades where code = 'BRD-002'),
       'available'::public.product_availability, true, true, 2
from public.products p where p.code = 'INV-ESM'
union all
select p.id, 'INV-QUIETO', 'Perla Board', 'perla-board',
       (select id from public.color_shades where code = 'BRD-003'),
       'available'::public.product_availability, true, true, 3
from public.products p where p.code = 'INV-ESM';

-- Existencias: agotada, poca con rotación, y sana sin rotación.
insert into public.inventory_stock (variant_id, branch_id, on_hand, reserved)
select v.id, fx.branch_id, 0, 0 from public.product_variants v, fx where v.sku = 'INV-AGOTADO'
union all
select v.id, fx.branch_id, 8, 2 from public.product_variants v, fx where v.sku = 'INV-RAPIDO'
union all
select v.id, fx.branch_id, 40, 0 from public.product_variants v, fx where v.sku = 'INV-QUIETO';

-- Las existencias del sistema real no aparecen solas: llegan por un movimiento
-- que deja su saldo posterior. El fixture lo reproduce para que la cantidad sea
-- explicable, que es justo lo que se exige del inventario.
insert into public.inventory_movements (variant_id, branch_id, movement_type, quantity,
                                        balance_after, value_delta, value_after,
                                        valued_units, unvalued_units, occurred_at, reason)
select v.id, fx.branch_id, 'receipt', 8, 8, 96, 96, 8, 0,
       (current_date - 20)::timestamptz, 'Recepción inicial de la prueba'
from public.product_variants v, fx where v.sku = 'INV-RAPIDO';

-- Treinta unidades vendidas en treinta días de la variante rápida: un día de
-- ritmo por unidad. Con 6 disponibles, la cobertura es de 6 días.
insert into public.sales (branch_id, sale_number, status, source_channel, fulfillment_method,
                          gross_subtotal, discount_total, total, currency, issued_at,
                          client_operation_id)
select fx.branch_id, 'NV-INVBRD', 'confirmed', 'in_store', 'in_store', 360, 0, 360, 'PEN',
       (current_date - 5)::timestamptz, gen_random_uuid()
from fx;

insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name, brand_name,
                               quantity, unit_price, discount_amount, subtotal, purchase_mode, line_order)
select s.id, v.id, v.sku, 'Esmalte Board', 'Nude Board', 'Board', 30, 12.00, 0, 360, 'retail', 1
from public.sales s, public.product_variants v
where s.sale_number = 'NV-INVBRD' and v.sku = 'INV-RAPIDO';

set local role authenticated;
set local request.jwt.claims to '{"sub":"f9000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- ---------------------------------------------------------------------------
-- D1 · las cifras salen de la fuente de inventario, y se localiza la variante
-- ---------------------------------------------------------------------------
create temporary view tablero as
select x from jsonb_array_elements(
  public.inventory_board((select branch_id from fx), null, current_date - 29, current_date, false, 200) -> 'items'
) x;
grant select on tablero to authenticated;

select is(
  (select (x->>'available')::int from tablero where x->>'sku' = 'INV-RAPIDO'),
  6,
  'lo disponible es lo de inventory_position: 8 en mano menos 2 reservadas'
);

select is(
  (select (x->>'reserved')::int from tablero where x->>'sku' = 'INV-RAPIDO'),
  2,
  'y lo reservado viaja aparte, sin mezclarse con lo disponible'
);

-- Localizar por nombre, SKU, marca y tono: los cuatro caminos que usa la dueña.
select is(
  (select (public.inventory_board((select branch_id from fx), 'Esmalte Board') ->> 'total')::int),
  3, 'se localiza por nombre de producto'
);
select is(
  (select (public.inventory_board((select branch_id from fx), 'INV-QUIETO') ->> 'total')::int),
  1, 'se localiza por SKU'
);
select is(
  (select (public.inventory_board((select branch_id from fx), 'Nude Board') ->> 'total')::int),
  1, 'se localiza por nombre de tono'
);
select is(
  (select (public.inventory_board((select branch_id from fx), 'BRD-003') ->> 'total')::int),
  1, 'se localiza por código de tono'
);

-- Toda cantidad relevante es explicable por sus movimientos.
select isnt_empty(
  $$select 1 from public.inventory_movements m
     join public.product_variants v on v.id = m.variant_id
    where v.sku = 'INV-RAPIDO' and m.balance_after is not null$$,
  'la cantidad es explicable: sus movimientos dejan saldo posterior'
);

-- ---------------------------------------------------------------------------
-- D2 · qué hay que reponer, y por qué
-- ---------------------------------------------------------------------------
select is(
  (select x->>'reason' from tablero where x->>'sku' = 'INV-AGOTADO'),
  'agotado',
  'sin unidades disponibles, el motivo es agotado'
);

select is(
  (select (x->>'coverageDays')::numeric from tablero where x->>'sku' = 'INV-RAPIDO'),
  6.0,
  '30 unidades en 30 días con 6 disponibles dan 6 días de cobertura'
);

select is(
  (select x->>'reason' from tablero where x->>'sku' = 'INV-RAPIDO'),
  'cobertura',
  'y menos de siete días de cobertura pide reposición, con su razón'
);

-- Lo que no se ha vendido nunca no se puede estimar: se dice, no se inventa.
select is(
  (select x->>'coverageDays' from tablero where x->>'sku' = 'INV-QUIETO'),
  null,
  'sin salidas en el periodo la cobertura queda en nulo, no en un umbral inventado'
);

select is(
  (select (public.inventory_board((select branch_id from fx), null, current_date - 29, current_date, true, 200) ->> 'total')::int),
  2,
  'el filtro de reposición deja solo lo agotado y lo de cobertura corta'
);

select * from finish();

rollback;
