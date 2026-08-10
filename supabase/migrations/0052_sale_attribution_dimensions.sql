-- ---------------------------------------------------------------------------
-- 0052 · Origen, canal, forma de nacer y entrega dejan de ser el mismo campo
-- ---------------------------------------------------------------------------
-- `sales.source_channel` es un enum
-- (`in_store|web|whatsapp|facebook|instagram|tiktok|phone|other`) que obliga a
-- elegir UNA cosa cuando en realidad hay cuatro, y encima las hace mutuamente
-- excluyentes. El caso que lo rompe es corriente en Bellaroshé:
--
--   una clienta ve un TikTok, escribe por WhatsApp, y va a la tienda a pagar.
--
-- Con un solo campo hay que mentir tres veces: si se marca `tiktok` se pierde
-- que se atendió por WhatsApp y se cerró en mostrador; si se marca `whatsapp`,
-- TikTok pierde una venta que sí generó; si se marca `in_store`, se pierden las
-- dos. Ninguna de las tres respuestas es cierta porque la pregunta está mal
-- planteada. Son cuatro dimensiones independientes:
--
--   entry_mode           cómo NACIÓ la venta      store_quick · conversation ·
--                                                 reservation · public_cart
--   acquisition_source   de dónde vino la clienta instagram · tiktok · facebook ·
--                                                 whatsapp_direct · store_direct ·
--                                                 website
--   conversation_channel dónde se la atendió      whatsapp · instagram · …
--   fulfillment          cómo se le entrega       in_store · pickup ·
--                                                 local_delivery · shipping
--
-- Y así la venta se lee «Instagram → WhatsApp», «TikTok → WhatsApp» o
-- simplemente «Tienda», que es lo que de verdad pasó.
--
-- REGLA QUE MANDA SOBRE TODO ESTO: la vendedora no escribe «Origen» nunca. En
-- mostrador la sesión fija store_quick/store_direct sin preguntar; cuando la
-- venta viene de un canal, hereda la atribución de su conversación, carrito o
-- reserva. Un desplegable de origen en la pantalla de venta es exactamente el
-- dato que nadie mantiene y que después nadie puede creer.
--
-- No se inventa un grafo nuevo: la cadena campaña → canal → conversación →
-- carrito/reserva → venta ya existe (`channels`, `marketing_sources`,
-- `marketing_campaigns`, `channel_attributions`, y el trigger de 0047 que
-- sobrevive a la conversión del carrito). Esta migración le añade lo que le
-- falta para atribuir automáticamente y para CONGELAR el resultado.
--
-- Por qué congelar: `channel_attributions` es un registro vivo — sus campos
-- `last_*` se mueven con cada toque posterior. Si un informe de ventas leyera
-- de ahí, la historia cambiaría sola: una venta de marzo pasaría a contarse
-- como de la campaña de agosto en cuanto la misma clienta volviera a hacer
-- clic. La venta guarda su propia foto y no se recalcula jamás.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Vocabulario nuevo
-- ---------------------------------------------------------------------------
create type public.sale_entry_mode as enum (
  'store_quick',   -- mostrador: la vendedora la abrió y la cobró
  'conversation',  -- nació atendiendo un chat
  'reservation',   -- se cargó una reserva ya existente
  'public_cart'    -- la clienta armó el carrito en la web
);

comment on type public.sale_entry_mode is
  'Cómo nació la venta. NO es su origen de captación: una venta store_quick '
  'puede perfectamente venir de Instagram si la clienta llegó por un anuncio y '
  'terminó pagando en mostrador.';

create type public.attribution_method as enum (
  'meta_referral',   -- el webhook de WhatsApp trajo referral/ctwa_clid
  'smart_link',      -- pasó por un enlace propio y su código corto
  'direct',          -- sin rastro previo: mostrador o WhatsApp directo
  'admin_override'   -- corrección manual, auditable
);

comment on type public.attribution_method is
  'Cómo se supo el origen. `admin_override` existe solo como emergencia '
  'auditable y NUNCA se le ofrece a una vendedora en el flujo de venta.';

-- `delivery` no distinguía el reparto propio en Lima del envío por agencia a
-- provincia, que tienen costo, plazo y responsabilidad distintos. Las 7 ventas
-- existentes son todas in_store, así que el rename no reescribe historia.
alter type public.fulfillment_method rename value 'delivery' to 'local_delivery';
alter type public.fulfillment_method add value if not exists 'shipping';

-- ---------------------------------------------------------------------------
-- 2. Orígenes de captación que faltaban
-- ---------------------------------------------------------------------------
-- `marketing_sources` ya tenía instagram/facebook/tiktok/qr/referral/organic.
-- Faltaba nombrar los tres que el POS necesita para no volver a conflacionar.
-- Ojo con `whatsapp`: como ORIGEN significa «escribió sola por WhatsApp», que
-- no es lo mismo que WhatsApp como CANAL de atención (eso vive en `channels`).
-- Se añade `whatsapp_direct` para que la diferencia sea imposible de confundir.
insert into public.marketing_sources (code, name, is_active) values
  ('store_direct',    'Tienda (llegó sola)', true),
  ('whatsapp_direct', 'WhatsApp directo',    true),
  ('website',         'Sitio web',           true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. La venta guarda su foto congelada
-- ---------------------------------------------------------------------------
alter table public.sales
  add column entry_mode public.sale_entry_mode not null default 'store_quick',
  add column conversation_id uuid references public.channel_conversations (id),
  add column attribution_id uuid references public.channel_attributions (id),
  add column acquisition_source_id uuid references public.marketing_sources (id),
  add column conversation_channel_id uuid references public.channels (id),
  add column campaign_id uuid references public.marketing_campaigns (id),
  add column attribution_method public.attribution_method not null default 'direct',
  add column attribution_snapshot jsonb not null default '{}'::jsonb;

comment on column public.sales.entry_mode is
  'Cómo nació la venta. La pantalla de mostrador lo fija en store_quick sin preguntar.';
comment on column public.sales.acquisition_source_id is
  'Origen de captación CONGELADO al confirmar. No se recalcula nunca: si la '
  'clienta vuelve por otro canal, esa es otra venta con su propia atribución.';
comment on column public.sales.conversation_channel_id is
  'Canal donde se la atendió. Junto al origen produce «Instagram → WhatsApp».';
comment on column public.sales.attribution_snapshot is
  'Foto completa del momento de confirmar: ad_set, ad, creative, click_id, '
  'touch_id y utm. Los escalares de arriba son para agrupar en informes; esto '
  'es para poder auditar y para devolver conversiones a Meta/TikTok después.';
comment on column public.sales.source_channel is
  'OBSOLETO desde 0052: mezclaba origen, canal y forma de cierre en un solo '
  'enum. Se conserva para no romper lecturas antiguas y se deriva de las '
  'dimensiones nuevas. No escribir desde código nuevo.';

create index sales_acquisition_source_idx on public.sales (acquisition_source_id, issued_at desc);
create index sales_campaign_idx on public.sales (campaign_id, issued_at desc)
  where campaign_id is not null;
create index sales_conversation_idx on public.sales (conversation_id)
  where conversation_id is not null;

-- ---------------------------------------------------------------------------
-- 4. La atribución aprende a identificar el clic
-- ---------------------------------------------------------------------------
-- Los identificadores van con prefijo `last_` porque describen el TOQUE que se
-- va a acreditar, siguiendo la convención first_/last_ que ya tenía la tabla.
-- El detalle del primer toque sigue viviendo en `first_utm`.
alter table public.channel_attributions
  add column last_ad_set_id text,
  add column last_ad_id text,
  add column last_creative_id text,
  add column click_id text,
  add column click_id_kind text check (click_id_kind in ('ctwa_clid', 'ttclid')),
  add column touch_id text,
  add column attribution_method public.attribution_method not null default 'direct',
  add column raw_event jsonb;

comment on column public.channel_attributions.last_ad_id is
  'Id del anuncio tal cual lo manda la plataforma (`referral.source_id` en '
  'Click-to-WhatsApp). Para saber con certeza si fue Instagram o Facebook hay '
  'que separar los ad sets por plataforma al montar la campaña: el webhook no '
  'trae el placement exacto. Eso lo configura marketing una vez, no la vendedora.';
comment on column public.channel_attributions.click_id is
  'Identificador del clic publicitario: ctwa_clid en Meta, ttclid en TikTok. Es '
  'lo que después permite devolver la conversión por Conversions API / Events API.';
comment on column public.channel_attributions.touch_id is
  'Código del Smart Link propio (bellaroshe.pe/w/...). Viaja abreviado dentro '
  'del mensaje precargado de WhatsApp para poder enlazar la conversación entrante '
  'con el Reel, la story o el QR que la originó.';

create index channel_attributions_click_idx on public.channel_attributions (click_id)
  where click_id is not null;
-- `channel_attributions_touch_idx` ya existe y es por `first_touch_at`; este
-- índice es del código del Smart Link, que es otra cosa.
create index channel_attributions_touch_code_idx on public.channel_attributions (touch_id)
  where touch_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Las ventas que ya existen
-- ---------------------------------------------------------------------------
-- Las 7 son de mostrador. Se traducen a la dimensión correcta en vez de
-- quedarse con el default mudo, para que los informes no tengan un agujero.
update public.sales s
set acquisition_source_id = (select id from public.marketing_sources where code = 'store_direct'),
    conversation_channel_id = (select id from public.channels where code = 'store'),
    entry_mode = case when s.reservation_id is not null then 'reservation'::public.sale_entry_mode
                      else 'store_quick'::public.sale_entry_mode end
where s.source_channel = 'in_store';

-- ---------------------------------------------------------------------------
-- 6. Congelado de verdad
-- ---------------------------------------------------------------------------
-- La regla «no se recalcula históricamente» no se deja en manos de quien
-- escriba el próximo informe o el próximo script de backfill: la impone la
-- base. Una venta confirmada no puede cambiar de origen. Corregir una mal
-- atribuida exige pasar por `admin_override`, que queda registrado.
create or replace function public.freeze_sale_attribution()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status <> 'confirmed' then
    return new;
  end if;

  -- La corrección manual se permite siempre que se DECLARE como tal. Exigir
  -- además que la venta no estuviera ya corregida dejaría una corrección
  -- equivocada congelada para siempre, que es peor que el problema.
  if new.attribution_method = 'admin_override' then
    return new;
  end if;

  if new.acquisition_source_id is distinct from old.acquisition_source_id
     or new.conversation_channel_id is distinct from old.conversation_channel_id
     or new.campaign_id is distinct from old.campaign_id
     or new.attribution_snapshot is distinct from old.attribution_snapshot then
    raise exception
      'La atribución de una venta confirmada no se recalcula (venta %). Para '
      'corregirla, marcar attribution_method = admin_override.', old.sale_number
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function public.freeze_sale_attribution() is
  'Impide que una venta confirmada cambie de origen. Sin esto, un informe de '
  'marzo se reescribiría solo en cuanto la misma clienta volviera a hacer clic '
  'en un anuncio de agosto.';

create trigger sales_freeze_attribution
  before update on public.sales
  for each row
  execute function public.freeze_sale_attribution();

-- La invoca PostgreSQL al escribir en `sales`, nunca un cliente. Toda función
-- nueva nace ejecutable por el rol PUBLIC —y `anon` es miembro de PUBLIC—, así
-- que sin este revoke queda llamable desde fuera. 0045 cerró esa puerta para lo
-- que existía entonces; lo que nace después la cierra en su propia migración.
revoke execute on function public.freeze_sale_attribution() from public;
