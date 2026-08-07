-- Bloque 3 · Migración 1 de 6 — Canales, cuentas, contactos e identidad.
--
-- La capa omnicanal NO es un segundo motor comercial: ventas, reservas,
-- precios, existencias, pagos y caja siguen siendo del Bloque 2. Aquí se
-- modela ÚNICAMENTE por dónde llega la clienta y quién es.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA Y QUE EL PLAN DEJABA ABIERTAS:
--
-- A. `persons` EXISTE COMO TABLA. El plan referencia person_id en contactos y
--    carritos pero nunca define la entidad. Sin ella, «una misma persona con
--    WhatsApp, Instagram y web» no tiene dónde converger. Se crea mínima: la
--    identidad es un punto de encuentro, no un CRM.
--
-- B. CANAL COMO DATO, NO COMO ENUM. Un enum de PostgreSQL exige migración por
--    cada canal nuevo, y el plan pide extensibilidad. `channels` es una tabla
--    de referencia con flags de capacidad; el código de aplicación resuelve por
--    `code`, nunca por posición.
--
-- C. LA HISTORIA DE VINCULACIÓN ES UNA TABLA PROPIA, NO EL LOG DE AUDITORÍA.
--    `anonymous_visitors.last_seen_at` cambia en cada visita: colgarle el
--    trigger de auditoría inundaría audit_log con millones de filas sin valor.
--    Se excluye del bucle y la única transición que importa —visitante ↔
--    persona— queda en `visitor_identity_links`, append-only, con actor y
--    motivo. La historia anónima nunca se reemplaza ni se borra.

begin;

-- ---------------------------------------------------------------------------
-- 1. Personas
-- ---------------------------------------------------------------------------

create table public.persons (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  -- Solo dígitos, con código de país cuando se conoce. La normalización vive
  -- en normalize_phone() para que dos escrituras del mismo número converjan.
  phone_normalized text,
  document_number text,
  email text,
  notes text,
  -- Fusión CONTROLADA y futura: nunca automática por similitud de nombre.
  merged_into_person_id uuid references public.persons(id) on delete restrict,
  merged_at timestamptz,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint persons_name_not_blank check (length(trim(full_name)) > 0),
  constraint persons_phone_digits check (phone_normalized is null or phone_normalized ~ '^[0-9]{6,15}$'),
  constraint persons_merge_consistent check ((merged_into_person_id is null) = (merged_at is null)),
  constraint persons_no_self_merge check (merged_into_person_id is distinct from id)
);

-- Única entre personas VIGENTES: una fusionada conserva su teléfono histórico
-- sin bloquear a la persona que la absorbió.
create unique index persons_phone_unique
on public.persons(phone_normalized)
where phone_normalized is not null and merged_into_person_id is null;

create index persons_name_trgm on public.persons using gin (full_name gin_trgm_ops);

create trigger persons_set_updated_at
before update on public.persons
for each row execute function public.set_updated_at();

comment on table public.persons is
  'Punto de convergencia de identidad entre canales. Mínima a propósito: no es '
  'un CRM. La fusión es una operación administrativa auditada, nunca automática.';

create or replace function public.normalize_phone(p_raw text)
returns text
language sql
immutable
set search_path = ''
as $$
  -- Solo dígitos. Un móvil peruano de 9 dígitos se prefija con 51 para que
  -- «+51 999 888 777», «999888777» y «51999888777» converjan en la misma clave.
  select case
    when digits = '' then null
    when length(digits) = 9 and digits ~ '^9' then '51' || digits
    else digits
  end
  from (select regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') as digits) t;
$$;

revoke all on function public.normalize_phone(text) from public;
grant execute on function public.normalize_phone(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Visitante anónimo
-- ---------------------------------------------------------------------------
-- La web soporta carrito ANTES de cualquier identificación. El identificador es
-- opaco (uuid aleatorio) y viaja en una cookie; no revela nada y no se puede
-- enumerar.

create table public.anonymous_visitors (
  id uuid primary key default gen_random_uuid(),
  person_id uuid references public.persons(id) on delete restrict,
  first_landing_path text,
  first_referrer text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  visits integer not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  constraint anonymous_visitors_visits_positive check (visits > 0)
);

create index anonymous_visitors_person_idx
on public.anonymous_visitors(person_id) where person_id is not null;

comment on table public.anonymous_visitors is
  'Identidad web previa al login. Se conserva SIEMPRE: identificar a la persona '
  'añade el vínculo, nunca reescribe ni borra la historia anónima. Fuera del '
  'bucle de auditoría a propósito: last_seen_at cambia en cada visita.';

-- Historia de vinculación: append-only, con actor y motivo.
create table public.visitor_identity_links (
  id uuid primary key default gen_random_uuid(),
  anonymous_visitor_id uuid not null references public.anonymous_visitors(id) on delete restrict,
  person_id uuid not null references public.persons(id) on delete restrict,
  reason text not null,
  linked_by uuid,
  linked_by_label text,
  created_at timestamptz not null default now(),
  constraint visitor_identity_links_reason_not_blank check (length(trim(reason)) > 0)
);

create index visitor_identity_links_visitor_idx on public.visitor_identity_links(anonymous_visitor_id);
create index visitor_identity_links_person_idx on public.visitor_identity_links(person_id);

create trigger visitor_identity_links_no_update
before update on public.visitor_identity_links
for each row execute function public.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- 3. Canales
-- ---------------------------------------------------------------------------

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  -- Texto validado por formato, NO enum: un canal nuevo es un INSERT, no una
  -- migración. La aplicación resuelve por code.
  channel_type text not null,
  is_active boolean not null default true,
  supports_messages boolean not null default false,
  supports_cart boolean not null default false,
  supports_external_identity boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channels_code_format check (code ~ '^[a-z0-9_]{2,30}$'),
  constraint channels_type_format check (channel_type ~ '^[a-z_]{2,30}$')
);

create trigger channels_set_updated_at
before update on public.channels
for each row execute function public.set_updated_at();

create table public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete restrict,
  -- Nula para cuentas globales (la web pública no pertenece a una sede).
  branch_id uuid references public.branches(id) on delete restrict,
  display_name text not null,
  external_account_id text,
  username text,
  is_active boolean not null default true,
  -- SOLO configuración no sensible. Los tokens de Meta/TikTok viven en
  -- variables de entorno del servidor, jamás en columnas.
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_accounts_name_not_blank check (length(trim(display_name)) > 0)
);

create unique index channel_accounts_external_unique
on public.channel_accounts(channel_id, external_account_id)
where external_account_id is not null;

create index channel_accounts_channel_idx on public.channel_accounts(channel_id, is_active);

create trigger channel_accounts_set_updated_at
before update on public.channel_accounts
for each row execute function public.set_updated_at();

comment on column public.channel_accounts.settings is
  'Configuración NO sensible (colores, plantillas, horarios). Tokens y secretos '
  'de proveedor van en el entorno del servidor, nunca aquí.';

create table public.channel_contacts (
  id uuid primary key default gen_random_uuid(),
  channel_account_id uuid not null references public.channel_accounts(id) on delete restrict,
  person_id uuid references public.persons(id) on delete restrict,
  anonymous_visitor_id uuid references public.anonymous_visitors(id) on delete restrict,
  -- Identidad del proveedor: wa_id, PSID/IGSID, open_id… La clave de
  -- idempotencia de todo webhook de contacto.
  external_contact_id text not null,
  display_name text,
  phone_normalized text,
  username text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_contacts_external_not_blank check (length(trim(external_contact_id)) > 0),
  constraint channel_contacts_phone_digits check (phone_normalized is null or phone_normalized ~ '^[0-9]{6,15}$'),
  constraint channel_contacts_external_unique unique (channel_account_id, external_contact_id)
);

create index channel_contacts_person_idx on public.channel_contacts(person_id) where person_id is not null;
create index channel_contacts_phone_idx on public.channel_contacts(phone_normalized) where phone_normalized is not null;
create index channel_contacts_visitor_idx on public.channel_contacts(anonymous_visitor_id) where anonymous_visitor_id is not null;

create trigger channel_contacts_set_updated_at
before update on public.channel_contacts
for each row execute function public.set_updated_at();

comment on table public.channel_contacts is
  'Identidad externa de la clienta en un canal. Una persona puede tener varios '
  'contactos (WhatsApp, Instagram, web). NUNCA se fusionan automáticamente por '
  'similitud de nombre: la vinculación es explícita y auditada.';

-- ---------------------------------------------------------------------------
-- 4. Contratos
-- ---------------------------------------------------------------------------

-- Superficie PÚBLICA de la web: crea o refresca la identidad anónima. DEFINER
-- con execute a anon; los límites de longitud son la guarda contra abuso.
create or replace function public.touch_anonymous_visitor(
  p_visitor_id uuid default null,
  p_landing_path text default null,
  p_referrer text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  visitor_id uuid;
begin
  if p_visitor_id is not null then
    update public.anonymous_visitors
    set last_seen_at = now(), visits = visits + 1
    where id = p_visitor_id
    returning id into visitor_id;

    if visitor_id is not null then
      return visitor_id;
    end if;
    -- Cookie huérfana (base reiniciada, visitante borrado): se emite una nueva
    -- identidad en lugar de fallar la visita.
  end if;

  insert into public.anonymous_visitors (first_landing_path, first_referrer)
  values (left(p_landing_path, 500), left(p_referrer, 1000))
  returning id into visitor_id;

  return visitor_id;
end;
$$;

-- Vincula un visitante con una persona. La PRIMERA vinculación la hace el
-- personal; cambiar una existente es corrección administrativa. La historia
-- queda en visitor_identity_links pase lo que pase.
create or replace function public.link_visitor_to_person(
  p_visitor_id uuid,
  p_person_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  current_person uuid;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede vincular identidades.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'La vinculación exige un motivo.';
  end if;

  select person_id into current_person
  from public.anonymous_visitors where id = p_visitor_id for update;

  if not found then
    raise exception using errcode = '22023', message = 'El visitante no existe.';
  end if;

  if current_person is not null and current_person <> p_person_id then
    if auth.uid() is not null and not public.is_admin() then
      raise exception using errcode = '42501',
        message = 'El visitante ya está vinculado a otra persona: corregirlo es una operación administrativa.';
    end if;
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  update public.anonymous_visitors set person_id = p_person_id where id = p_visitor_id;

  insert into public.visitor_identity_links (
    anonymous_visitor_id, person_id, reason, linked_by, linked_by_label
  ) values (p_visitor_id, p_person_id, trim(p_reason), actor, actor_name);
end;
$$;

-- Encuentra o crea la persona de un teléfono. Es lo que usa la ingesta de
-- WhatsApp: el número ES la identidad natural de ese canal.
create or replace function public.ensure_person_for_phone(
  p_phone text,
  p_display_name text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := public.normalize_phone(p_phone);
  person_id uuid;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede registrar personas.';
  end if;

  if normalized is null then
    raise exception using errcode = '22023', message = 'El teléfono no contiene dígitos suficientes.';
  end if;

  -- Serializa dos ingestas simultáneas del mismo número: sin esto, dos webhooks
  -- concurrentes crean dos personas y el índice único mata al segundo DESPUÉS
  -- de haber hecho trabajo.
  perform pg_advisory_xact_lock(hashtextextended('person-phone:' || normalized, 0));

  select id into person_id
  from public.persons
  where phone_normalized = normalized and merged_into_person_id is null;

  if person_id is not null then
    return person_id;
  end if;

  insert into public.persons (full_name, phone_normalized, created_by, created_by_label)
  values (
    coalesce(nullif(trim(coalesce(p_display_name, '')), ''), 'Clienta ' || right(normalized, 3)),
    normalized,
    auth.uid(),
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = auth.uid())
  )
  returning id into person_id;

  return person_id;
end;
$$;

-- Encuentra o crea el contacto de un canal. Clave de idempotencia:
-- (cuenta, identidad externa). Dos webhooks del mismo contacto convergen.
create or replace function public.ensure_channel_contact(
  p_channel_account_id uuid,
  p_external_contact_id text,
  p_display_name text default null,
  p_phone text default null,
  p_username text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  normalized text := public.normalize_phone(p_phone);
  contact_id uuid;
  linked_person uuid;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede registrar contactos.';
  end if;

  if nullif(trim(coalesce(p_external_contact_id, '')), '') is null then
    raise exception using errcode = '22023', message = 'Falta la identidad externa del contacto.';
  end if;

  -- El teléfono vincula a la persona SOLO cuando es identidad del canal
  -- (WhatsApp). Un nombre parecido jamás vincula nada.
  if normalized is not null then
    linked_person := public.ensure_person_for_phone(normalized, p_display_name);
  end if;

  insert into public.channel_contacts as c (
    channel_account_id, external_contact_id, display_name, phone_normalized, username, person_id
  ) values (
    p_channel_account_id, trim(p_external_contact_id),
    nullif(trim(coalesce(p_display_name, '')), ''),
    normalized,
    nullif(trim(coalesce(p_username, '')), ''),
    linked_person
  )
  on conflict (channel_account_id, external_contact_id) do update set
    display_name = coalesce(excluded.display_name, c.display_name),
    phone_normalized = coalesce(excluded.phone_normalized, c.phone_normalized),
    username = coalesce(excluded.username, c.username),
    -- La persona solo se ESTABLECE, nunca se sobrescribe desde una ingesta:
    -- corregir un vínculo existente es operación administrativa aparte.
    person_id = coalesce(c.person_id, excluded.person_id),
    updated_at = now()
  returning id into contact_id;

  return contact_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------

alter table public.persons enable row level security;
alter table public.anonymous_visitors enable row level security;
alter table public.visitor_identity_links enable row level security;
alter table public.channels enable row level security;
alter table public.channel_accounts enable row level security;
alter table public.channel_contacts enable row level security;

-- La identidad es dato del personal: el público NUNCA lee estas tablas
-- directamente; su superficie es touch_anonymous_visitor.
create policy "staff read persons" on public.persons
for select to authenticated using (public.is_staff());

create policy "staff create persons" on public.persons
for insert to authenticated with check (public.is_staff());

create policy "admins correct persons" on public.persons
for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins read visitors" on public.anonymous_visitors
for select to authenticated using (public.is_admin());

create policy "staff read identity links" on public.visitor_identity_links
for select to authenticated using (public.is_staff());

create policy "staff read channels" on public.channels
for select to authenticated using (public.is_staff());

create policy "admins manage channels" on public.channels
for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "staff read channel accounts" on public.channel_accounts
for select to authenticated using (public.is_staff());

create policy "admins manage channel accounts" on public.channel_accounts
for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- Contactos: PII. Por ahora solo administración lee; 0036 amplía a la
-- vendedora POR SUS CONVERSACIONES, no en bloque.
create policy "admins read channel contacts" on public.channel_contacts
for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- 6. Privilegios
-- ---------------------------------------------------------------------------

grant select, insert, update on public.persons to authenticated;
grant select on public.visitor_identity_links to authenticated;
grant select on public.anonymous_visitors to authenticated;
grant select, insert, update, delete on public.channels to authenticated;
grant select, insert, update, delete on public.channel_accounts to authenticated;
grant select on public.channel_contacts to authenticated;

grant select, insert, update, delete on
  public.persons, public.anonymous_visitors, public.visitor_identity_links,
  public.channels, public.channel_accounts, public.channel_contacts
to service_role;

revoke truncate on public.persons, public.anonymous_visitors,
  public.visitor_identity_links, public.channels, public.channel_accounts,
  public.channel_contacts
from anon, authenticated, service_role;

-- El ACL por defecto concede EXECUTE a todos sobre toda función nueva: se
-- revoca y se abre solo lo deliberado. touch_anonymous_visitor es la ÚNICA
-- función de esta migración alcanzable por anon.
revoke all on function public.touch_anonymous_visitor(uuid, text, text) from public, anon, authenticated;
revoke all on function public.link_visitor_to_person(uuid, uuid, text) from public, anon;
revoke all on function public.ensure_person_for_phone(text, text) from public, anon;
revoke all on function public.ensure_channel_contact(uuid, text, text, text, text) from public, anon;

grant execute on function public.touch_anonymous_visitor(uuid, text, text) to anon, authenticated, service_role;
grant execute on function public.link_visitor_to_person(uuid, uuid, text) to authenticated, service_role;
grant execute on function public.ensure_person_for_phone(text, text) to authenticated, service_role;
grant execute on function public.ensure_channel_contact(uuid, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Auditoría
-- ---------------------------------------------------------------------------
-- anonymous_visitors queda FUERA a propósito (ver decisión C de la cabecera).
-- visitor_identity_links ya es append-only por trigger propio.

select public.attach_audit('public.persons');
select public.attach_audit('public.channels');
select public.attach_audit('public.channel_accounts');
select public.attach_audit('public.channel_contacts');

-- ---------------------------------------------------------------------------
-- 8. Datos de referencia
-- ---------------------------------------------------------------------------
-- Los siete canales del plan. Idempotente: un reset o una reaplicación no
-- duplica nada.

insert into public.channels (code, name, channel_type, supports_messages, supports_cart, supports_external_identity)
values
  ('web',       'Web pública',        'web',       false, true,  true),
  ('whatsapp',  'WhatsApp',           'messaging', true,  true,  true),
  ('facebook',  'Facebook',           'messaging', true,  true,  true),
  ('instagram', 'Instagram',          'messaging', true,  true,  true),
  ('tiktok',    'TikTok',             'social',    false, true,  true),
  ('store',     'Tienda',             'in_person', false, true,  false),
  ('manual',    'Registro manual',    'manual',    false, true,  false)
on conflict (code) do nothing;

-- Dos cuentas iniciales: la web pública (global, sin sede) y la atención en
-- tienda sobre la sede principal. Las cuentas reales de WhatsApp/Meta/TikTok
-- se registran desde el panel cuando existan credenciales.
insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select c.id, null, 'Web pública', 'web-public'
from public.channels c
where c.code = 'web'
on conflict (channel_id, external_account_id) where external_account_id is not null do nothing;

insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
select c.id, b.id, 'Atención en tienda', 'store-main'
from public.channels c
cross join lateral (
  select id from public.branches where is_active and is_default limit 1
) b
where c.code = 'store'
on conflict (channel_id, external_account_id) where external_account_id is not null do nothing;

commit;
