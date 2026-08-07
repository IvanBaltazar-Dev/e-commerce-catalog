-- Bloque 3 · Migración 2 de 6 — Conversaciones, mensajes y eventos de canal.
--
-- UNA capa de conversación para todos los canales: no existen
-- whatsapp_messages ni instagram_messages. La diferencia entre proveedores
-- pertenece al borde de integración (adaptadores en Node), nunca al modelo.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. LA CONVERSACIÓN ABIERTA ES ÚNICA POR (CUENTA, CONTACTO), Y LO IMPONE UN
--    ÍNDICE, NO UNA CONVENCIÓN. Dos webhooks simultáneos del mismo contacto
--    deben converger en UNA conversación con DOS mensajes. ensure_conversation
--    serializa con candado consultivo y el índice parcial es el cinturón: si
--    alguna ruta futura se salta el candado, la segunda inserción muere en vez
--    de duplicar la bandeja.
--
-- B. LOS MENSAJES SON INMUTABLES SALVO SU CICLO DE ENTREGA. Nadie reescribe lo
--    que se dijo: un trigger bloquea todo cambio excepto status (el proveedor
--    confirma entregado/leído), media_asset_id (el medio se descarga después) y
--    metadata. El estado además solo avanza: un «delivered» tardío no degrada
--    un «read» ya registrado.
--
-- C. UN SOLO LIBRO DE EVENTOS. channel_events absorbe los eventos de carrito y
--    de dominio con referencia polimórfica SIN FK —el precedente exacto del
--    kardex—, porque un libro histórico no puede impedir que sus orígenes
--    evolucionen, y dos libros append-only paralelos serían la duplicación que
--    el propio plan prohíbe.

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------
-- Estados de máquinas internas: enum, como sales y reservations. El TIPO de
-- mensaje en cambio es texto validado: los proveedores añaden formatos nuevos
-- y un enum obligaría a migrar por cada sticker.

create type public.conversation_status as enum ('open', 'pending', 'closed', 'archived');

create type public.message_direction as enum ('inbound', 'outbound');

create type public.message_delivery_status as enum (
  'received', 'queued', 'sent', 'delivered', 'read', 'failed'
);

-- ---------------------------------------------------------------------------
-- 1. Conversaciones
-- ---------------------------------------------------------------------------

create table public.channel_conversations (
  id uuid primary key default gen_random_uuid(),
  channel_account_id uuid not null references public.channel_accounts(id) on delete restrict,
  channel_contact_id uuid not null references public.channel_contacts(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  status public.conversation_status not null default 'open',
  -- Puntero VIGENTE. El historial de asignación llega en 0039: aquí solo vive
  -- quién atiende ahora.
  assigned_user_id uuid,
  assigned_user_label text,
  external_conversation_id text,
  opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by uuid,
  closed_by_label text,
  close_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El estado de conversación NUNCA se mezcla con el estado de venta.
  constraint channel_conversations_close_consistent check (
    (status in ('closed', 'archived')) = (closed_at is not null)
  )
);

-- El cinturón de la decisión A: una sola conversación VIVA por contacto y
-- cuenta. Cerrada o archivada, se puede abrir otra.
create unique index channel_conversations_live_unique
on public.channel_conversations(channel_account_id, channel_contact_id)
where status in ('open', 'pending');

create unique index channel_conversations_external_unique
on public.channel_conversations(channel_account_id, external_conversation_id)
where external_conversation_id is not null;

create index channel_conversations_inbox_idx
on public.channel_conversations(branch_id, status, last_activity_at desc);
create index channel_conversations_assigned_idx
on public.channel_conversations(assigned_user_id, last_activity_at desc)
where assigned_user_id is not null;
create index channel_conversations_contact_idx
on public.channel_conversations(channel_contact_id, opened_at desc);

create trigger channel_conversations_set_updated_at
before update on public.channel_conversations
for each row execute function public.set_updated_at();

comment on table public.channel_conversations is
  'Hilo de atención por canal. El estado comercial (carrito, reserva, venta) '
  'vive en sus propios dominios y se referencia por eventos, nunca al revés.';

-- ---------------------------------------------------------------------------
-- 2. Mensajes
-- ---------------------------------------------------------------------------

create table public.channel_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.channel_conversations(id) on delete restrict,
  -- Denormalizada a propósito: la idempotencia del plan es «por
  -- proveedor/cuenta/mensaje externo», y resolverla por join en cada webhook
  -- pondría el índice único al otro lado de una indirección.
  channel_account_id uuid not null references public.channel_accounts(id) on delete restrict,
  direction public.message_direction not null,
  message_type text not null default 'text',
  external_message_id text,
  sender_external_id text,
  body text,
  media_asset_id uuid references public.media_assets(id) on delete set null,
  reply_to_message_id uuid references public.channel_messages(id) on delete restrict,
  status public.message_delivery_status not null,
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  sent_by uuid,
  sent_by_label text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint channel_messages_type_format check (message_type ~ '^[a-z_]{2,30}$'),
  -- Un mensaje saliente lo escribió alguien del equipo o un actor del sistema.
  constraint channel_messages_outbound_has_sender check (
    direction = 'inbound' or sent_by is not null or sender_external_id is not null
  )
);

-- La clave de idempotencia de todo webhook de mensaje.
create unique index channel_messages_external_unique
on public.channel_messages(channel_account_id, external_message_id)
where external_message_id is not null;

create index channel_messages_thread_idx
on public.channel_messages(conversation_id, received_at, id);
create index channel_messages_status_idx
on public.channel_messages(status) where status in ('queued', 'failed');

comment on table public.channel_messages is
  'Mensaje normalizado de cualquier canal. Inmutable salvo su ciclo de entrega: '
  'status avanza, media se adjunta al descargarse, y nada más cambia jamás.';

-- Decisión B: inmutabilidad selectiva.
create or replace function public.reject_message_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.conversation_id  is distinct from old.conversation_id
     or new.channel_account_id is distinct from old.channel_account_id
     or new.direction     is distinct from old.direction
     or new.message_type  is distinct from old.message_type
     or new.external_message_id is distinct from old.external_message_id
     or new.sender_external_id  is distinct from old.sender_external_id
     or new.body          is distinct from old.body
     or new.reply_to_message_id is distinct from old.reply_to_message_id
     or new.sent_at       is distinct from old.sent_at
     or new.received_at   is distinct from old.received_at
     or new.sent_by       is distinct from old.sent_by
     or new.created_at    is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'Un mensaje no se reescribe: solo avanzan su estado de entrega, su medio y su metadata.';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_message_mutation() from public, anon;

create trigger channel_messages_immutable
before update on public.channel_messages
for each row execute function public.reject_message_mutation();

-- ---------------------------------------------------------------------------
-- 3. Eventos
-- ---------------------------------------------------------------------------
-- Decisión C: un solo libro, append-only, con origen polimórfico sin FK y
-- fotografía textual — el patrón del kardex (0028).

create table public.channel_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  conversation_id uuid references public.channel_conversations(id) on delete restrict,
  channel_account_id uuid references public.channel_accounts(id) on delete restrict,
  source_type text,
  source_id uuid,
  source_label text,
  actor_id uuid,
  actor_label text,
  payload jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint channel_events_type_format check (event_type ~ '^[a-z0-9_.]{2,60}$')
);

create index channel_events_conversation_idx
on public.channel_events(conversation_id, id) where conversation_id is not null;
create index channel_events_type_idx on public.channel_events(event_type, occurred_at desc);
create index channel_events_source_idx
on public.channel_events(source_type, source_id) where source_id is not null;

create trigger channel_events_no_update
before update on public.channel_events
for each row execute function public.reject_audit_mutation();

comment on table public.channel_events is
  'Libro histórico del canal: mensajes, asignaciones, carritos, conversiones. '
  'Solo adición; el orden autoritativo es id, no occurred_at.';

create or replace function public.record_channel_event(
  p_event_type text,
  p_conversation_id uuid default null,
  p_channel_account_id uuid default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_source_label text default null,
  p_payload jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := coalesce(p_actor_id, auth.uid());
  event_id bigint;
begin
  insert into public.channel_events (
    event_type, conversation_id, channel_account_id,
    source_type, source_id, source_label,
    actor_id, actor_label, payload
  ) values (
    p_event_type, p_conversation_id, p_channel_account_id,
    p_source_type, p_source_id, p_source_label,
    actor,
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = actor),
    coalesce(p_payload, '{}'::jsonb)
  )
  returning id into event_id;

  return event_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Contratos de conversación
-- ---------------------------------------------------------------------------

create or replace function public.ensure_conversation(
  p_channel_account_id uuid,
  p_channel_contact_id uuid,
  p_branch_id uuid default null,
  p_external_conversation_id text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation_id uuid;
  resolved_branch uuid;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede abrir conversaciones.';
  end if;

  -- Serializa dos webhooks simultáneos del mismo contacto. El índice parcial
  -- es el cinturón; esto es el camino feliz sin error 23505.
  perform pg_advisory_xact_lock(
    hashtextextended('conversation:' || p_channel_account_id::text || ':' || p_channel_contact_id::text, 0)
  );

  select id into conversation_id
  from public.channel_conversations
  where channel_account_id = p_channel_account_id
    and channel_contact_id = p_channel_contact_id
    and status in ('open', 'pending')
  limit 1;

  if conversation_id is not null then
    return conversation_id;
  end if;

  -- La sede: la declarada, la de la cuenta, o la principal. Toda conversación
  -- pertenece a una sede porque la RLS recorta por sede.
  select coalesce(
    p_branch_id,
    (select branch_id from public.channel_accounts where id = p_channel_account_id),
    (select id from public.branches where is_active and is_default limit 1)
  ) into resolved_branch;

  insert into public.channel_conversations (
    channel_account_id, channel_contact_id, branch_id, external_conversation_id
  ) values (
    p_channel_account_id, p_channel_contact_id, resolved_branch,
    nullif(trim(coalesce(p_external_conversation_id, '')), '')
  )
  returning id into conversation_id;

  perform public.record_channel_event(
    'conversation.opened', conversation_id, p_channel_account_id,
    'channel_contact', p_channel_contact_id, null, '{}'::jsonb, auth.uid()
  );

  return conversation_id;
end;
$$;

-- El caballo de trabajo de todo webhook entrante y de todo envío del panel.
-- Idempotente por (cuenta, mensaje externo): el reintento devuelve lo ya
-- escrito con created=false y no toca la actividad de la conversación.
create or replace function public.ingest_channel_message(
  p_channel_account_id uuid,
  p_external_contact_id text,
  p_direction public.message_direction,
  p_body text default null,
  p_message_type text default 'text',
  p_external_message_id text default null,
  p_contact_display_name text default null,
  p_contact_phone text default null,
  p_contact_username text default null,
  p_sent_at timestamptz default null,
  p_reply_to_external_id text default null,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_id uuid;
  conversation_id uuid;
  message_id uuid;
  reply_id uuid;
  initial_status public.message_delivery_status;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede registrar mensajes.';
  end if;

  contact_id := public.ensure_channel_contact(
    p_channel_account_id, p_external_contact_id,
    p_contact_display_name, p_contact_phone, p_contact_username
  );

  conversation_id := public.ensure_conversation(p_channel_account_id, contact_id);

  -- La idempotencia se resuelve ANTES de escribir: un webhook repetido no
  -- puede ni duplicar el mensaje ni falsear last_activity_at.
  if p_external_message_id is not null then
    select id into message_id
    from public.channel_messages
    where channel_account_id = p_channel_account_id
      and external_message_id = p_external_message_id;

    if message_id is not null then
      return jsonb_build_object(
        'conversationId', conversation_id,
        'messageId', message_id,
        'created', false
      );
    end if;
  end if;

  if p_reply_to_external_id is not null then
    select id into reply_id
    from public.channel_messages
    where channel_account_id = p_channel_account_id
      and external_message_id = p_reply_to_external_id;
  end if;

  initial_status := case when p_direction = 'inbound'
    then 'received'::public.message_delivery_status
    else 'queued'::public.message_delivery_status end;

  insert into public.channel_messages (
    conversation_id, channel_account_id, direction, message_type,
    external_message_id, sender_external_id, body, reply_to_message_id,
    status, sent_at, sent_by, sent_by_label, metadata
  ) values (
    conversation_id, p_channel_account_id, p_direction, coalesce(p_message_type, 'text'),
    p_external_message_id,
    case when p_direction = 'inbound' then p_external_contact_id end,
    p_body, reply_id,
    initial_status, p_sent_at,
    case when p_direction = 'outbound' then auth.uid() end,
    case when p_direction = 'outbound' then
      (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = auth.uid())
    end,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (channel_account_id, external_message_id) where external_message_id is not null
  do nothing
  returning id into message_id;

  -- Carrera perdida contra otro webhook idéntico: se devuelve el suyo.
  if message_id is null then
    select id into message_id
    from public.channel_messages
    where channel_account_id = p_channel_account_id
      and external_message_id = p_external_message_id;

    return jsonb_build_object(
      'conversationId', conversation_id, 'messageId', message_id, 'created', false
    );
  end if;

  update public.channel_conversations
  set last_activity_at = now(),
      -- Un mensaje nuevo reabre lo pendiente; lo cerrado se queda cerrado y la
      -- unicidad parcial abrirá conversación nueva en la siguiente ingesta.
      status = case when status = 'pending' then 'open' else status end
  where id = conversation_id;

  perform public.record_channel_event(
    case when p_direction = 'inbound' then 'message.received' else 'message.sent' end,
    conversation_id, p_channel_account_id,
    'channel_message', message_id, left(coalesce(p_body, p_message_type), 80),
    '{}'::jsonb, auth.uid()
  );

  return jsonb_build_object(
    'conversationId', conversation_id, 'messageId', message_id, 'created', true
  );
end;
$$;

-- Confirmaciones del proveedor. Monotónico: read > delivered > sent > queued;
-- un acuse tardío jamás degrada lo ya confirmado.
create or replace function public.mark_message_status(
  p_channel_account_id uuid,
  p_external_message_id text,
  p_status public.message_delivery_status,
  p_occurred_at timestamptz default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  advanced boolean;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede actualizar estados.';
  end if;

  update public.channel_messages
  set status = p_status,
      metadata = metadata || jsonb_build_object('status_' || p_status::text || '_at',
                                                coalesce(p_occurred_at, now()))
  where channel_account_id = p_channel_account_id
    and external_message_id = p_external_message_id
    and (case status
           when 'queued' then 1 when 'sent' then 2 when 'received' then 2
           when 'delivered' then 3 when 'read' then 4 when 'failed' then 5 end)
      < (case p_status
           when 'queued' then 1 when 'sent' then 2 when 'received' then 2
           when 'delivered' then 3 when 'read' then 4 when 'failed' then 5 end);

  get diagnostics advanced = row_count;
  return advanced;
end;
$$;

create or replace function public.close_conversation(
  p_conversation_id uuid,
  p_reason text,
  p_status public.conversation_status default 'closed'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation public.channel_conversations%rowtype;
begin
  if p_status not in ('closed', 'archived') then
    raise exception using errcode = '22023', message = 'El cierre solo admite closed o archived.';
  end if;

  select * into conversation from public.channel_conversations where id = p_conversation_id;

  if conversation.id is null then
    raise exception using errcode = '22023', message = 'La conversación no existe.';
  end if;

  perform public.assert_branch_access(conversation.branch_id, 'cerrar conversaciones');

  -- Transición condicional: el cierre concurrente con otro cierre no escribe
  -- dos veces ni pisa el motivo del primero.
  update public.channel_conversations
  set status = p_status,
      closed_at = now(),
      closed_by = auth.uid(),
      closed_by_label = (select nullif(trim(coalesce(full_name, '')), '')
                         from public.admin_profiles where id = auth.uid()),
      close_reason = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_conversation_id and status in ('open', 'pending')
  returning * into conversation;

  if conversation.closed_at is null then
    raise exception using errcode = '23514', message = 'La conversación ya no estaba abierta.';
  end if;

  perform public.record_channel_event(
    'conversation.closed', p_conversation_id, conversation.channel_account_id,
    null, null, null, jsonb_build_object('reason', p_reason), auth.uid()
  );

  return jsonb_build_object('id', conversation.id, 'status', conversation.status);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------------
-- La vendedora ve las conversaciones de SUS sedes que estén sin asignar o
-- asignadas a ella. Las asignadas a otra compañera no aparecen: la bandeja no
-- es un lugar para leer conversaciones ajenas.

alter table public.channel_conversations enable row level security;
alter table public.channel_messages enable row level security;
alter table public.channel_events enable row level security;

create policy "staff read reachable conversations"
on public.channel_conversations for select to authenticated
using (
  branch_id in (select public.staff_branch_ids())
  and (public.is_admin() or assigned_user_id is null or assigned_user_id = auth.uid())
);

create policy "admins correct conversations"
on public.channel_conversations for update to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "staff read messages of reachable conversations"
on public.channel_messages for select to authenticated
using (exists (
  select 1 from public.channel_conversations c
  where c.id = channel_messages.conversation_id
    and c.branch_id in (select public.staff_branch_ids())
    and (public.is_admin() or c.assigned_user_id is null or c.assigned_user_id = auth.uid())
));

create policy "staff read events of reachable conversations"
on public.channel_events for select to authenticated
using (
  public.is_admin()
  or (conversation_id is not null and exists (
    select 1 from public.channel_conversations c
    where c.id = channel_events.conversation_id
      and c.branch_id in (select public.staff_branch_ids())
      and (c.assigned_user_id is null or c.assigned_user_id = auth.uid())
  ))
);

-- 0035 dejó los contactos admin-only; ahora la vendedora los ve POR SUS
-- conversaciones, que es el alcance que el plan exige.
-- OJO con la resolución de nombres: dentro del EXISTS, un `id` sin calificar
-- se une a `c.id` —la tabla más cercana— y la política no encontraría nada.
-- Se califica SIEMPRE contra la tabla protegida.
create policy "staff read contacts of reachable conversations"
on public.channel_contacts for select to authenticated
using (exists (
  select 1 from public.channel_conversations c
  where c.channel_contact_id = channel_contacts.id
    and c.branch_id in (select public.staff_branch_ids())
    and (c.assigned_user_id is null or c.assigned_user_id = auth.uid())
));

-- ---------------------------------------------------------------------------
-- 6. Privilegios
-- ---------------------------------------------------------------------------

grant select, update on public.channel_conversations to authenticated;
grant select on public.channel_messages to authenticated;
grant select on public.channel_events to authenticated;

grant select, insert, update, delete on
  public.channel_conversations, public.channel_messages
to service_role;
grant select, insert, delete on public.channel_events to service_role;

revoke truncate on public.channel_conversations, public.channel_messages,
  public.channel_events
from anon, authenticated, service_role;

revoke all on function public.record_channel_event(text, uuid, uuid, text, uuid, text, jsonb, uuid) from public, anon;
revoke all on function public.ensure_conversation(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.ingest_channel_message(uuid, text, public.message_direction, text, text, text, text, text, text, timestamptz, text, jsonb) from public, anon;
revoke all on function public.mark_message_status(uuid, text, public.message_delivery_status, timestamptz) from public, anon;
revoke all on function public.close_conversation(uuid, text, public.conversation_status) from public, anon;

grant execute on function public.record_channel_event(text, uuid, uuid, text, uuid, text, jsonb, uuid) to authenticated, service_role;
grant execute on function public.ensure_conversation(uuid, uuid, uuid, text) to authenticated, service_role;
grant execute on function public.ingest_channel_message(uuid, text, public.message_direction, text, text, text, text, text, text, timestamptz, text, jsonb) to authenticated, service_role;
grant execute on function public.mark_message_status(uuid, text, public.message_delivery_status, timestamptz) to authenticated, service_role;
grant execute on function public.close_conversation(uuid, text, public.conversation_status) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Auditoría
-- ---------------------------------------------------------------------------
-- Conversaciones: decisiones (asignar, cerrar) → se auditan. Mensajes y
-- eventos: ya son libros históricos inmutables; auditarlos duplicaría cada
-- fila. El precedente es inventory_movements en 0028.

select public.attach_audit('public.channel_conversations');

commit;
