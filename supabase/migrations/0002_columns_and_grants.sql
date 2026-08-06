-- 0002_columns_and_grants.sql
-- Consolida los ajustes posteriores al esquema base (0001):
--   · columna products.lamp_type (opción exacta del panel: No / Sí / UV/LED)
--   · columna products.color_chart_pdf_path (carta de colores en PDF multipágina)
--   · el bucket catalog-assets acepta PDF
--   · privilegios de los roles del API (lectura pública + escritura del admin), que los
--     defaults de Supabase no aplicaron. RLS (0001) sigue filtrando cada fila.

begin;

-- ── Columnas ────────────────────────────────────────────────────────────────
-- lamp_type preserva la opción exacta del panel; requires_lamp se deriva de ella.
alter table public.products
  add column if not exists lamp_type text not null default 'No';

update public.products
set lamp_type = case when requires_lamp then 'Sí' else 'No' end;

alter table public.products
  drop constraint if exists products_lamp_type_allowed;
alter table public.products
  add constraint products_lamp_type_allowed
  check (lamp_type in ('No', 'Sí', 'UV/LED'));

-- Carta de colores como documento PDF (además de la imagen del slot 03).
alter table public.products
  add column if not exists color_chart_pdf_path text;

-- El bucket público de assets ahora acepta PDF para servir esas cartas.
update storage.buckets
set allowed_mime_types = array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']
where id = 'catalog-assets';

-- ── Privilegios de roles del API ─────────────────────────────────────────────
-- Los defaults de Supabase no otorgaron privilegios a estas tablas (error 42501).
-- RLS de 0001 sigue protegiendo qué filas ve/escribe cada rol.
grant usage on schema public to anon, authenticated, service_role;

-- Lectura: pública (RLS filtra a lo activo/publicado).
grant select on all tables in schema public to anon, authenticated;

-- Escritura del panel admin: los endpoints /api/admin/* usan el cliente de sesión
-- (rol `authenticated`), no service_role. RLS de 0001 restringe cada fila a is_admin().
-- (catalog_metadata la actualiza el trigger touch_catalog_metadata(), SECURITY DEFINER.)
grant insert, update, delete on
  public.products,
  public.product_images,
  public.brands,
  public.categories,
  public.store_settings,
  public.pdf_exports
to authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant execute on all functions in schema public to anon, authenticated, service_role;

-- Que los objetos futuros hereden los privilegios (evita repetir este fix).
alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

commit;
