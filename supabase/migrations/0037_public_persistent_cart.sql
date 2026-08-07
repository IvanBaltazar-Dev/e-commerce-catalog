-- Bloque 3 · Migración 3 de 6 — Carrito público persistente.
--
-- La auditoría lo señaló expresamente: la selección pública vive en
-- localStorage y muere con el navegador. Este carrito la vuelve real —entre
-- dispositivos, compartible, enlazable a conversación— SIN convertirse jamás
-- en fuente de precio: cada lectura reevalúa contra evaluate_cart_v2.
--
-- CUATRO DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. EL CARRITO NO GUARDA NI PRECIO NI MODALIDAD. El plan pedía almacenar la
--    «modalidad comercial» por línea, pero la modalidad ES una consecuencia
--    del precio (la regla mayorista depende de cantidades acumuladas), y el
--    propio plan prohíbe que el carrito sea fuente de precio histórico. Se
--    guarda variante y cantidad; precio, subtotal, modalidad y disponibilidad
--    salen SIEMPRE del motor del Bloque 1/2 en el momento de leer.
--
-- B. CONCURRENCIA ENTRE DISPOSITIVOS: VERSIONADO OPTIMISTA DECLARADO, NUNCA
--    last-write-wins silencioso. Toda mutación exige la versión esperada; el
--    conflicto devuelve un error explícito con la versión vigente para que el
--    cliente refresque. Un candado consultivo por carrito serializa además las
--    dos escrituras para que el número de versión avance sin huecos.
--
-- C. LA CONVERSIÓN ES UNA TRANSICIÓN CONDICIONAL QUE ENVUELVE AL BLOQUE 2.
--    convert_cart_to_sale no calcula nada: marca active→converted bajo candado
--    y llama a register_sale con las líneas del carrito. El doble clic
--    devuelve la MISMA venta; dos dispositivos simultáneos producen UNA.
--
-- D. EL TOKEN ES OPACO Y SIN DEPENDENCIAS. 64 hex de dos uuid aleatorios: no
--    es secuencial, no revela ids internos, no exige pgcrypto. anon no tiene
--    UN SOLO grant de tabla: su única superficie son las funciones por token.

begin;

create type public.cart_status as enum (
  'active', 'abandoned', 'converted', 'expired', 'cancelled'
);

-- ---------------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------------

create table public.public_carts (
  id uuid primary key default gen_random_uuid(),
  public_token text not null unique
    default replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
  anonymous_visitor_id uuid references public.anonymous_visitors(id) on delete restrict,
  person_id uuid references public.persons(id) on delete restrict,
  channel_id uuid not null references public.channels(id) on delete restrict,
  channel_account_id uuid references public.channel_accounts(id) on delete restrict,
  conversation_id uuid references public.channel_conversations(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  assigned_user_id uuid,
  status public.cart_status not null default 'active',
  currency char(3) not null default 'PEN',
  -- Decisión B: la versión que toda mutación debe declarar conocer.
  row_version integer not null default 1,
  converted_sale_id uuid references public.sales(id) on delete restrict,
  converted_reservation_id uuid references public.reservations(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 days',
  metadata jsonb not null default '{}'::jsonb,
  constraint public_carts_token_length check (length(public_token) >= 32),
  constraint public_carts_currency_pen check (currency = 'PEN'),
  constraint public_carts_version_positive check (row_version > 0),
  -- Convertido ⇔ apunta a su venta o a su reserva. Nunca a las dos.
  constraint public_carts_conversion_consistent check (
    (status = 'converted') = (num_nonnulls(converted_sale_id, converted_reservation_id) = 1)
  )
);

create index public_carts_visitor_idx
on public.public_carts(anonymous_visitor_id, status) where anonymous_visitor_id is not null;
create index public_carts_person_idx
on public.public_carts(person_id) where person_id is not null;
create index public_carts_status_idx on public.public_carts(status, last_activity_at desc);
create index public_carts_branch_idx on public.public_carts(branch_id, status);
create index public_carts_conversation_idx
on public.public_carts(conversation_id) where conversation_id is not null;
create index public_carts_expiry_idx
on public.public_carts(expires_at) where status = 'active';

create trigger public_carts_set_updated_at
before update on public.public_carts
for each row execute function public.set_updated_at();

comment on table public.public_carts is
  'Selección pública persistente. NUNCA fuente de precio: cada lectura reevalúa '
  'con evaluate_cart_v2. El token es la única llave del público.';

create table public.public_cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.public_carts(id) on delete cascade,
  -- La unidad vendible sigue siendo la VARIANTE, jamás el producto.
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  quantity integer not null,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_cart_items_quantity_valid check (quantity between 1 and 999),
  constraint public_cart_items_unique unique (cart_id, variant_id)
);

create index public_cart_items_variant_idx on public.public_cart_items(variant_id);

create trigger public_cart_items_set_updated_at
before update on public.public_cart_items
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Detalle: siempre reevaluado
-- ---------------------------------------------------------------------------

create or replace function public.public_cart_detail(p_public_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  cart_lines jsonb;
  evaluation jsonb;
begin
  select * into cart from public.public_carts where public_token = p_public_token;

  if cart.id is null then
    return null;
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('variantId', i.variant_id, 'quantity', i.quantity)
    order by i.added_at, i.id
  ), '[]'::jsonb)
    into cart_lines
  from public.public_cart_items i where i.cart_id = cart.id;

  -- Decisión A: el precio nace aquí, ahora, del motor comercial. Un carrito
  -- vacío no se evalúa: evaluate_cart_v2 exige entre 1 y 50 líneas.
  if jsonb_array_length(cart_lines) > 0 then
    evaluation := public.evaluate_cart_v2(cart_lines);
  else
    evaluation := jsonb_build_object(
      'lines', '[]'::jsonb, 'totalUnits', 0, 'subtotal', null, 'unresolvedLines', 0
    );
  end if;

  return jsonb_build_object(
    'id', cart.id,
    'publicToken', cart.public_token,
    'status', cart.status,
    'rowVersion', cart.row_version,
    'branchId', cart.branch_id,
    'channelId', cart.channel_id,
    'conversationId', cart.conversation_id,
    'convertedSaleId', cart.converted_sale_id,
    'convertedReservationId', cart.converted_reservation_id,
    'expiresAt', cart.expires_at,
    'lastActivityAt', cart.last_activity_at,
    'evaluation', evaluation
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Crear o recuperar
-- ---------------------------------------------------------------------------

create or replace function public.get_or_create_public_cart(
  p_public_token text default null,
  p_visitor_id uuid default null,
  p_channel_code text default 'web'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  resolved_channel uuid;
  resolved_account uuid;
begin
  -- 1) Por token: la llave manda, venga de cookie o de enlace compartido.
  if p_public_token is not null then
    select * into cart from public.public_carts where public_token = p_public_token;

    if cart.id is not null and cart.status in ('active', 'abandoned') then
      -- Tocar un carrito abandonado lo revive: la clienta volvió.
      update public.public_carts
      set status = 'active', last_activity_at = now(),
          anonymous_visitor_id = coalesce(anonymous_visitor_id, p_visitor_id)
      where id = cart.id;

      return public.public_cart_detail(cart.public_token);
    end if;
    -- Token huérfano, convertido o vencido: se emite carrito nuevo abajo.
  end if;

  -- 2) Por visitante: dos pestañas del mismo navegador convergen en un carrito.
  if p_visitor_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('cart-visitor:' || p_visitor_id::text, 0));

    select * into cart
    from public.public_carts
    where anonymous_visitor_id = p_visitor_id and status = 'active'
    order by last_activity_at desc
    limit 1;

    if cart.id is not null then
      update public.public_carts set last_activity_at = now() where id = cart.id;
      return public.public_cart_detail(cart.public_token);
    end if;
  end if;

  select id into resolved_channel from public.channels where code = coalesce(p_channel_code, 'web');

  if resolved_channel is null then
    raise exception using errcode = '22023', message = 'El canal indicado no existe.';
  end if;

  select id into resolved_account
  from public.channel_accounts
  where channel_id = resolved_channel and is_active
  order by created_at
  limit 1;

  insert into public.public_carts (
    anonymous_visitor_id, channel_id, channel_account_id, branch_id
  ) values (
    p_visitor_id, resolved_channel, resolved_account,
    (select id from public.branches where is_active and is_default limit 1)
  )
  returning * into cart;

  perform public.record_channel_event(
    'cart.created', null, resolved_account,
    'public_cart', cart.id, null,
    jsonb_build_object('channel', p_channel_code), null
  );

  return public.public_cart_detail(cart.public_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Mutaciones con versión declarada
-- ---------------------------------------------------------------------------

create or replace function public.set_public_cart_item(
  p_public_token text,
  p_variant_id uuid,
  p_quantity integer,
  p_expected_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
begin
  select * into cart from public.public_carts where public_token = p_public_token;

  if cart.id is null then
    raise exception using errcode = '22023', message = 'El carrito no existe.';
  end if;

  -- Serializa dos dispositivos ANTES de comparar versiones: sin el candado,
  -- ambos leen la misma versión y uno de los dos pisaría al otro.
  perform pg_advisory_xact_lock(hashtextextended('cart:' || cart.id::text, 0));

  select * into cart from public.public_carts where id = cart.id;

  if cart.status not in ('active', 'abandoned') then
    raise exception using errcode = '23514',
      message = format('El carrito ya no admite cambios: está %s.', cart.status);
  end if;

  -- Decisión B: el conflicto es un ERROR EXPLÍCITO con la versión vigente,
  -- nunca un last-write-wins silencioso.
  if p_expected_version is not null and p_expected_version <> cart.row_version then
    raise exception using
      errcode = 'P0409',
      message = format('cart_version_conflict: esperada %s, vigente %s.',
                       p_expected_version, cart.row_version);
  end if;

  if p_quantity is null or p_quantity <= 0 then
    delete from public.public_cart_items
    where cart_id = cart.id and variant_id = p_variant_id;
  else
    if not exists (
      select 1 from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.id = p_variant_id and v.is_active
        and p.is_active and p.editorial_status = 'published'
    ) then
      raise exception using errcode = '22023',
        message = 'La presentación no existe o ya no es pública.';
    end if;

    if p_quantity > 999 then
      raise exception using errcode = '22023', message = 'La cantidad máxima por línea es 999.';
    end if;

    insert into public.public_cart_items as i (cart_id, variant_id, quantity)
    values (cart.id, p_variant_id, p_quantity)
    on conflict (cart_id, variant_id) do update set
      quantity = excluded.quantity,
      updated_at = now();
  end if;

  update public.public_carts
  set row_version = row_version + 1,
      status = 'active',
      last_activity_at = now()
  where id = cart.id;

  return public.public_cart_detail(p_public_token);
end;
$$;

-- Migración desde localStorage. Fusión DETERMINISTA: por variante gana la
-- cantidad MAYOR entre servidor y local — nunca el precio local, que no viaja.
create or replace function public.sync_public_cart(
  p_public_token text,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  entry jsonb;
  line_variant uuid;
  line_quantity integer;
begin
  select * into cart from public.public_carts where public_token = p_public_token;

  if cart.id is null then
    raise exception using errcode = '22023', message = 'El carrito no existe.';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 50 then
    raise exception using errcode = '22023', message = 'La sincronización admite hasta 50 líneas.';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cart:' || cart.id::text, 0));

  select * into cart from public.public_carts where id = cart.id;

  if cart.status not in ('active', 'abandoned') then
    raise exception using errcode = '23514',
      message = format('El carrito ya no admite cambios: está %s.', cart.status);
  end if;

  for entry in select value from jsonb_array_elements(p_lines) loop
    line_variant := nullif(entry ->> 'variantId', '')::uuid;
    line_quantity := least(greatest(coalesce((entry ->> 'quantity')::integer, 1), 1), 999);

    -- Una variante retirada del catálogo simplemente no entra: la migración no
    -- puede fallar entera porque el localStorage traiga historia muerta.
    if line_variant is null or not exists (
      select 1 from public.product_variants v
      join public.products p on p.id = v.product_id
      where v.id = line_variant and v.is_active
        and p.is_active and p.editorial_status = 'published'
    ) then
      continue;
    end if;

    insert into public.public_cart_items as i (cart_id, variant_id, quantity)
    values (cart.id, line_variant, line_quantity)
    on conflict (cart_id, variant_id) do update set
      quantity = greatest(i.quantity, excluded.quantity),
      updated_at = now();
  end loop;

  update public.public_carts
  set row_version = row_version + 1, status = 'active', last_activity_at = now()
  where id = cart.id;

  return public.public_cart_detail(p_public_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Vinculación a conversación y persona
-- ---------------------------------------------------------------------------
-- La usa el CTA de WhatsApp (servidor) y la pantalla de conversación: el
-- carrito queda enlazado al hilo y a la sede que atiende.

create or replace function public.link_cart_to_conversation(
  p_public_token text,
  p_conversation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  conversation public.channel_conversations%rowtype;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede enlazar carritos.';
  end if;

  select * into cart from public.public_carts where public_token = p_public_token;
  if cart.id is null then
    raise exception using errcode = '22023', message = 'El carrito no existe.';
  end if;

  select * into conversation from public.channel_conversations where id = p_conversation_id;
  if conversation.id is null then
    raise exception using errcode = '22023', message = 'La conversación no existe.';
  end if;

  update public.public_carts
  set conversation_id = conversation.id,
      channel_account_id = conversation.channel_account_id,
      channel_id = (select channel_id from public.channel_accounts where id = conversation.channel_account_id),
      branch_id = conversation.branch_id,
      assigned_user_id = coalesce(conversation.assigned_user_id, assigned_user_id),
      person_id = coalesce(cart.person_id,
                           (select person_id from public.channel_contacts
                            where id = conversation.channel_contact_id)),
      last_activity_at = now()
  where id = cart.id;

  perform public.record_channel_event(
    'cart.linked', conversation.id, conversation.channel_account_id,
    'public_cart', cart.id, null, '{}'::jsonb, auth.uid()
  );

  return public.public_cart_detail(p_public_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Conversión: envuelve al Bloque 2, jamás lo duplica
-- ---------------------------------------------------------------------------

create or replace function public.cart_channel_to_sale_channel(p_channel_code text)
returns public.sale_source_channel
language sql
immutable
set search_path = ''
as $$
  select case p_channel_code
    when 'web' then 'web'::public.sale_source_channel
    when 'whatsapp' then 'whatsapp'::public.sale_source_channel
    when 'facebook' then 'facebook'::public.sale_source_channel
    when 'instagram' then 'instagram'::public.sale_source_channel
    when 'tiktok' then 'tiktok'::public.sale_source_channel
    when 'store' then 'in_store'::public.sale_source_channel
    else 'other'::public.sale_source_channel
  end;
$$;

create or replace function public.convert_cart_to_sale(
  p_public_token text,
  p_payments jsonb,
  p_client_operation_id uuid,
  p_fulfillment_method public.fulfillment_method default 'in_store',
  p_customer jsonb default null,
  p_discount_total numeric default 0,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  cart_lines jsonb;
  channel_code text;
  sale jsonb;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo convierte carritos en venta.';
  end if;

  select * into cart from public.public_carts where public_token = p_public_token;

  if cart.id is null then
    raise exception using errcode = '22023', message = 'El carrito no existe.';
  end if;

  perform public.assert_branch_access(cart.branch_id, 'convertir carritos');

  -- Decisión C: candado + transición condicional. El doble clic y los dos
  -- dispositivos se resuelven aquí, no en la interfaz.
  perform pg_advisory_xact_lock(hashtextextended('cart:' || cart.id::text, 0));

  select * into cart from public.public_carts where id = cart.id;

  if cart.status = 'converted' then
    if cart.converted_sale_id is not null then
      return public.sale_detail(cart.converted_sale_id);
    end if;
    raise exception using errcode = '23514',
      message = 'El carrito ya se convirtió en reserva: conviértela desde la reserva.';
  end if;

  if cart.status not in ('active', 'abandoned') then
    raise exception using errcode = '23514',
      message = format('El carrito no puede convertirse: está %s.', cart.status);
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('variantId', i.variant_id, 'quantity', i.quantity)
    order by i.variant_id
  ), '[]'::jsonb)
    into cart_lines
  from public.public_cart_items i where i.cart_id = cart.id;

  if jsonb_array_length(cart_lines) = 0 then
    raise exception using errcode = '22023', message = 'El carrito está vacío.';
  end if;

  select c.code into channel_code from public.channels c where c.id = cart.channel_id;

  -- El Bloque 2 hace TODO el trabajo comercial: precio, mayorista, descuento,
  -- inventario, correlativo, costos y pagos exactos.
  sale := public.register_sale(
    cart.branch_id,
    cart_lines,
    p_payments,
    p_client_operation_id,
    public.cart_channel_to_sale_channel(channel_code),
    p_fulfillment_method,
    p_customer,
    coalesce(p_discount_total, 0),
    p_notes,
    null,
    'cart:' || cart.public_token
  );

  update public.public_carts
  set status = 'converted',
      converted_sale_id = (sale ->> 'id')::uuid,
      last_activity_at = now()
  where id = cart.id;

  perform public.record_channel_event(
    'cart.converted', cart.conversation_id, cart.channel_account_id,
    'sale', (sale ->> 'id')::uuid, sale ->> 'saleNumber',
    jsonb_build_object('cartId', cart.id), auth.uid()
  );

  return sale;
end;
$$;

create or replace function public.convert_cart_to_reservation(
  p_public_token text,
  p_customer jsonb,
  p_expires_at timestamptz,
  p_client_operation_id uuid,
  p_advance jsonb default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  cart public.public_carts%rowtype;
  cart_lines jsonb;
  reservation jsonb;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo reserva desde carritos.';
  end if;

  select * into cart from public.public_carts where public_token = p_public_token;

  if cart.id is null then
    raise exception using errcode = '22023', message = 'El carrito no existe.';
  end if;

  perform public.assert_branch_access(cart.branch_id, 'reservar desde carritos');
  perform pg_advisory_xact_lock(hashtextextended('cart:' || cart.id::text, 0));

  select * into cart from public.public_carts where id = cart.id;

  if cart.status = 'converted' then
    if cart.converted_reservation_id is not null then
      return public.reservation_detail(cart.converted_reservation_id);
    end if;
    raise exception using errcode = '23514', message = 'El carrito ya se convirtió en venta.';
  end if;

  if cart.status not in ('active', 'abandoned') then
    raise exception using errcode = '23514',
      message = format('El carrito no puede reservarse: está %s.', cart.status);
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object('variantId', i.variant_id, 'quantity', i.quantity)
    order by i.variant_id
  ), '[]'::jsonb)
    into cart_lines
  from public.public_cart_items i where i.cart_id = cart.id;

  if jsonb_array_length(cart_lines) = 0 then
    raise exception using errcode = '22023', message = 'El carrito está vacío.';
  end if;

  reservation := public.create_reservation(
    cart.branch_id, cart_lines, p_customer, p_expires_at,
    p_client_operation_id, p_advance, p_notes
  );

  update public.public_carts
  set status = 'converted',
      converted_reservation_id = (reservation ->> 'id')::uuid,
      last_activity_at = now()
  where id = cart.id;

  perform public.record_channel_event(
    'cart.reserved', cart.conversation_id, cart.channel_account_id,
    'reservation', (reservation ->> 'id')::uuid, reservation ->> 'reservationNumber',
    jsonb_build_object('cartId', cart.id), auth.uid()
  );

  return reservation;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Ciclo de vida
-- ---------------------------------------------------------------------------

create or replace function public.mark_abandoned_carts(p_idle interval default interval '72 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  marked integer;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración marca abandonos.';
  end if;

  with flagged as (
    update public.public_carts
    set status = 'abandoned'
    where status = 'active'
      and last_activity_at < now() - p_idle
      and exists (select 1 from public.public_cart_items i where i.cart_id = public_carts.id)
    returning id, channel_account_id, conversation_id
  )
  select count(*) into marked from flagged;

  return marked;
end;
$$;

create or replace function public.expire_public_carts()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired integer;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración expira carritos.';
  end if;

  with flagged as (
    update public.public_carts
    set status = 'expired'
    where status in ('active', 'abandoned') and expires_at <= now()
    returning id
  )
  select count(*) into expired from flagged;

  return expired;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. RLS y privilegios
-- ---------------------------------------------------------------------------
-- anon NO tiene grants de tabla: su superficie completa son las funciones por
-- token. El personal lee los carritos de sus sedes para la bandeja.

alter table public.public_carts enable row level security;
alter table public.public_cart_items enable row level security;

create policy "staff read carts of their branches"
on public.public_carts for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "staff read cart items"
on public.public_cart_items for select to authenticated
using (exists (
  select 1 from public.public_carts c
  where c.id = public_cart_items.cart_id
    and c.branch_id in (select public.staff_branch_ids())
));

grant select on public.public_carts, public.public_cart_items to authenticated;
grant select, insert, update, delete on public.public_carts, public.public_cart_items to service_role;

-- El ACL por defecto de Supabase concede SELECT/REFERENCES/TRIGGER a anon
-- sobre toda tabla nueva. La RLS ya lo dejaría en cero filas, pero la promesa
-- de esta migración es más fuerte: anon no tiene NINGÚN privilegio de tabla y
-- su superficie completa son las funciones por token.
revoke all on public.public_carts, public.public_cart_items from anon;

revoke truncate on public.public_carts, public.public_cart_items
from anon, authenticated, service_role;

revoke all on function public.public_cart_detail(text) from public, anon, authenticated;
revoke all on function public.get_or_create_public_cart(text, uuid, text) from public, anon, authenticated;
revoke all on function public.set_public_cart_item(text, uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.sync_public_cart(text, jsonb) from public, anon, authenticated;
revoke all on function public.link_cart_to_conversation(text, uuid) from public, anon;
revoke all on function public.cart_channel_to_sale_channel(text) from public, anon;
revoke all on function public.convert_cart_to_sale(text, jsonb, uuid, public.fulfillment_method, jsonb, numeric, text) from public, anon;
revoke all on function public.convert_cart_to_reservation(text, jsonb, timestamptz, uuid, jsonb, text) from public, anon;
revoke all on function public.mark_abandoned_carts(interval) from public, anon;
revoke all on function public.expire_public_carts() from public, anon;

-- La superficie pública deliberada: leer por token, crear, mutar, sincronizar.
grant execute on function public.public_cart_detail(text) to anon, authenticated, service_role;
grant execute on function public.get_or_create_public_cart(text, uuid, text) to anon, authenticated, service_role;
grant execute on function public.set_public_cart_item(text, uuid, integer, integer) to anon, authenticated, service_role;
grant execute on function public.sync_public_cart(text, jsonb) to anon, authenticated, service_role;

grant execute on function public.link_cart_to_conversation(text, uuid) to authenticated, service_role;
grant execute on function public.cart_channel_to_sale_channel(text) to authenticated, service_role;
grant execute on function public.convert_cart_to_sale(text, jsonb, uuid, public.fulfillment_method, jsonb, numeric, text) to authenticated, service_role;
grant execute on function public.convert_cart_to_reservation(text, jsonb, timestamptz, uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.mark_abandoned_carts(interval) to authenticated, service_role;
grant execute on function public.expire_public_carts() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Auditoría
-- ---------------------------------------------------------------------------
-- Los carritos mutan con cada clic del público: auditarlos inundaría el log
-- (el precedente es anonymous_visitors en 0035). Las transiciones que importan
-- —creado, enlazado, convertido— quedan en channel_events; la conversión
-- además queda en la venta, que SÍ se audita.

commit;
