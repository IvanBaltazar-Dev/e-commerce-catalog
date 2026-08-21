-- 0143 · La notificación sanitaria NO identifica un producto.
--
-- Esta migración existe por un error que habría sido peor que el de CHE011.
--
-- `NSOC50594-21PE` aparece asociada públicamente a productos comerciales
-- distintos de REVE'L: Lip Gloss, Lip Tint Hydrating, Hot Matte & Lip Plumper,
-- Lip Gloss Glow — y a códigos SH-* diferentes. Es una notificación sanitaria
-- que ampara un GRUPO, no un artículo.
--
-- Tratarla como identificador habría fusionado media docena de productos
-- distintos en uno solo, con sus fotos, precios y presentaciones mezclados. Y a
-- diferencia del choque CHE011 —que se veía porque un labial no se parece a un
-- gel paint— aquí todos los productos SON de la misma familia, así que el error
-- habría pasado desapercibido mucho más tiempo.
--
-- Por eso la NSO vive en su propia tabla, con relación muchos-a-muchos y con
-- jurisdicción y fecha. Nunca en variant_identifiers.

begin;

create table if not exists public.regulatory_notifications (
  id uuid primary key default gen_random_uuid(),

  -- El código tal como lo publica la autoridad o lo declara el documento.
  value text not null,
  -- Una NSO peruana y una argentina pueden escribirse igual y no son la misma.
  jurisdiction char(2) not null,
  authority text not null,
  notification_kind text not null default 'sanitary_notification',

  -- Qué se sabe de su alcance. Casi siempre «desconocido» al observarla, y eso
  -- es un hecho útil: significa que no se puede deducir a cuántos productos
  -- ampara.
  scope text not null default 'unknown',
  effective_date date,
  expires_at date,
  current_status text not null default 'observed',

  source_id uuid references public.catalog_sources(id) on delete set null,
  source_record_id uuid references public.catalog_source_records(id) on delete set null,
  source_url text,
  observed_at timestamptz not null default now(),
  raw_excerpt text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint regulatory_notifications_value_not_blank check (length(trim(value)) > 0),
  constraint regulatory_notifications_kind_allowed check (notification_kind in (
    'sanitary_notification', 'sanitary_registration', 'import_permit',
    'prohibition', 'alert', 'recall'
  )),
  constraint regulatory_notifications_scope_allowed check (scope in (
    'unknown', 'single_product', 'product_family', 'brand_range'
  )),
  constraint regulatory_notifications_status_allowed check (current_status in (
    'observed', 'active', 'expired', 'revoked', 'superseded'
  )),
  constraint regulatory_notifications_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint regulatory_notifications_unica unique (value, jurisdiction, authority)
);

comment on table public.regulatory_notifications is
  'Notificación o registro sanitario observado. NUNCA es un identificador de '
  'producto: NSOC50594-21PE ampara al menos cuatro productos REVE´L distintos.';
comment on column public.regulatory_notifications.scope is
  'Cuántos productos ampara. «unknown» mientras no se lea el acto administrativo '
  'que lo dice — deducirlo del número de productos observados sería inventar.';

-- La relación es muchos a muchos, y por eso vive en su propia tabla.
create table if not exists public.regulatory_notification_subjects (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.regulatory_notifications(id) on delete cascade,

  reference_product_id uuid references public.catalog_reference_products(id) on delete cascade,
  reference_variant_id uuid references public.catalog_reference_variants(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,

  -- El código con el que el documento nombraba al producto, tal cual.
  declared_code text,
  declared_name text,
  source_record_id uuid references public.catalog_source_records(id) on delete set null,
  observed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint regulatory_notification_subjects_un_objetivo
    check (num_nonnulls(reference_product_id, reference_variant_id, product_id, variant_id) = 1),
  constraint regulatory_notification_subjects_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index if not exists regulatory_notification_subjects_notif_idx
  on public.regulatory_notification_subjects (notification_id);
create index if not exists regulatory_notifications_valor_idx
  on public.regulatory_notifications (jurisdiction, upper(value));

-- Cuántos sujetos distintos ampara cada notificación observada. Es la vista que
-- impide volver a creer que una NSO identifica un producto.
create or replace view public.regulatory_notification_reach_v1
with (security_invoker = true) as
select
  n.value, n.jurisdiction, n.authority, n.scope, n.current_status,
  count(s.id) as sujetos_observados,
  count(distinct s.declared_code) filter (where s.declared_code is not null) as codigos_distintos,
  array_agg(distinct s.declared_code) filter (where s.declared_code is not null) as codigos
from public.regulatory_notifications n
left join public.regulatory_notification_subjects s on s.notification_id = n.id
group by n.id, n.value, n.jurisdiction, n.authority, n.scope, n.current_status;

comment on view public.regulatory_notification_reach_v1 is
  'Cuántos productos y códigos distintos ampara cada notificación. Más de uno '
  'significa que la NSO no puede usarse como identidad.';

alter table public.regulatory_notifications enable row level security;
alter table public.regulatory_notification_subjects enable row level security;
create policy "admins manage regulatory notifications" on public.regulatory_notifications
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage regulatory subjects" on public.regulatory_notification_subjects
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select on public.regulatory_notifications to authenticated, service_role;
grant select on public.regulatory_notification_subjects to authenticated, service_role;
grant select on public.regulatory_notification_reach_v1 to authenticated, service_role;

commit;

-- Corregido al ingerir las primeras declaraciones: un sujeto sin objetivo
-- resuelto pero con código declarado es el estado NORMAL al observar. La
-- declaración nombró «SH-577» y todavía no sabemos qué producto nuestro es;
-- exigir el objetivo obligaba a resolver la identidad antes de poder guardar la
-- observación, que invierte el orden de todo el sistema.
alter table public.regulatory_notification_subjects
  drop constraint if exists regulatory_notification_subjects_un_objetivo;
alter table public.regulatory_notification_subjects
  add constraint regulatory_notification_subjects_un_objetivo
  check (
    num_nonnulls(reference_product_id, reference_variant_id, product_id, variant_id) = 1
    or (num_nonnulls(reference_product_id, reference_variant_id, product_id, variant_id) = 0
        and declared_code is not null and length(trim(declared_code)) > 0)
  );
