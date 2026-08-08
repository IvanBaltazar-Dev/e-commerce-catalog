begin;

create extension if not exists pgtap with schema extensions;

select plan(11);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- La pregunta que responde esta prueba es la de la vendedora en mostrador:
-- «la clienta me pidió Abrumadora, ¿tengo que abrir el esmalte y recorrer sus
-- tonos, o el buscador me la da directamente?».

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','f8000000-0000-4000-8000-000000000001','authenticated','authenticated','pos-search-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','f8000000-0000-4000-8000-000000000002','authenticated','authenticated','pos-search-ajena@example.invalid','',now(),'{}','{}',now(),now(),'','','','');

insert into public.admin_profiles(id, role, full_name) values
  ('f8000000-0000-4000-8000-000000000001','admin','Propietaria del POS'),
  ('f8000000-0000-4000-8000-000000000002','seller','Vendedora de otra sede');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'POSSEARCH', 'Sede del POS', 'Lima', false, 948
from public.companies c limit 1;

create temporary table fx on commit drop as
select
  (select id from public.branches where code = 'POSSEARCH') as branch_id,
  (select id from public.brands where is_active order by created_at limit 1) as brand_id,
  (select id from public.categories where is_active order by created_at limit 1) as category_id,
  (select ao.id from public.attribute_options ao
     join public.attribute_definitions ad on ad.id = ao.attribute_definition_id
    where ad.code = 'color_family' and ao.is_active
    order by ao.sort_order limit 1) as family_id;

-- Las comprobaciones se hacen con el rol real, así que la tabla de fixtures
-- tiene que ser legible desde él.
grant select on fx to authenticated;

-- Un esmalte con dos tonos: uno disponible y otro agotado.
insert into public.products (code, slug, brand_id, category_id, template_id, name, presentation,
                             product_type, unit_price, wholesale_price, wholesale_min_quantity,
                             availability, is_active)
select 'POS-TRAD', 'pos-esmalte-tradicional', fx.brand_id, fx.category_id,
       (select id from public.attribute_templates order by created_at limit 1),
       'Esmalte Tradicional POS', '13.5 ml', 'Esmalte tradicional', 9.50, 7.80, 4, 'available', true
from fx;

insert into public.color_shades (brand_id, name, code, color_family_option_id, reference_color, is_active)
select fx.brand_id, 'Abrumadora', 'MSG-114', fx.family_id, '#C0304F', true from fx
union all
select fx.brand_id, 'Bella Sombra', 'MSG-220', fx.family_id, '#5B3A52', true from fx;

insert into public.product_variants (product_id, sku, name, variant_key, barcode, color_shade_id,
                                     availability_status, is_active, tracks_inventory, sort_order)
select p.id, 'POS-TRAD-114', 'Abrumadora', 'abrumadora', '7751234000114',
       (select id from public.color_shades where code = 'MSG-114'), 'available'::public.product_availability, true, true, 1
from public.products p where p.code = 'POS-TRAD'
union all
select p.id, 'POS-TRAD-220', 'Bella Sombra', 'bella-sombra', '7751234000220',
       (select id from public.color_shades where code = 'MSG-220'), 'sold_out'::public.product_availability, true, true, 2
from public.products p where p.code = 'POS-TRAD';

insert into public.inventory_stock (variant_id, branch_id, on_hand, reserved)
select v.id, fx.branch_id, 7, 0 from public.product_variants v, fx where v.sku = 'POS-TRAD-114'
union all
select v.id, fx.branch_id, 0, 0 from public.product_variants v, fx where v.sku = 'POS-TRAD-220';

insert into public.staff_branches (staff_id, branch_id)
select 'f8000000-0000-4000-8000-000000000001', fx.branch_id from fx;

-- ---------------------------------------------------------------------------
-- Sin sesión no se devuelve nada
-- ---------------------------------------------------------------------------
select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Abrumadora') ->> 'total')::int),
  0,
  'sin sesión el buscador del POS no devuelve ni una fila'
);

-- ---------------------------------------------------------------------------
-- La propietaria busca desde su sede
-- ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims to '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Abrumadora') -> 'items' -> 0 ->> 'variantName')),
  'Abrumadora',
  'teclear el nombre del tono devuelve la variante, no el producto'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Abrumadora') -> 'items' -> 0 ->> 'shadeCode')),
  'MSG-114',
  'la fila trae el código del tono para que la vendedora lo confirme'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Abrumadora') -> 'items' -> 0 ->> 'availableQuantity')::int),
  7,
  'y trae el stock de ESA variante en ESA sede'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), '7751234000114') -> 'items' -> 0 ->> 'sku')),
  'POS-TRAD-114',
  'escanear el código de barras cae en la variante exacta'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'MSG-220') -> 'items' -> 0 ->> 'variantName')),
  'Bella Sombra',
  'el código de tono tecleado también resuelve solo'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Esmalte Tradicional POS') ->> 'total')::int),
  2,
  'buscar por producto devuelve sus dos tonos como filas independientes'
);

-- Lo vendible primero: quien cobra no quiere ver agotados arriba.
select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Esmalte Tradicional POS') -> 'items' -> 0 ->> 'availability')),
  'available',
  'dentro del mismo producto, lo disponible se ofrece antes que lo agotado'
);

-- El umbral de mayoreo es del producto y viaja en el contrato: prohibido
-- escribir «desde 3» como constante en ningún sitio.
select is(
  (select (public.pos_variant_search((select branch_id from fx), 'Abrumadora') -> 'items' -> 0 ->> 'wholesaleMinQuantity')::int),
  4,
  'el umbral de mayoreo viaja por producto, no como constante'
);

select is(
  (select (public.pos_variant_search((select branch_id from fx), 'no-existe-este-tono') ->> 'total')::int),
  0,
  'una búsqueda sin resultados devuelve vacío, no error'
);

-- ---------------------------------------------------------------------------
-- Una sede ajena no se consulta
-- ---------------------------------------------------------------------------
set local request.jwt.claims to '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated"}';

select throws_ok(
  format('select public.pos_variant_search(%L::uuid, %L)', (select branch_id from fx), 'Abrumadora'),
  '42501',
  null,
  'una vendedora sin esa sede no puede buscar en ella'
);

select * from finish();

rollback;
