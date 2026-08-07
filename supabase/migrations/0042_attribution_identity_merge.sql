-- Bloque 3 · Ajuste — fusión de cadenas cuando la identidad converge.
--
-- DEFECTO ENCONTRADO POR LA PRUEBA INTEGRAL. El recorrido real del plan —la
-- clienta navega por la web (cadena del VISITANTE, con su campaña de
-- Instagram) y después escribe por WhatsApp (el webhook abre la cadena del
-- CONTACTO)— produce DOS cadenas abiertas del mismo ser humano. Al enlazarlas,
-- attach_attribution moría contra channel_attributions_open_contact_unique en
-- lugar de reconocer que son el mismo recorrido.
--
-- LA REGLA DE FUSIÓN, y por qué es la única compatible con la inmutabilidad:
--
--   · SOBREVIVE la cadena con el primer toque MÁS ANTIGUO. Es «la atribución
--     original» que §11 prohíbe destruir: la campaña de Instagram que trajo a
--     la clienta no puede perder contra el stub que el webhook abrió segundos
--     antes de la fusión.
--   · El last-touch del superviviente AVANZA al más reciente de las dos: entrar
--     por WhatsApp es el último toque, exactamente la semántica de §40.
--   · Los eslabones (conversación, carrito, reserva) se COALESCEN: ninguno se
--     reasigna, solo se completan los vacíos.
--   · La cadena absorbida se elimina. No es historia comercial —no tiene venta;
--     la unicidad parcial lo garantiza— sino un duplicado del mismo recorrido
--     que existió solo porque la identidad aún no había convergido.

begin;

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
  visitor_chain public.channel_attributions%rowtype;
  contact_chain public.channel_attributions%rowtype;
  absorbed public.channel_attributions%rowtype;
  source_id uuid;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo enlaza atribuciones.';
  end if;

  if p_visitor_id is null and p_contact_id is null then
    raise exception using errcode = '22023', message = 'La atribución necesita visitante o contacto.';
  end if;

  -- Un solo candado para las dos identidades: dos fusiones simultáneas del
  -- mismo par se serializan.
  if p_visitor_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('attribution:' || p_visitor_id::text, 0));
  end if;
  if p_contact_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('attribution:' || p_contact_id::text, 0));
  end if;

  if p_visitor_id is not null then
    select * into visitor_chain from public.channel_attributions
    where anonymous_visitor_id = p_visitor_id and sale_id is null;
  end if;

  if p_contact_id is not null then
    select * into contact_chain from public.channel_attributions
    where channel_contact_id = p_contact_id and sale_id is null;
  end if;

  -- LA FUSIÓN: dos cadenas abiertas del mismo recorrido convergen en la del
  -- primer toque más antiguo.
  if visitor_chain.id is not null and contact_chain.id is not null
     and visitor_chain.id <> contact_chain.id then
    if visitor_chain.first_touch_at <= contact_chain.first_touch_at then
      attribution := visitor_chain;
      absorbed := contact_chain;
    else
      attribution := contact_chain;
      absorbed := visitor_chain;
    end if;

    -- Primero desaparece el duplicado: su unicidad parcial dejaría de estorbar
    -- y sus eslabones ya están copiados en variables.
    delete from public.channel_attributions where id = absorbed.id;

    update public.channel_attributions
    set anonymous_visitor_id = coalesce(anonymous_visitor_id, absorbed.anonymous_visitor_id),
        channel_contact_id = coalesce(channel_contact_id, absorbed.channel_contact_id),
        person_id = coalesce(person_id, absorbed.person_id),
        conversation_id = coalesce(conversation_id, absorbed.conversation_id),
        cart_id = coalesce(cart_id, absorbed.cart_id),
        reservation_id = coalesce(reservation_id, absorbed.reservation_id),
        -- El último toque del recorrido unificado es el más reciente de los dos.
        last_source_id = case when absorbed.last_touch_at > last_touch_at
                              then absorbed.last_source_id else last_source_id end,
        last_campaign_id = case when absorbed.last_touch_at > last_touch_at
                                then absorbed.last_campaign_id else last_campaign_id end,
        last_channel_id = case when absorbed.last_touch_at > last_touch_at
                               then absorbed.last_channel_id else last_channel_id end,
        last_utm = case when absorbed.last_touch_at > last_touch_at
                        then absorbed.last_utm else last_utm end,
        last_touch_at = greatest(last_touch_at, absorbed.last_touch_at)
    where id = attribution.id;

    select * into attribution from public.channel_attributions where id = attribution.id;
  else
    attribution := coalesce(visitor_chain, contact_chain);
  end if;

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
  set anonymous_visitor_id = coalesce(channel_attributions.anonymous_visitor_id, p_visitor_id),
      channel_contact_id = coalesce(channel_attributions.channel_contact_id, p_contact_id),
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

commit;
