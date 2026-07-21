-- Bellaroshe Catalog v1.0
--
-- Esquema base completo de PostgreSQL/Supabase. Este archivo consolida el
-- modelo de catálogo, los permisos de API, Storage y las políticas RLS.
-- Consultar README.md en este mismo directorio antes de aplicarlo a una base
-- que ya tenga historial de migraciones.

begin;

create extension if not exists pgcrypto;

do $$
begin
  create type public.app_role as enum ('admin');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.product_availability as enum ('available', 'sold_out', 'consult');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.color_chart_status as enum ('available', 'consult_advisor');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type public.pdf_export_status as enum (
    'not_generated',
    'generating',
    'updated',
    'outdated',
    'error'
  );
exception
  when duplicate_object then null;
end
$$;

create table public.admin_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'admin',
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint brands_name_not_blank check (length(trim(name)) > 0),
  constraint brands_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint categories_name_not_blank check (length(trim(name)) > 0),
  constraint categories_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  slug text not null unique,
  brand_id uuid not null references public.brands(id) on update cascade,
  category_id uuid not null references public.categories(id) on update cascade,
  name text not null,
  presentation text not null,
  product_type text not null,
  requires_lamp boolean not null default false,
  -- Preserva la opción exacta que se muestra en el panel. `requires_lamp`
  -- se mantiene para la API pública y se deriva de este valor en la app.
  lamp_type text not null default 'No',
  description text,
  unit_price numeric(12, 2) not null,
  wholesale_price numeric(12, 2) not null,
  wholesale_min_quantity integer not null default 3,
  availability public.product_availability not null default 'available',
  color_chart_status public.color_chart_status not null default 'consult_advisor',
  main_image_path text,
  color_chart_image_path text,
  color_chart_pdf_path text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint products_code_not_blank check (length(trim(code)) > 0),
  constraint products_name_not_blank check (length(trim(name)) > 0),
  constraint products_slug_format check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint products_lamp_type_allowed check (lamp_type in ('No', 'Sí', 'UV/LED')),
  constraint products_prices_non_negative check (unit_price >= 0 and wholesale_price >= 0),
  constraint products_wholesale_min_positive check (wholesale_min_quantity > 0)
);

create index products_brand_id_idx on public.products(brand_id);
create index products_category_id_idx on public.products(category_id);
create index products_active_sort_idx on public.products(is_active, sort_order, name);

create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  path text not null,
  alt_text text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_images_path_not_blank check (length(trim(path)) > 0)
);

create index product_images_product_id_idx on public.product_images(product_id, sort_order);

create table public.store_settings (
  id boolean primary key default true,
  business_name text not null default 'Bellaroshe',
  whatsapp_number text not null default '+51963463550',
  stock_notice text not null default 'Precios y stock son referenciales hasta confirmar por WhatsApp.',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint store_settings_singleton check (id),
  constraint store_settings_whatsapp_not_blank check (length(trim(whatsapp_number)) > 0)
);

create table public.catalog_metadata (
  id boolean primary key default true,
  content_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_metadata_singleton check (id)
);

create table public.pdf_exports (
  id uuid primary key default gen_random_uuid(),
  status public.pdf_export_status not null default 'not_generated',
  storage_path text,
  generated_by uuid references auth.users(id) on delete set null,
  generated_at timestamptz,
  catalog_updated_at_snapshot timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pdf_exports_created_at_idx on public.pdf_exports(created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.touch_catalog_metadata()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.catalog_metadata
  set content_updated_at = now(),
      updated_at = now()
  where id = true;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

create trigger admin_profiles_set_updated_at
before update on public.admin_profiles
for each row execute function public.set_updated_at();

create trigger brands_set_updated_at
before update on public.brands
for each row execute function public.set_updated_at();

create trigger categories_set_updated_at
before update on public.categories
for each row execute function public.set_updated_at();

create trigger products_set_updated_at
before update on public.products
for each row execute function public.set_updated_at();

create trigger product_images_set_updated_at
before update on public.product_images
for each row execute function public.set_updated_at();

create trigger store_settings_set_updated_at
before update on public.store_settings
for each row execute function public.set_updated_at();

create trigger catalog_metadata_set_updated_at
before update on public.catalog_metadata
for each row execute function public.set_updated_at();

create trigger pdf_exports_set_updated_at
before update on public.pdf_exports
for each row execute function public.set_updated_at();

create trigger brands_touch_catalog
after insert or update or delete on public.brands
for each row execute function public.touch_catalog_metadata();

create trigger categories_touch_catalog
after insert or update or delete on public.categories
for each row execute function public.touch_catalog_metadata();

create trigger products_touch_catalog
after insert or update or delete on public.products
for each row execute function public.touch_catalog_metadata();

create trigger product_images_touch_catalog
after insert or update or delete on public.product_images
for each row execute function public.touch_catalog_metadata();

create trigger store_settings_touch_catalog
after insert or update or delete on public.store_settings
for each row execute function public.touch_catalog_metadata();

create or replace function public.is_admin(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = user_id
      and role = 'admin'
  );
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to anon, authenticated, service_role;

alter table public.admin_profiles enable row level security;
alter table public.brands enable row level security;
alter table public.categories enable row level security;
alter table public.products enable row level security;
alter table public.product_images enable row level security;
alter table public.store_settings enable row level security;
alter table public.catalog_metadata enable row level security;
alter table public.pdf_exports enable row level security;

create policy "admin profiles read own or admin"
on public.admin_profiles
for select
to authenticated
using (id = auth.uid() or public.is_admin());

create policy "admins insert admin profiles"
on public.admin_profiles
for insert
to authenticated
with check (public.is_admin());

create policy "admins update admin profiles"
on public.admin_profiles
for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "public read active brands"
on public.brands
for select
to anon, authenticated
using (is_active = true);

create policy "admins manage brands"
on public.brands
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "public read active categories"
on public.categories
for select
to anon, authenticated
using (is_active = true);

create policy "admins manage categories"
on public.categories
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "public read active products"
on public.products
for select
to anon, authenticated
using (
  is_active = true
  and exists (
    select 1 from public.brands
    where brands.id = products.brand_id
      and brands.is_active = true
  )
  and exists (
    select 1 from public.categories
    where categories.id = products.category_id
      and categories.is_active = true
  )
);

create policy "admins manage products"
on public.products
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "public read active product images"
on public.product_images
for select
to anon, authenticated
using (
  exists (
    select 1
    from public.products
    join public.brands
      on brands.id = products.brand_id
    join public.categories
      on categories.id = products.category_id
    where products.id = product_images.product_id
      and products.is_active = true
      and brands.is_active = true
      and categories.is_active = true
  )
);

create policy "admins manage product images"
on public.product_images
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "public read store settings"
on public.store_settings
for select
to anon, authenticated
using (true);

create policy "admins manage store settings"
on public.store_settings
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "admins read catalog metadata"
on public.catalog_metadata
for select
to authenticated
using (public.is_admin());

create policy "admins manage catalog metadata"
on public.catalog_metadata
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "admins manage pdf exports"
on public.pdf_exports
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

-- Privilegios de los roles que usa la Data API. RLS continúa siendo la capa
-- que decide qué filas puede leer o modificar cada usuario.
grant usage on schema public to anon, authenticated, service_role;
grant select on all tables in schema public to anon, authenticated;

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

alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

insert into public.store_settings (id)
values (true)
on conflict (id) do nothing;

insert into public.catalog_metadata (id)
values (true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalog-assets',
  'catalog-assets',
  true,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalog-pdfs',
  'catalog-pdfs',
  false,
  52428800,
  array['application/pdf']
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "public read catalog assets"
on storage.objects
for select
to anon, authenticated
using (bucket_id = 'catalog-assets');

create policy "admins insert catalog assets"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'catalog-assets' and public.is_admin());

create policy "admins update catalog assets"
on storage.objects
for update
to authenticated
using (bucket_id = 'catalog-assets' and public.is_admin())
with check (bucket_id = 'catalog-assets' and public.is_admin());

create policy "admins delete catalog assets"
on storage.objects
for delete
to authenticated
using (bucket_id = 'catalog-assets' and public.is_admin());

create policy "admins read catalog pdfs"
on storage.objects
for select
to authenticated
using (bucket_id = 'catalog-pdfs' and public.is_admin());

create policy "admins insert catalog pdfs"
on storage.objects
for insert
to authenticated
with check (bucket_id = 'catalog-pdfs' and public.is_admin());

create policy "admins update catalog pdfs"
on storage.objects
for update
to authenticated
using (bucket_id = 'catalog-pdfs' and public.is_admin())
with check (bucket_id = 'catalog-pdfs' and public.is_admin());

create policy "admins delete catalog pdfs"
on storage.objects
for delete
to authenticated
using (bucket_id = 'catalog-pdfs' and public.is_admin());

commit;
