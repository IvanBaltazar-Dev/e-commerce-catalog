-- ---------------------------------------------------------------------------
-- 0047 · El origen sobrevive a la conversión del carrito
-- ---------------------------------------------------------------------------
-- Una clienta llega por Instagram, arma su carrito y la vendedora se lo
-- convierte en reserva. Hasta aquí, ese «llegó por Instagram» se perdía en el
-- traspaso: `channel_attributions` tiene `reservation_id` y `sale_id`, y
-- `attach_attribution()` sabe enlazarlos, pero NINGUNA función operativa los
-- llamaba. El dato existía en el carrito (`anonymous_visitor_id`,
-- `conversation_id`, `channel_id`) y se soltaba al convertir.
--
-- El enlace no se deja en manos de quien llame: va en un trigger sobre
-- `public_carts`, que se dispara cuando el carrito estampa
-- `converted_reservation_id` o `converted_sale_id`. Así queda:
--
--   · atómico con la conversión — o se enlazan ambos, o no pasa ninguno;
--   · imposible de olvidar — da igual si convierte la RPC, un script o
--     una pantalla futura;
--   · sin tocar el cuerpo de create_reservation ni de register_sale.
--
-- Qué NO hace: inventar un origen. Un carrito de mostrador no tiene visitante
-- ni conversación, y entonces no hay nada que atribuir — su origen es la
-- tienda, y eso ya lo dice la ausencia de atribución.

-- ---------------------------------------------------------------------------
-- 1. El enlace
-- ---------------------------------------------------------------------------
create or replace function public.link_cart_conversion_attribution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  contact_id uuid;
  channel_code text;
begin
  -- El sujeto de la atribución es el visitante anónimo del carrito o, si el
  -- carrito nació en una conversación, el contacto de esa conversación.
  select c.channel_contact_id into contact_id
  from public.channel_conversations c
  where c.id = new.conversation_id;

  -- Sin visitante y sin contacto no hay cadena que continuar: es una venta de
  -- mostrador. Salir en silencio es correcto; attach_attribution levantaría.
  if new.anonymous_visitor_id is null and contact_id is null then
    return new;
  end if;

  -- Si la cadena ya existe (la visitante fue tocada al aterrizar), este código
  -- se ignora y el first-touch original manda. Solo importa cuando el
  -- recorrido nace aquí: entonces se abre con el canal REAL del carrito, no
  -- con un «manual» que no dice nada.
  select ch.code into channel_code
  from public.channels ch where ch.id = new.channel_id;

  perform public.attach_attribution(
    p_visitor_id      => new.anonymous_visitor_id,
    p_contact_id      => contact_id,
    p_conversation_id => new.conversation_id,
    p_cart_id         => new.id,
    p_reservation_id  => new.converted_reservation_id,
    p_sale_id         => new.converted_sale_id,
    p_source_code     => channel_code
  );

  return new;
end;
$$;

comment on function public.link_cart_conversion_attribution() is
  'Propaga el origen del carrito (visitante, contacto y conversación) a la '
  'reserva o venta en que se convierte. Los enlaces son de escritura única: '
  'attach_attribution ignora un segundo valor distinto.';

-- Candado de 0045: una función de trigger la invoca el motor con el dueño de
-- la tabla, jamás un cliente. PostgreSQL concede EXECUTE a PUBLIC por omisión,
-- así que aquí se cierra explícitamente — si no, anon podría llamarla suelta y
-- escribir atribuciones a mano.
revoke all on function public.link_cart_conversion_attribution() from public;
revoke all on function public.link_cart_conversion_attribution() from anon;
revoke all on function public.link_cart_conversion_attribution() from authenticated;

-- Solo cuando la conversión ESTAMPA el destino: pasar de null a un id. Las
-- demás actualizaciones del carrito (sincronizar líneas, tocar actividad) no
-- despiertan el trigger.
drop trigger if exists public_carts_link_attribution on public.public_carts;

create trigger public_carts_link_attribution
after update on public.public_carts
for each row
when (
  (new.converted_reservation_id is not null
     and old.converted_reservation_id is distinct from new.converted_reservation_id)
  or
  (new.converted_sale_id is not null
     and old.converted_sale_id is distinct from new.converted_sale_id)
)
execute function public.link_cart_conversion_attribution();

-- ---------------------------------------------------------------------------
-- 2. Los carritos ya convertidos también recuperan su origen
-- ---------------------------------------------------------------------------
-- Sin esto, las conversiones anteriores a esta migración quedarían para
-- siempre sin origen y la analítica compararía peras con manzanas.
do $$
declare
  cart record;
  contact_id uuid;
  linked integer := 0;
begin
  for cart in
    select pc.*
    from public.public_carts pc
    where (pc.converted_reservation_id is not null or pc.converted_sale_id is not null)
      and not exists (
        select 1 from public.channel_attributions a
        where (pc.converted_reservation_id is not null and a.reservation_id = pc.converted_reservation_id)
           or (pc.converted_sale_id is not null and a.sale_id = pc.converted_sale_id)
      )
    order by pc.created_at
  loop
    select c.channel_contact_id into contact_id
    from public.channel_conversations c where c.id = cart.conversation_id;

    if cart.anonymous_visitor_id is null and contact_id is null then
      continue;
    end if;

    perform public.attach_attribution(
      p_visitor_id      => cart.anonymous_visitor_id,
      p_contact_id      => contact_id,
      p_conversation_id => cart.conversation_id,
      p_cart_id         => cart.id,
      p_reservation_id  => cart.converted_reservation_id,
      p_sale_id         => cart.converted_sale_id
    );
    linked := linked + 1;
  end loop;

  if linked > 0 then
    raise notice 'Origen recuperado en % conversión(es) anterior(es).', linked;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Humo estructural
-- ---------------------------------------------------------------------------
-- `converted_reservation_id` es una clave foránea, así que un humo honesto
-- necesitaría una reserva real con sus líneas y su inventario: eso pertenece a
-- pgTAP (0047_conversion_attribution.test.sql), donde el comportamiento se
-- prueba de punta a punta. Aquí se comprueba lo que sí corresponde a la
-- migración: que el trigger quedó puesto, activo y sobre el evento correcto,
-- y que la función respeta el candado de 0045 (DEFINER con search_path fijo).
do $$
declare
  trg record;
begin
  select t.tgenabled, pg_get_triggerdef(t.oid) as def into trg
  from pg_trigger t
  where t.tgrelid = 'public.public_carts'::regclass
    and t.tgname = 'public_carts_link_attribution'
    and not t.tgisinternal;

  if trg is null then
    raise exception 'El trigger de atribución no quedó creado sobre public_carts.';
  end if;

  if trg.tgenabled = 'D' then
    raise exception 'El trigger de atribución quedó deshabilitado.';
  end if;

  if trg.def not ilike '%converted_reservation_id%' or trg.def not ilike '%converted_sale_id%' then
    raise exception 'El trigger no vigila ambas conversiones (reserva y venta).';
  end if;

  if not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = 'link_cart_conversion_attribution'
      and p.prosecdef
      and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%')
  ) then
    raise exception 'link_cart_conversion_attribution debe ser DEFINER con search_path fijado.';
  end if;

  raise notice 'Humo OK: trigger de atribución activo sobre reserva y venta.';
end;
$$;
