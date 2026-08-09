begin;

create extension if not exists pgtap with schema extensions;

select plan(17);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- La pregunta que responde esta prueba es la de la clienta indecisa: «quiero un
-- rojo, ¿qué rojos tienes?». La vendedora abre la hoja de tonos del esmalte y
-- tiene que ver TODOS los tonos con su color, su código y su stock, sin que la
-- lista se recargue mientras elige.
--
-- Y la segunda pregunta, la de la vendedora: «lo que yo despaché ayer, ¿me sale
-- a mí o le sale también a mi compañera?». Debe salirle solo a ella.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','fa000000-0000-4000-8000-000000000001','authenticated','authenticated','tonos-vendedora-a@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','fa000000-0000-4000-8000-000000000002','authenticated','authenticated','tonos-vendedora-b@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','fa000000-0000-4000-8000-000000000003','authenticated','authenticated','tonos-ajena@example.invalid','',now(),'{}','{}',now(),now(),'','','','');

insert into public.admin_profiles(id, role, full_name) values
  ('fa000000-0000-4000-8000-000000000001','seller','Vendedora A'),
  ('fa000000-0000-4000-8000-000000000002','seller','Vendedora B'),
  ('fa000000-0000-4000-8000-000000000003','seller','Vendedora de otra sede');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'POSTONOS', 'Sede de la hoja de tonos', 'Lima', false, 947
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.branches where code = 'POSTONOS') as branch_id,
  (select id from public.brands where is_active order by created_at limit 1) as brand_id,
  (select id from public.categories where is_active order by created_at limit 1) as category_id,
  (select ao.id from public.attribute_options ao
     join public.attribute_definitions ad on ad.id = ao.attribute_definition_id
    where ad.code = 'color_family' and ao.value = 'rojos' limit 1) as rojos_id,
  (select ao.id from public.attribute_options ao
     join public.attribute_definitions ad on ad.id = ao.attribute_definition_id
    where ad.code = 'color_family' and ao.value = 'azules' limit 1) as azules_id;

grant select on fx to authenticated;

insert into public.staff_branches (staff_id, branch_id)
select 'fa000000-0000-4000-8000-000000000001'::uuid, fx.branch_id from fx
union all
select 'fa000000-0000-4000-8000-000000000002'::uuid, fx.branch_id from fx;

-- Un esmalte con cuatro tonos: dos rojos, un azul y uno agotado.
insert into public.products (code, slug, brand_id, category_id, template_id, name, presentation,
                             product_type, unit_price, wholesale_price, wholesale_min_quantity,
                             availability, is_active)
select 'TONOS-ESM', 'tonos-esmalte-hoja', fx.brand_id, fx.category_id,
       (select id from public.attribute_templates order by created_at limit 1),
       'Esmalte Hoja de Tonos', '13.5 ml', 'Esmalte tradicional', 9.50, 7.80, 5, 'available', true
from fx;

insert into public.color_shades (brand_id, name, code, color_family_option_id, reference_color, is_active)
select fx.brand_id, 'Amapola', 'HT-001', fx.rojos_id,  '#C0304F', true from fx
union all
select fx.brand_id, 'Carmesí', 'HT-002', fx.rojos_id,  '#8E1B32', true from fx
union all
select fx.brand_id, 'Marea',   'HT-003', fx.azules_id, '#2F5FA8', true from fx
union all
select fx.brand_id, 'Zafiro',  'HT-004', fx.azules_id, '#1B3F7A', true from fx;

insert into public.product_variants (product_id, sku, name, variant_key, color_shade_id,
                                     availability_status, is_active, tracks_inventory, sort_order)
select p.id, 'HT-SKU-001', 'Amapola', 'amapola', (select id from public.color_shades where code = 'HT-001'),
       'available'::public.product_availability, true, true, 1 from public.products p where p.code = 'TONOS-ESM'
union all
select p.id, 'HT-SKU-002', 'Carmesí', 'carmesi', (select id from public.color_shades where code = 'HT-002'),
       'available'::public.product_availability, true, true, 2 from public.products p where p.code = 'TONOS-ESM'
union all
select p.id, 'HT-SKU-003', 'Marea', 'marea', (select id from public.color_shades where code = 'HT-003'),
       'available'::public.product_availability, true, true, 3 from public.products p where p.code = 'TONOS-ESM'
union all
select p.id, 'HT-SKU-004', 'Zafiro', 'zafiro', (select id from public.color_shades where code = 'HT-004'),
       'sold_out'::public.product_availability, true, true, 4 from public.products p where p.code = 'TONOS-ESM';

insert into public.inventory_stock (variant_id, branch_id, on_hand, reserved)
select v.id, fx.branch_id, 6, 0 from public.product_variants v, fx where v.sku in ('HT-SKU-001','HT-SKU-002','HT-SKU-003')
union all
select v.id, fx.branch_id, 0, 0 from public.product_variants v, fx where v.sku = 'HT-SKU-004';

-- El precio que se cobra vive en `variant_prices`, no en `products.unit_price`.
-- Los tres vendibles lo tienen; el agotado se deja SIN precio a propósito, que
-- es el estado del catálogo recién importado y lo que la pantalla debe decir.
insert into public.variant_prices (variant_id, price_list_id, amount, minimum_quantity)
select v.id, (select id from public.price_lists where price_type = 'retail' and is_active limit 1), 9.50, 1
from public.product_variants v where v.sku in ('HT-SKU-001','HT-SKU-002','HT-SKU-003')
union all
select v.id, (select id from public.price_lists where price_type = 'wholesale' and is_active limit 1), 7.80, 5
from public.product_variants v where v.sku in ('HT-SKU-001','HT-SKU-002','HT-SKU-003');

-- Dos ventas confirmadas, una por vendedora, sobre tonos distintos. Se insertan
-- a mano en lugar de llamar a register_sale porque lo que se prueba aquí es la
-- lectura, no el registro.
insert into public.sales (id, branch_id, sale_number, gross_subtotal, discount_total, total,
                          seller_id, seller_label, client_operation_id, issued_at)
select 'fa000000-0000-4000-8000-00000000000a'::uuid, fx.branch_id, 'HT-A-0001', 9.50, 0, 9.50,
       'fa000000-0000-4000-8000-000000000001'::uuid, 'Vendedora A',
       'fa000000-0000-4000-8000-0000000000aa'::uuid, now() - interval '2 days' from fx
union all
select 'fa000000-0000-4000-8000-00000000000b'::uuid, fx.branch_id, 'HT-B-0001', 9.50, 0, 9.50,
       'fa000000-0000-4000-8000-000000000002'::uuid, 'Vendedora B',
       'fa000000-0000-4000-8000-0000000000bb'::uuid, now() - interval '1 day' from fx;

insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name, brand_name,
                               quantity, unit_price, discount_amount, subtotal, line_order)
select 'fa000000-0000-4000-8000-00000000000a'::uuid, v.id, v.sku, 'Esmalte Hoja de Tonos', 'Amapola', 'x',
       1, 9.50, 0, 9.50, 0 from public.product_variants v where v.sku = 'HT-SKU-001'
union all
select 'fa000000-0000-4000-8000-00000000000b'::uuid, v.id, v.sku, 'Esmalte Hoja de Tonos', 'Marea', 'x',
       1, 9.50, 0, 9.50, 0 from public.product_variants v where v.sku = 'HT-SKU-003';

-- `sales_require_payment` es un constraint trigger diferido: sin cobro la venta
-- no existe, así que también aquí hay que pagarla.
insert into public.sale_payments (sale_id, method, amount)
values ('fa000000-0000-4000-8000-00000000000a', 'cash', 9.50),
       ('fa000000-0000-4000-8000-00000000000b', 'cash', 9.50);

-- ---------------------------------------------------------------------------
-- Sin sesión no se abre nada
-- ---------------------------------------------------------------------------
select is(
  (select jsonb_array_length(
     public.pos_product_tones((select branch_id from fx),
                              (select id from public.products where code = 'TONOS-ESM')) -> 'tones')),
  0,
  'sin sesión la hoja de tonos no devuelve ni un tono'
);

-- ---------------------------------------------------------------------------
-- Vendedora A abre la hoja
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"fa000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select (public.pos_product_tones((select branch_id from fx),
            (select id from public.products where code = 'TONOS-ESM')) -> 'product' ->> 'toneCount')::int),
  4,
  'la cabecera dice cuántos tonos tiene el producto'
);

-- La cuenta de disponibles no puede incluir el agotado: es el número que la
-- vendedora le canta a la clienta.
select is(
  (select (public.pos_product_tones((select branch_id from fx),
            (select id from public.products where code = 'TONOS-ESM')) -> 'product' ->> 'availableCount')::int),
  3,
  'y cuántos puede vender de verdad, sin contar el agotado'
);

-- El umbral de mayoreo es del producto: prohibido «desde 3» como constante.
select is(
  (select (public.pos_product_tones((select branch_id from fx),
            (select id from public.products where code = 'TONOS-ESM')) -> 'product' ->> 'wholesaleMinQuantity')::int),
  5,
  'el umbral de mayoreo viaja por producto, no como constante'
);

select is(
  (select jsonb_array_length(
     public.pos_product_tones((select branch_id from fx),
       (select id from public.products where code = 'TONOS-ESM')) -> 'tones')),
  4,
  'la hoja trae TODOS los tonos de una vez: la cuadrícula no se recarga al elegir'
);

-- Elegir mirando exige el color, no solo el nombre.
select is(
  (select tono ->> 'referenceColor'
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-001'),
  '#C0304F',
  'cada tono trae su color de referencia para pintarse en la cuadrícula'
);

select is(
  (select tono ->> 'familyLabel'
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-003'),
  'Azules',
  'y su familia cromática, que es como filtra la clienta'
);

select is(
  (select (tono ->> 'availableQuantity')::int
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-002'),
  6,
  'el stock es el de ESA variante en ESA sede'
);

-- El precio es el que se va a cobrar, no la columna heredada del producto.
select is(
  (select (tono ->> 'unitPrice')::numeric
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-002'),
  9.50::numeric,
  'el precio del tono sale de la lista vigente, que es lo que se cobra'
);

-- Y donde no hay precio se dice que no lo hay: un cero se acaba cobrando.
select is(
  (select tono ->> 'unitPrice'
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-004'),
  null,
  'un tono sin precio vigente devuelve null, nunca S/ 0.00'
);

select is(
  (select (public.pos_product_tones((select branch_id from fx),
            (select id from public.products where code = 'TONOS-ESM')) -> 'product' ->> 'withoutPrice')::int),
  1,
  'y la cabecera cuenta cuántos tonos están todavía sin precio'
);

-- Filtros que no mienten: solo las familias que este producto tiene.
select is(
  (select jsonb_array_length(
     public.pos_product_tones((select branch_id from fx),
       (select id from public.products where code = 'TONOS-ESM')) -> 'families')),
  2,
  'los filtros por familia solo ofrecen las familias presentes en el producto'
);

-- ---------------------------------------------------------------------------
-- Recientes: personal, no compartido
-- ---------------------------------------------------------------------------
select isnt(
  (select tono ->> 'lastSoldAt'
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-001'),
  null,
  'a la vendedora A le consta como reciente el tono que ella despachó'
);

select is(
  (select tono ->> 'lastSoldAt'
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-003'),
  null,
  'y NO le consta el que despachó su compañera: recientes es de cada una'
);

-- Más vendidos, en cambio, es de la tienda: ahí sí cuentan las dos ventas.
select is(
  (select (tono ->> 'soldUnits')::int
     from jsonb_array_elements(
       public.pos_product_tones((select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')) -> 'tones') as tono
    where tono ->> 'shadeCode' = 'HT-003'),
  1,
  'más vendidos sí es de la tienda: cuenta la venta de la compañera'
);

-- ---------------------------------------------------------------------------
-- La búsqueda agrupa el producto en vez de inundar la lista
-- ---------------------------------------------------------------------------
select is(
  (select (grupo ->> 'toneCount')::int
     from jsonb_array_elements(
       public.pos_variant_search((select branch_id from fx), 'Esmalte Hoja de Tonos') -> 'products') as grupo
    where grupo ->> 'productName' = 'Esmalte Hoja de Tonos'),
  4,
  'el buscador agrupa el producto y dice cuántos tonos tiene para abrirlo'
);

-- ---------------------------------------------------------------------------
-- Una sede ajena no se abre
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"fa000000-0000-4000-8000-000000000003","role":"authenticated"}';

select throws_ok(
  format('select public.pos_product_tones(%L::uuid, %L::uuid)',
         (select branch_id from fx),
         (select id from public.products where code = 'TONOS-ESM')),
  '42501',
  null,
  'una vendedora sin esa sede no puede abrir su hoja de tonos'
);

select * from finish();

rollback;
