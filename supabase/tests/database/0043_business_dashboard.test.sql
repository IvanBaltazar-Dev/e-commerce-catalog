begin;

create extension if not exists pgtap with schema extensions;

select plan(32);

-- ---------------------------------------------------------------------------
-- Fixture: una sede propia con dos productos, cuatro ventas (dos limpias, una
-- anulada, una con costo desconocido en OTRA ventana), gastos, devolución,
-- reserva, deuda de proveedor en moneda exótica y dos recepciones del mismo
-- tono a precios distintos. Todos los importes están elegidos a mano para que
-- cada indicador tenga UNA respuesta correcta.
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f8000000-0000-4000-8000-000000000001','authenticated','authenticated','dash-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','','' ),
  ('00000000-0000-0000-0000-000000000000','f8000000-0000-4000-8000-000000000002','authenticated','authenticated','dash-seller@example.invalid','',now(),'{}','{}',now(),now(),'','','','' );

insert into public.admin_profiles(id, role, full_name) values
  ('f8000000-0000-4000-8000-000000000001','admin','Admin del tablero'),
  ('f8000000-0000-4000-8000-000000000002','seller','Vendedora Dash');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'DASHTEST', 'Sede del tablero', 'Lima', false, 905 from public.companies c limit 1;
insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'DASHEMPTY', 'Sede vacía del tablero', 'Lima', false, 906 from public.companies c limit 1;

-- Catálogo mínimo: marca, categorías, tono de biblioteca y dos productos.
insert into public.brands (name, slug) values ('Marca Dash', 'marca-dash');
insert into public.categories (name, slug) values
  ('Esmaltes Dash', 'dash-esmaltes'), ('Kits Dash', 'dash-kits');

insert into public.attribute_templates (code, name)
values ('TEST_DASH', 'Plantilla del tablero (prueba)');

insert into public.attribute_definitions (code, name, data_type, scope)
values ('dash_familia_color', 'Familia de color (prueba)', 'single_option', 'variant');
insert into public.attribute_options (attribute_definition_id, value, label)
select id, 'rojos', 'Rojos' from public.attribute_definitions where code = 'dash_familia_color';

insert into public.color_shades (brand_id, name, code, color_family_option_id)
select b.id, 'Rojo Pasión', 'DASH-01', o.id
from public.brands b, public.attribute_options o
join public.attribute_definitions d on d.id = o.attribute_definition_id
where b.slug = 'marca-dash' and d.code = 'dash_familia_color';

insert into public.products (code, slug, brand_id, category_id, name, presentation, product_type, unit_price, wholesale_price, template_id)
select 'DASH-P1', 'dash-p1', b.id, c.id, 'Esmalte Dash Uno', 'Frasco 15 ml', 'esmalte', 50, 45, t.id
from public.brands b, public.categories c, public.attribute_templates t
where b.slug = 'marca-dash' and c.slug = 'dash-esmaltes' and t.code = 'TEST_DASH';
insert into public.products (code, slug, brand_id, category_id, name, presentation, product_type, unit_price, wholesale_price, template_id)
select 'DASH-P2', 'dash-p2', b.id, c.id, 'Kit Dash Dos', 'Caja x1', 'kit', 80, 75, t.id
from public.brands b, public.categories c, public.attribute_templates t
where b.slug = 'marca-dash' and c.slug = 'dash-kits' and t.code = 'TEST_DASH';

-- La variante del esmalte se llama distinto que su tono: si el ranking de
-- tonos dice «Rojo Pasión», probó el join con la biblioteca, no el nombre.
insert into public.product_variants (product_id, sku, name, variant_key, color_shade_id, is_default)
select p.id, 'DASH-P1-V1', 'Tono 01', 'tono-01', cs.id, true
from public.products p, public.color_shades cs
where p.code = 'DASH-P1' and cs.code = 'DASH-01';
insert into public.product_variants (product_id, sku, name, variant_key, is_default)
select p.id, 'DASH-P2-V1', 'Único', 'unico', true from public.products p where p.code = 'DASH-P2';

create temporary table fx on commit drop as
select
  'f8000000-0000-4000-8000-000000000001'::uuid as admin_id,
  'f8000000-0000-4000-8000-000000000002'::uuid as seller_id,
  (select id from public.branches where code = 'DASHTEST') as branch,
  (select id from public.branches where code = 'DASHEMPTY') as empty_branch,
  (select id from public.product_variants where sku = 'DASH-P1-V1') as v1,
  (select id from public.product_variants where sku = 'DASH-P2-V1') as v2,
  (select id from public.products where code = 'DASH-P1') as p1,
  (select id from public.products where code = 'DASH-P2') as p2;

-- Ventas. S1 y S2 caen en la ventana principal; S3 está anulada; S4 vive en
-- otra ventana y su costo es DESCONOCIDO.
insert into public.sales (id, branch_id, sale_number, status, source_channel, gross_subtotal, discount_total, total, seller_id, seller_label, client_operation_id, issued_at)
select 'f8000000-0000-4000-8000-00000000a001', branch, 'DASH-0001', 'confirmed', 'in_store', 100, 0, 100, seller_id, 'Vendedora Dash', gen_random_uuid(), (current_date - 1) + interval '10 hours' from fx;
insert into public.sales (id, branch_id, sale_number, status, source_channel, gross_subtotal, discount_total, total, seller_id, seller_label, client_operation_id, issued_at)
select 'f8000000-0000-4000-8000-00000000a002', branch, 'DASH-0002', 'confirmed', 'whatsapp', 80, 0, 80, seller_id, 'Vendedora Dash', gen_random_uuid(), (current_date - 1) + interval '11 hours' from fx;
insert into public.sales (id, branch_id, sale_number, status, source_channel, gross_subtotal, discount_total, total, seller_id, seller_label, client_operation_id, issued_at)
select 'f8000000-0000-4000-8000-00000000a003', branch, 'DASH-0003', 'cancelled', 'in_store', 30, 0, 30, seller_id, 'Vendedora Dash', gen_random_uuid(), (current_date - 1) + interval '12 hours' from fx;
insert into public.sales (id, branch_id, sale_number, status, source_channel, gross_subtotal, discount_total, total, seller_id, seller_label, client_operation_id, issued_at)
select 'f8000000-0000-4000-8000-00000000a004', branch, 'DASH-0004', 'confirmed', 'in_store', 60, 0, 60, seller_id, 'Vendedora Dash', gen_random_uuid(), (current_date - 10) + interval '10 hours' from fx;

insert into public.sale_lines (id, sale_id, variant_id, sku, product_name, variant_name, quantity, unit_price, discount_amount, subtotal, purchase_mode)
select 'f8000000-0000-4000-8000-00000000b001', 'f8000000-0000-4000-8000-00000000a001', v1, 'DASH-P1-V1', 'Esmalte Dash Uno', 'Tono 01', 2, 50, 0, 100, 'retail' from fx;
insert into public.sale_lines (id, sale_id, variant_id, sku, product_name, variant_name, quantity, unit_price, discount_amount, subtotal, purchase_mode)
select 'f8000000-0000-4000-8000-00000000b002', 'f8000000-0000-4000-8000-00000000a002', v2, 'DASH-P2-V1', 'Kit Dash Dos', 'Único', 1, 80, 0, 80, 'retail' from fx;
insert into public.sale_lines (id, sale_id, variant_id, sku, product_name, variant_name, quantity, unit_price, discount_amount, subtotal, purchase_mode)
select 'f8000000-0000-4000-8000-00000000b003', 'f8000000-0000-4000-8000-00000000a003', v1, 'DASH-P1-V1', 'Esmalte Dash Uno', 'Tono 01', 1, 30, 0, 30, 'retail' from fx;
insert into public.sale_lines (id, sale_id, variant_id, sku, product_name, variant_name, quantity, unit_price, discount_amount, subtotal, purchase_mode)
select 'f8000000-0000-4000-8000-00000000b004', 'f8000000-0000-4000-8000-00000000a004', v2, 'DASH-P2-V1', 'Kit Dash Dos', 'Único', 1, 60, 0, 60, 'retail' from fx;

insert into public.sale_line_costs (sale_line_id, sale_id, unit_cost, total_cost, cost_basis, valued_units, unvalued_units) values
  ('f8000000-0000-4000-8000-00000000b001', 'f8000000-0000-4000-8000-00000000a001', 20, 40, 'weighted_average', 2, 0),
  ('f8000000-0000-4000-8000-00000000b002', 'f8000000-0000-4000-8000-00000000a002', 30, 30, 'weighted_average', 1, 0),
  ('f8000000-0000-4000-8000-00000000b003', 'f8000000-0000-4000-8000-00000000a003', 12, 12, 'weighted_average', 1, 0),
  ('f8000000-0000-4000-8000-00000000b004', 'f8000000-0000-4000-8000-00000000a004', null, null, 'unknown', 0, 1);

insert into public.sale_payments (sale_id, method, amount) values
  ('f8000000-0000-4000-8000-00000000a001', 'cash', 100),
  ('f8000000-0000-4000-8000-00000000a002', 'cash', 80),
  ('f8000000-0000-4000-8000-00000000a003', 'cash', 30),
  ('f8000000-0000-4000-8000-00000000a004', 'cash', 60);

-- Anulación de S3, ocurrida dentro de la ventana principal.
insert into public.sale_cancellations (sale_id, branch_id, reason_code, explanation, occurred_at)
select 'f8000000-0000-4000-8000-00000000a003', branch, 'customer_regret', 'Prueba del tablero', now() from fx;

-- Devolución parcial de S1: 50 soles salen.
insert into public.returns (sale_id, branch_id, return_number, refund_total, client_operation_id, occurred_at)
select 'f8000000-0000-4000-8000-00000000a001', branch, 'DASH-0001-D1', 50, gen_random_uuid(), now() from fx;

-- Reserva activa por 40.
insert into public.reservations (branch_id, reservation_number, status, customer_name, expires_at, total, client_operation_id)
select branch, 'DASH-RES-1', 'active', 'Clienta Dash', now() + interval '2 days', 40, gen_random_uuid() from fx;

-- Gastos vigentes de la ventana: 25 general + 10 imputado a S1 = 35.
insert into public.expenses (branch_id, expense_category_id, method, amount, incurred_at, description, client_operation_id)
select branch, (select id from public.expense_categories where code = 'ALQUILER'), 'cash', 25, current_date - 1, 'Gasto general del tablero', gen_random_uuid() from fx;
insert into public.expenses (id, branch_id, expense_category_id, method, amount, incurred_at, description, client_operation_id)
select 'f8000000-0000-4000-8000-00000000c001', branch, (select id from public.expense_categories where code = 'ALQUILER'), 'cash', 10, current_date - 1, 'Gasto imputado a la venta S1', gen_random_uuid() from fx;
insert into public.expense_allocations (expense_id, sale_id, amount)
values ('f8000000-0000-4000-8000-00000000c001', 'f8000000-0000-4000-8000-00000000a001', 10);

-- Proveedores: A recibe el tono a S/20, B a S/25 → A es más barato en 1
-- variante comparable. La deuda va en CLP para no chocar con ninguna base
-- operada: 100 − 40 pagados = 60, vencidos.
insert into public.suppliers (company_id, code, legal_name, trade_name)
select c.id, 'DASH-A', 'Proveedor Dash A SAC', 'Proveedor Dash A' from public.companies c limit 1;
insert into public.suppliers (company_id, code, legal_name, trade_name)
select c.id, 'DASH-B', 'Proveedor Dash B SAC', 'Proveedor Dash B' from public.companies c limit 1;

insert into public.goods_receipts (id, supplier_id, branch_id, receipt_number, status, currency, received_at, goods_total_pen, client_operation_id, confirmed_at)
select 'f8000000-0000-4000-8000-00000000d001', s.id, f.branch, 'DASH-REC-A', 'confirmed', 'PEN', now() - interval '1 day', 200, gen_random_uuid(), now()
from public.suppliers s, fx f where s.code = 'DASH-A';
insert into public.goods_receipts (id, supplier_id, branch_id, receipt_number, status, currency, received_at, goods_total_pen, client_operation_id, confirmed_at)
select 'f8000000-0000-4000-8000-00000000d002', s.id, f.branch, 'DASH-REC-B', 'confirmed', 'PEN', now() - interval '1 day', 125, gen_random_uuid(), now()
from public.suppliers s, fx f where s.code = 'DASH-B';

insert into public.goods_receipt_lines (goods_receipt_id, variant_id, received_units, unit_cost, unit_cost_pen)
select 'f8000000-0000-4000-8000-00000000d001', v1, 10, 20, 20 from fx;
insert into public.goods_receipt_lines (goods_receipt_id, variant_id, received_units, unit_cost, unit_cost_pen)
select 'f8000000-0000-4000-8000-00000000d002', v1, 5, 25, 25 from fx;

insert into public.supplier_obligations (id, supplier_id, goods_receipt_id, currency, amount_due, due_date)
select 'f8000000-0000-4000-8000-00000000e001', s.id, 'f8000000-0000-4000-8000-00000000d001', 'CLP', 100, current_date - 5
from public.suppliers s where s.code = 'DASH-A';

insert into public.supplier_payments (id, supplier_id, branch_id, method, amount, currency, client_operation_id)
select 'f8000000-0000-4000-8000-00000000e002', s.id, f.branch, 'transfer', 40, 'CLP', gen_random_uuid()
from public.suppliers s, fx f where s.code = 'DASH-A';
insert into public.supplier_payment_allocations (supplier_payment_id, supplier_obligation_id, amount)
values ('f8000000-0000-4000-8000-00000000e002', 'f8000000-0000-4000-8000-00000000e001', 40);

-- Compra pendiente: una orden enviada por 500 en la sede del tablero.
insert into public.purchase_orders (supplier_id, branch_id, order_number, status, currency, gross_total, discount_total, total, client_operation_id)
select s.id, f.branch, 'DASH-PO-1', 'sent', 'PEN', 500, 0, 500, gen_random_uuid()
from public.suppliers s, fx f where s.code = 'DASH-A';

-- ---------------------------------------------------------------------------
-- Estructura y control de acceso
-- ---------------------------------------------------------------------------

select has_function('public', 'business_dashboard', array['date','date','uuid'],
  '1 · Existe el tablero comercial');

select is(
  has_function_privilege('anon', 'public.business_dashboard(date,date,uuid)', 'execute'),
  false,
  '2 · anon no puede ni ejecutarlo'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  $$ select public.business_dashboard(current_date - 2, current_date) $$,
  '42501', null,
  '3 · La vendedora recibe un error explícito: el tablero es administrativo'
);

reset role;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated"}';

-- Tres llamadas: la ventana principal filtrada por sede, la ventana de la
-- venta sin costo, y la sede vacía.
create temporary table dash on commit drop as
select public.business_dashboard(current_date - 2, current_date, (select branch from fx)) as d;
create temporary table dash_unknown on commit drop as
select public.business_dashboard(current_date - 11, current_date - 9, (select branch from fx)) as d;
create temporary table dash_empty on commit drop as
select public.business_dashboard(current_date - 2, current_date, (select empty_branch from fx)) as d;

select ok((select d from dash) is not null, '4 · El administrador obtiene el tablero');

-- ---------------------------------------------------------------------------
-- Indicadores: cada número tiene una sola respuesta correcta
-- ---------------------------------------------------------------------------

select is((select (d->'ventas'->>'total')::numeric from dash), 180::numeric,
  '5 · Total vendido: 100 + 80, la anulada no cuenta');

select is((select (d->'ventas'->>'operaciones')::integer from dash), 2,
  '6 · Dos operaciones confirmadas');

select is((select (d->'ventas'->>'unidades')::integer from dash), 3,
  '7 · Tres unidades vendidas');

select is((select (d->'ventas'->>'ticketPromedio')::numeric from dash), 90::numeric,
  '8 · Ticket promedio 90');

select is((select (d->'margen'->>'margenBruto')::numeric from dash), 110::numeric,
  '9 · Margen bruto 110: (100−40) + (80−30), con cobertura completa');

select is((select (d->'margen'->>'margenContribucion')::numeric from dash), 100::numeric,
  '10 · Contribución 100: margen menos los 10 imputados a la venta');

select is((select (d->'margen'->>'gastosTotales')::numeric from dash), 35::numeric,
  '11 · Gastos del rango: 25 generales + 10 imputados');

select is((select (d->'margen'->>'utilidadNetaEstimada')::numeric from dash), 75::numeric,
  '12 · Utilidad neta estimada 75 = 110 − 35: incluye TODOS los gastos registrados (regla 16)');

select is((select (d->'devoluciones'->>'total')::numeric from dash), 50::numeric,
  '13 · La devolución de 50 aparece como salida propia, no neteada');

select ok((
  select (d->'anulaciones'->>'operaciones')::integer = 1
     and (d->'anulaciones'->>'total')::numeric = 30
  from dash
), '14 · La anulación cuenta con su importe original');

select ok((
  select (d->'reservas'->>'activas')::integer = 1
     and (d->'reservas'->>'activasTotal')::numeric = 40
     and (d->'reservas'->>'creadasEnRango')::integer = 1
  from dash
), '15 · La reserva activa está contada con su total');

select ok((
  select (e->>'total')::numeric = 60 and (e->>'vencida')::numeric = 60
  from dash, jsonb_array_elements((select d from dash)->'deudaProveedores') e
  where e->>'moneda' = 'CLP'
), '16 · Deuda con proveedor: 100 − 40 pagados = 60, todo vencido');

select ok((
  select (e->>'ordenes')::integer = 1 and (e->>'total')::numeric = 500
  from dash, jsonb_array_elements((select d from dash)->'comprasPendientes') e
  where e->>'moneda' = 'PEN'
), '17 · La orden enviada figura como compra pendiente por 500');

-- ---------------------------------------------------------------------------
-- Rankings
-- ---------------------------------------------------------------------------

select ok((
  select r->0->>'nombre' = 'Esmalte Dash Uno' and (r->0->>'unidades')::integer = 2
  from (select d->'rankings'->'productosPorUnidades' as r from dash) t
), '18 · Producto más vendido por unidades: el esmalte con 2');

select ok((
  select r->0->>'nombre' = 'Esmalte Dash Uno' and (r->0->>'ingreso')::numeric = 100
  from (select d->'rankings'->'productosPorIngreso' as r from dash) t
), '19 · Mayor facturación: el esmalte con 100');

select is((
  select d->'rankings'->'tonosPorUnidades'->0->>'tono' from dash
), 'Rojo Pasión',
  '20 · El tono más vendido viene de la BIBLIOTECA de colores, no del nombre de la variante');

select ok((
  select r->0->>'nombre' = 'Esmalte Dash Uno'
     and (r->0->>'margen')::numeric = 60
     and (r->0->>'margenPorcentaje')::numeric = 60.0
  from (select d->'rankings'->'productosPorMargen' as r from dash) t
), '21 · Mayor margen acumulado: 60 del esmalte, 60 % sobre su ingreso');

select ok((
  select r->0->>'nombre' = 'Esmaltes Dash'
     and (r->0->>'ingreso')::numeric = 100
     and (r->0->>'margen')::numeric = 60
  from (select d->'rankings'->'categorias' as r from dash) t
), '22 · Categoría más rentable con ingreso y margen propios');

select ok((
  select r->0->>'nombre' = 'Marca Dash'
     and (r->0->>'ingreso')::numeric = 180
     and (r->0->>'margen')::numeric = 110
  from (select d->'rankings'->'marcas' as r from dash) t
), '23 · La marca agrega los dos productos');

select ok((
  select (c->'in_store'->>'ingreso')::numeric = 100
     and (c->'whatsapp'->>'ingreso')::numeric = 80
  from (select d->'rankings'->'canales' as c from dash) t
), '24 · Canal de origen: tienda 100, WhatsApp 80');

select is((select jsonb_typeof(d->'rankings'->'campanas') from dash), 'array',
  '25 · Las campañas existen como estructura aunque el recorrido no tenga atribución');

select ok((
  select r->0->>'etiqueta' = 'Vendedora Dash' and (r->0->>'ingreso')::numeric = 180
  from (select d->'rankings'->'vendedoras' as r from dash) t
), '26 · La vendedora concentra los 180');

select ok((
  select
    (select (e->>'masBaratoEn')::integer from jsonb_array_elements((select d from dash)->'rankings'->'proveedores') e where e->>'nombre' = 'Proveedor Dash A') = 1
    and (select (e->>'masBaratoEn')::integer from jsonb_array_elements((select d from dash)->'rankings'->'proveedores') e where e->>'nombre' = 'Proveedor Dash B') = 0
), '27 · Proveedor más conveniente: A gana la única variante comparable (20 vs 25)');

-- ---------------------------------------------------------------------------
-- La doctrina del costo desconocido y el filtro por sede
-- ---------------------------------------------------------------------------

select ok((
  select (d->'margen'->'margenBruto') = 'null'::jsonb
     and (d->'margen'->>'ventasSinCosto')::integer = 1
     and d->'margen'->>'razonNoCalculable' = 'ventas_sin_costo'
  from dash_unknown
), '28 · Con una venta sin costo el margen bruto es NULL con su razón, jamás un 100 % ficticio');

select ok((
  select (d->'margen'->'utilidadNetaEstimada') = 'null'::jsonb
     and (d->'margen'->>'margenBrutoValorizado')::numeric = 0
  from dash_unknown
), '29 · Y la utilidad neta tampoco se inventa: NULL, con el valorizado en 0');

select is((select (d->'ventas'->>'total')::numeric from dash_empty), 0::numeric,
  '30 · La sede sin ventas reporta cero, no un error');

select throws_ok(
  $$ select public.business_dashboard(current_date, current_date - 5) $$,
  '22023', null,
  '31 · Un rango invertido es un error explícito'
);

-- Los pagos del fixture cuadran con sus ventas: el trigger diferido del
-- Bloque 2 no tiene nada que objetar si se fuerza AHORA.
select lives_ok(
  $$ set constraints all immediate $$,
  '32 · El circuito de pagos del fixture cuadra ante el trigger diferido'
);

select * from finish();

rollback;
