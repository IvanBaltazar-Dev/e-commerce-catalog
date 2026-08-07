-- Bloque 3 · Migración 4 de 6 — Atribución comercial.
--
-- El objetivo es responder tres preguntas con datos reales: ¿de dónde vino la
-- clienta?, ¿qué terminó comprando?, ¿cuánto ingreso produjo ese origen? No es
-- una plataforma publicitaria: es la cadena visita → conversación → carrito →
-- reserva → venta, conservada sin reescritura.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. FIRST-TOUCH INMUTABLE POR TRIGGER, NO POR CONVENCIÓN. «No sobrescribir
--    Facebook al entrar por WhatsApp» tiene que imponerlo la base: todo campo
--    first_* queda congelado desde el insert, y el UPDATE que lo intente muere
--    con error explícito. El last-touch sí avanza con cada visita.
--
-- B. LA CADENA ES UNA FILA POR RECORRIDO, CERRADA POR SU VENTA. Los enlaces
--    (conversación, carrito, reserva, venta) se ESTABLECEN una vez y no se
--    reasignan: corregir una atribución ligada a una venta reescribiría la
--    historia que las métricas reportan. sale_id es write-once; puesto, la
--    fila queda cerrada y el siguiente recorrido del mismo visitante abre otra.
--
-- C. EL QR NO ES UN MÓDULO. bellaroshe.pe/?source=qr&campaign=vitrina-agosto
--    entra por record_attribution_touch como cualquier UTM: fuentes y campañas
--    son datos, el pipeline es uno.

begin;

-- ---------------------------------------------------------------------------
-- 1. Fuentes y campañas
-- ---------------------------------------------------------------------------

create table public.marketing_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_sources_code_format check (code ~ '^[a-z0-9_]{2,30}$')
);

create trigger marketing_sources_set_updated_at
before update on public.marketing_sources
for each row execute function public.set_updated_at();

create table public.marketing_campaigns (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.marketing_sources(id) on delete restrict,
  channel_id uuid references public.channels(id) on delete restrict,
  name text not null,
  -- El código es lo que viaja en utm_campaign y en el QR.
  code text not null unique,
  external_campaign_id text,
  starts_at date,
  ends_at date,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint marketing_campaigns_name_not_blank check (length(trim(name)) > 0),
  constraint marketing_campaigns_code_format check (code ~ '^[a-z0-9-]{2,60}$'),
  constraint marketing_campaigns_dates_ordered check (
    starts_at is null or ends_at is null or starts_at <= ends_at
  )
);

create index marketing_campaigns_source_idx on public.marketing_campaigns(source_id, is_active);

create trigger marketing_campaigns_set_updated_at
before update on public.marketing_campaigns
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. La cadena de atribución
-- ---------------------------------------------------------------------------

create table public.channel_attributions (
  id uuid primary key default gen_random_uuid(),
  anonymous_visitor_id uuid references public.anonymous_visitors(id) on delete restrict,
  channel_contact_id uuid references public.channel_contacts(id) on delete restrict,
  person_id uuid references public.persons(id) on delete restrict,

  -- PRIMER contacto: congelado por trigger desde el insert.
  first_source_id uuid not null references public.marketing_sources(id) on delete restrict,
  first_campaign_id uuid references public.marketing_campaigns(id) on delete restrict,
  first_channel_id uuid references public.channels(id) on delete restrict,
  first_utm jsonb not null default '{}'::jsonb,
  first_referrer text,
  first_landing_path text,
  first_touch_at timestamptz not null default now(),

  -- ÚLTIMO contacto: avanza con cada visita.
  last_source_id uuid not null references public.marketing_sources(id) on delete restrict,
  last_campaign_id uuid references public.marketing_campaigns(id) on delete restrict,
  last_channel_id uuid references public.channels(id) on delete restrict,
  last_utm jsonb not null default '{}'::jsonb,
  last_touch_at timestamptz not null default now(),

  -- Enlaces de la cadena: se establecen una vez.
  conversation_id uuid references public.channel_conversations(id) on delete restrict,
  cart_id uuid references public.public_carts(id) on delete restrict,
  reservation_id uuid references public.reservations(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_attributions_has_subject check (
    num_nonnulls(anonymous_visitor_id, channel_contact_id, person_id) >= 1
  )
);

-- Un recorrido ABIERTO por sujeto: cerrado con su venta, el siguiente toque
-- abre otro. Es lo que permite que una clienta recurrente tenga N cadenas sin
-- que la segunda compra herede la campaña de la primera.
create unique index channel_attributions_open_visitor_unique
on public.channel_attributions(anonymous_visitor_id)
where anonymous_visitor_id is not null and sale_id is null;

create unique index channel_attributions_open_contact_unique
on public.channel_attributions(channel_contact_id)
where channel_contact_id is not null and sale_id is null;

create unique index channel_attributions_sale_unique
on public.channel_attributions(sale_id) where sale_id is not null;

create index channel_attributions_cart_idx
on public.channel_attributions(cart_id) where cart_id is not null;
create index channel_attributions_conversation_idx
on public.channel_attributions(conversation_id) where conversation_id is not null;
create index channel_attributions_campaign_idx
on public.channel_attributions(first_campaign_id) where first_campaign_id is not null;
create index channel_attributions_touch_idx
on public.channel_attributions(first_touch_at desc);

create trigger channel_attributions_set_updated_at
before update on public.channel_attributions
for each row execute function public.set_updated_at();

comment on table public.channel_attributions is
  'Cadena visita → conversación → carrito → reserva → venta. first_* es '
  'inmutable por trigger; sale_id es write-once y cierra el recorrido.';

-- Decisión A y B: la base impone lo que las métricas prometen.
create or replace function public.protect_attribution_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.first_source_id   is distinct from old.first_source_id
     or new.first_campaign_id is distinct from old.first_campaign_id
     or new.first_channel_id  is distinct from old.first_channel_id
     or new.first_utm         is distinct from old.first_utm
     or new.first_referrer    is distinct from old.first_referrer
     or new.first_landing_path is distinct from old.first_landing_path
     or new.first_touch_at    is distinct from old.first_touch_at then
    raise exception using
      errcode = '23514',
      message = 'El primer contacto no se reescribe: entrar por WhatsApp no borra que llegó por Facebook.';
  end if;

  if old.sale_id is not null and new.sale_id is distinct from old.sale_id then
    raise exception using
      errcode = '23514',
      message = 'Una atribución ligada a una venta no se reasigna.';
  end if;

  if (old.conversation_id is not null and new.conversation_id is distinct from old.conversation_id)
     or (old.cart_id is not null and new.cart_id is distinct from old.cart_id)
     or (old.reservation_id is not null and new.reservation_id is distinct from old.reservation_id) then
    raise exception using
      errcode = '23514',
      message = 'Los enlaces de la cadena se establecen una vez; corregir exige una operación administrativa nueva.';
  end if;

  return new;
end;
$$;

revoke all on function public.protect_attribution_history() from public, anon;

create trigger channel_attributions_protect_history
before update on public.channel_attributions
for each row execute function public.protect_attribution_history();

-- ---------------------------------------------------------------------------
-- 3. Contratos
-- ---------------------------------------------------------------------------

-- El toque: primera visita crea la cadena, las siguientes solo avanzan el
-- last-touch. Superficie PÚBLICA (la landing lo llama con la cookie), con el
-- visitante como única llave.
create or replace function public.record_attribution_touch(
  p_visitor_id uuid,
  p_source_code text default null,
  p_campaign_code text default null,
  p_utm jsonb default '{}'::jsonb,
  p_referrer text default null,
  p_landing_path text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  source_id uuid;
  campaign public.marketing_campaigns%rowtype;
  resolved_channel uuid;
  attribution_id uuid;
begin
  if not exists (select 1 from public.anonymous_visitors where id = p_visitor_id) then
    raise exception using errcode = '22023', message = 'El visitante no existe.';
  end if;

  -- La fuente declarada, o unknown: jamás se inventa una.
  select id into source_id from public.marketing_sources
  where code = coalesce(nullif(trim(coalesce(p_source_code, '')), ''), 'unknown') and is_active;

  if source_id is null then
    select id into source_id from public.marketing_sources where code = 'unknown';
  end if;

  if p_campaign_code is not null then
    select * into campaign from public.marketing_campaigns
    where code = lower(trim(p_campaign_code)) and is_active;
  end if;

  -- El canal se deriva de la fuente cuando coinciden por código (instagram,
  -- whatsapp…); una fuente sin canal homónimo queda sin canal, no con uno falso.
  select id into resolved_channel from public.channels
  where code = coalesce((select code from public.marketing_sources where id = source_id), '');

  perform pg_advisory_xact_lock(hashtextextended('attribution:' || p_visitor_id::text, 0));

  select id into attribution_id
  from public.channel_attributions
  where anonymous_visitor_id = p_visitor_id and sale_id is null;

  if attribution_id is null then
    insert into public.channel_attributions (
      anonymous_visitor_id,
      first_source_id, first_campaign_id, first_channel_id,
      first_utm, first_referrer, first_landing_path,
      last_source_id, last_campaign_id, last_channel_id, last_utm
    ) values (
      p_visitor_id,
      source_id, campaign.id, coalesce(campaign.channel_id, resolved_channel),
      coalesce(p_utm, '{}'::jsonb), left(p_referrer, 1000), left(p_landing_path, 500),
      source_id, campaign.id, coalesce(campaign.channel_id, resolved_channel),
      coalesce(p_utm, '{}'::jsonb)
    )
    returning id into attribution_id;
  else
    update public.channel_attributions
    set last_source_id = source_id,
        last_campaign_id = campaign.id,
        last_channel_id = coalesce(campaign.channel_id, resolved_channel),
        last_utm = coalesce(p_utm, '{}'::jsonb),
        last_touch_at = now()
    where id = attribution_id;
  end if;

  return attribution_id;
end;
$$;

-- Enlaza la cadena. Cada eslabón se establece una vez; el mismo valor es
-- idempotente; sale_id cierra el recorrido.
create or replace function public.attach_attribution(
  p_visitor_id uuid default null,
  p_contact_id uuid default null,
  p_conversation_id uuid default null,
  p_cart_id uuid default null,
  p_reservation_id uuid default null,
  p_sale_id uuid default null,
  p_source_code text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  attribution public.channel_attributions%rowtype;
  source_id uuid;
  subject_key text;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo enlaza atribuciones.';
  end if;

  if p_visitor_id is null and p_contact_id is null then
    raise exception using errcode = '22023', message = 'La atribución necesita visitante o contacto.';
  end if;

  subject_key := coalesce(p_visitor_id::text, p_contact_id::text);
  perform pg_advisory_xact_lock(hashtextextended('attribution:' || subject_key, 0));

  select * into attribution
  from public.channel_attributions
  where sale_id is null
    and ((p_visitor_id is not null and anonymous_visitor_id = p_visitor_id)
      or (p_visitor_id is null and channel_contact_id = p_contact_id))
  order by created_at desc
  limit 1;

  -- Recorrido que nace fuera de la web (WhatsApp directo): la cadena se abre
  -- aquí con la fuente del canal.
  if attribution.id is null then
    select id into source_id from public.marketing_sources
    where code = coalesce(nullif(trim(coalesce(p_source_code, '')), ''), 'direct') and is_active;

    if source_id is null then
      select id into source_id from public.marketing_sources where code = 'unknown';
    end if;

    insert into public.channel_attributions (
      anonymous_visitor_id, channel_contact_id,
      first_source_id, last_source_id,
      first_channel_id, last_channel_id
    ) values (
      p_visitor_id, p_contact_id,
      source_id, source_id,
      (select id from public.channels where code = coalesce(p_source_code, 'manual')),
      (select id from public.channels where code = coalesce(p_source_code, 'manual'))
    )
    returning * into attribution;
  end if;

  update public.channel_attributions
  set channel_contact_id = coalesce(channel_attributions.channel_contact_id, p_contact_id),
      person_id = coalesce(channel_attributions.person_id,
                           (select person_id from public.channel_contacts where id = p_contact_id)),
      conversation_id = coalesce(channel_attributions.conversation_id, p_conversation_id),
      cart_id = coalesce(channel_attributions.cart_id, p_cart_id),
      reservation_id = coalesce(channel_attributions.reservation_id, p_reservation_id),
      sale_id = coalesce(channel_attributions.sale_id, p_sale_id)
  where id = attribution.id;

  return attribution.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS y privilegios
-- ---------------------------------------------------------------------------
-- La atribución es inteligencia comercial: administración la lee, el público
-- jamás, y las escrituras pasan por los contratos.

alter table public.marketing_sources enable row level security;
alter table public.marketing_campaigns enable row level security;
alter table public.channel_attributions enable row level security;

create policy "staff read sources" on public.marketing_sources
for select to authenticated using (public.is_staff());

create policy "admins manage sources" on public.marketing_sources
for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "staff read campaigns" on public.marketing_campaigns
for select to authenticated using (public.is_staff());

create policy "admins manage campaigns" on public.marketing_campaigns
for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "admins read attributions" on public.channel_attributions
for select to authenticated using (public.is_admin());

grant select on public.marketing_sources, public.marketing_campaigns to authenticated;
grant insert, update, delete on public.marketing_sources, public.marketing_campaigns to authenticated;
grant select on public.channel_attributions to authenticated;
grant select, insert, update, delete on
  public.marketing_sources, public.marketing_campaigns, public.channel_attributions
to service_role;

revoke all on public.channel_attributions from anon;
revoke truncate on public.marketing_sources, public.marketing_campaigns,
  public.channel_attributions
from anon, authenticated, service_role;

revoke all on function public.record_attribution_touch(uuid, text, text, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.attach_attribution(uuid, uuid, uuid, uuid, uuid, uuid, text) from public, anon;

grant execute on function public.record_attribution_touch(uuid, text, text, jsonb, text, text) to anon, authenticated, service_role;
grant execute on function public.attach_attribution(uuid, uuid, uuid, uuid, uuid, uuid, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Auditoría y datos de referencia
-- ---------------------------------------------------------------------------
-- Campañas y fuentes son decisiones administrativas: se auditan. La atribución
-- es un libro protegido por su propio trigger de historia.

select public.attach_audit('public.marketing_sources');
select public.attach_audit('public.marketing_campaigns');

insert into public.marketing_sources (code, name) values
  ('organic',   'Orgánico'),
  ('direct',    'Directo'),
  ('whatsapp',  'WhatsApp'),
  ('instagram', 'Instagram'),
  ('facebook',  'Facebook'),
  ('tiktok',    'TikTok'),
  ('referral',  'Referencia'),
  ('qr',        'Código QR'),
  ('paid',      'Publicidad pagada'),
  ('unknown',   'Desconocido')
on conflict (code) do nothing;

commit;
