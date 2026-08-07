-- Bloque 3 · Ajuste — despacho de mensajes salientes.
--
-- 0036 congeló external_message_id junto con el cuerpo, y eso es correcto para
-- lo ENTRANTE: la identidad la trae el webhook. Pero el saliente nace en la
-- base ANTES de existir en el proveedor (insert-first también aquí: primero la
-- fila en cola, después Graph), y el eco de Meta trae la identidad recién
-- entonces. La regla precisa es: la identidad externa se ESTABLECE una vez —
-- nulo → valor— y jamás se cambia ni se borra. Igual sent_at para el saliente.

begin;

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
     -- Establecer una vez, nunca cambiar: el eco del proveedor llega después
     -- de encolar el saliente.
     or (old.external_message_id is not null
         and new.external_message_id is distinct from old.external_message_id)
     or (old.external_message_id is null and new.external_message_id is null
         and false) -- forma explícita: nulo → nulo siempre permitido
     or new.sender_external_id  is distinct from old.sender_external_id
     or new.body          is distinct from old.body
     or new.reply_to_message_id is distinct from old.reply_to_message_id
     or (old.sent_at is not null and new.sent_at is distinct from old.sent_at)
     or new.received_at   is distinct from old.received_at
     or new.sent_by       is distinct from old.sent_by
     or new.created_at    is distinct from old.created_at then
    raise exception using
      errcode = '23514',
      message = 'Un mensaje no se reescribe: solo avanzan su estado, su identidad externa (una vez), su medio y su metadata.';
  end if;

  return new;
end;
$$;

-- Registra el despacho de un saliente: identidad del proveedor y estado, en
-- una sola transición. DEFINER, solo servidor y personal.
create or replace function public.mark_message_dispatched(
  p_message_id uuid,
  p_external_message_id text,
  p_status public.message_delivery_status default 'sent'
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  moved boolean;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo despacha mensajes.';
  end if;

  update public.channel_messages
  set external_message_id = coalesce(external_message_id, nullif(trim(p_external_message_id), '')),
      status = p_status,
      sent_at = coalesce(sent_at, now())
  where id = p_message_id and direction = 'outbound';

  get diagnostics moved = row_count;
  return moved;
end;
$$;

revoke all on function public.mark_message_dispatched(uuid, text, public.message_delivery_status) from public, anon;
grant execute on function public.mark_message_dispatched(uuid, text, public.message_delivery_status) to authenticated, service_role;

commit;
