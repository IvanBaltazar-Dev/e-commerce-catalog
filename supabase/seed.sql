insert into public.store_settings (
  id,
  business_name,
  whatsapp_number,
  stock_notice
)
values (
  true,
  'Bellaroshe',
  '+51963463550',
  'Precios, tonos disponibles y stock se confirman por WhatsApp.'
)
on conflict (id) do update
set business_name = excluded.business_name,
    whatsapp_number = excluded.whatsapp_number,
    stock_notice = excluded.stock_notice;

insert into public.brands (name, slug, sort_order)
values
  ('Masglo', 'masglo', 10),
  ('Admiss', 'admiss', 20),
  ('Cherimoya', 'cherimoya', 30),
  ('Flower Secret', 'flower-secret', 40),
  ('Glam Nails', 'glam-nails', 50),
  ('Mystyle', 'mystyle', 60),
  ('Candy Secret', 'candy-secret', 70)
on conflict (slug) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

insert into public.brand_product_families(brand_id, template_id)
select brand.id, template.id
from (
  values
    ('masglo', 'ESMALTE_TONOS'),
    ('cherimoya', 'ESMALTE_TONOS'),
    ('flower-secret', 'ESMALTE_TONOS'),
    ('glam-nails', 'ESMALTE_TONOS'),
    ('mystyle', 'ESMALTE_TONOS'),
    ('candy-secret', 'ESMALTE_TONOS'),
    ('admiss', 'ESMALTE_TONOS')
) as assignment(brand_slug, template_code)
join public.brands brand on brand.slug = assignment.brand_slug
join public.attribute_templates template on template.code = assignment.template_code
on conflict do nothing;

insert into public.product_lines(brand_id, name, slug, description, sort_order)
select id, 'Gel Evolution', 'gel-evolution', 'Línea de esmaltes Masglo.', 10
from public.brands where slug = 'masglo'
on conflict (brand_id, slug) do update set name = excluded.name, is_active = true;

insert into public.product_line_product_families(product_line_id, template_id)
select line.id, template.id
from public.product_lines line
join public.brands brand on brand.id = line.brand_id and brand.slug = 'masglo'
join public.attribute_templates template on template.code = 'ESMALTE_TONOS'
where line.slug = 'gel-evolution'
on conflict do nothing;

insert into public.categories (name, slug, sort_order)
values
  ('Esmaltes en gel', 'esmaltes-en-gel', 10),
  ('Cartas de colores', 'cartas-de-colores', 20),
  ('Accesorios', 'accesorios', 30)
on conflict on constraint categories_parent_slug_unique do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

-- Bootstrap an admin after creating the Supabase Auth user:
-- insert into public.admin_profiles (id, role, full_name)
-- values ('AUTH_USER_UUID_HERE', 'admin', 'Admin Bellaroshe')
-- on conflict (id) do update set role = 'admin';
