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

insert into public.categories (name, slug, sort_order)
values
  ('Esmaltes en gel', 'esmaltes-en-gel', 10),
  ('Cartas de colores', 'cartas-de-colores', 20),
  ('Accesorios', 'accesorios', 30)
on conflict (slug) do update
set name = excluded.name,
    sort_order = excluded.sort_order,
    is_active = true;

-- Bootstrap an admin after creating the Supabase Auth user:
-- insert into public.admin_profiles (id, role, full_name)
-- values ('AUTH_USER_UUID_HERE', 'admin', 'Admin Bellaroshe')
-- on conflict (id) do update set role = 'admin';
