-- ---------------------------------------------------------------------------
-- 0053 · La venta nace sabiendo de dónde vino, y se congela ahí
-- ---------------------------------------------------------------------------
-- 0052 creó las cuatro dimensiones pero nadie las escribía: las columnas
-- existían con su default y toda venta salía «store_quick / store_direct»
-- aunque viniera de un anuncio. Esta migración cierra el circuito.
--
-- Dos piezas, y la división entre ellas importa:
--
--   1. `register_sale` recibe `p_entry_mode` y `p_conversation_id`. Es lo único
--      que el llamante SÍ sabe y la base no puede adivinar: si la vendedora
--      abrió una venta de mostrador o si está atendiendo un chat concreto.
--
--   2. Todo lo demás —origen de captación, canal, campaña, anuncio, click_id—
--      lo resuelve un trigger leyendo la cadena de atribución. NO es un
--      parámetro. Si lo fuera, tarde o temprano alguien pondría un desplegable
--      delante de la vendedora, que es exactamente lo que este diseño prohíbe.
--
-- El trigger sigue la doctrina de 0047: el enlace no se deja en manos de quien
-- llame. Da igual si la venta la registra el POS, un script de migración o una
-- pantalla que todavía no existe — la atribución se resuelve igual, una vez, y
-- queda congelada por el trigger de 0052.
--
-- Qué NO hace: inventar un origen. Una venta sin conversación y sin reserva
-- atribuida es de mostrador, y `store_direct` es un dato afirmativo, no un
-- «desconocido». Marcarla como `unknown` sería mentir sobre lo que se sabe.
--
-- Ojo con la firma: añadir parámetros a una función de PostgreSQL crea una
-- SOBRECARGA, no un reemplazo. Hay que borrar la anterior explícitamente o
-- quedan dos `register_sale` y las llamadas se vuelven ambiguas. Al borrarla se
-- pierden los GRANT, así que se rehacen abajo.
-- ---------------------------------------------------------------------------

drop function if exists public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text
);

CREATE OR REPLACE FUNCTION public.register_sale(p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_client_operation_id uuid, p_source_channel sale_source_channel DEFAULT 'in_store'::sale_source_channel, p_fulfillment_method fulfillment_method DEFAULT 'in_store'::fulfillment_method, p_customer jsonb DEFAULT NULL::jsonb, p_discount_total numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_reservation_id uuid DEFAULT NULL::uuid, p_source_reference text DEFAULT NULL::text, p_entry_mode public.sale_entry_mode DEFAULT 'store_quick'::public.sale_entry_mode, p_conversation_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  actor_name text;
  actor_max_percent numeric(5, 2);
  actor_max_amount numeric(12, 2);
  existing_id uuid;
  evaluation jsonb;
  line jsonb;
  payment jsonb;
  discounts jsonb;
  movements jsonb := '[]'::jsonb;
  movement jsonb;
  new_sale_id uuid := gen_random_uuid();
  sale_number text;
  gross numeric(12, 2) := 0;
  discount_sum numeric(12, 2) := 0;
  net_total numeric(12, 2) := 0;
  idx integer := 0;
  line_discount numeric(12, 2);
  line_subtotal numeric(12, 2);
  new_line_id uuid;
  paid numeric(12, 2) := 0;
  reservation public.reservations%rowtype;
  ordered_lines jsonb;
  tracked boolean;
begin
  if p_client_operation_id is null then
    raise exception using errcode = '22023', message = 'Falta el identificador de operación.';
  end if;

  perform public.assert_branch_access(p_branch_id, 'registrar ventas');

  -- IDEMPOTENCIA. El candado consultivo serializa los reintentos del mismo
  -- botón ANTES de tocar inventario: sin él, dos peticiones simultáneas con el
  -- mismo client_operation_id descontarían dos veces la existencia y solo la
  -- segunda moriría contra el índice único, dejando el kardex adelantado.
  perform pg_advisory_xact_lock(
    hashtextextended(p_branch_id::text || ':' || p_client_operation_id::text, 0)
  );

  select id into existing_id from public.sales
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing_id is not null then
    return public.sale_detail(existing_id);
  end if;

  select nullif(trim(coalesce(p.full_name, '')), ''), p.max_discount_percent, p.max_discount_amount
    into actor_name, actor_max_percent, actor_max_amount
  from public.admin_profiles p where p.id = actor;

  -- ------------------------------------------------------------------
  -- Resolución de las líneas
  -- ------------------------------------------------------------------
  if p_reservation_id is not null then
    -- Transición CONDICIONAL antes de tocar nada: bajo READ COMMITTED
    -- PostgreSQL reevalúa el predicado al liberar el candado (EvalPlanQual), de
    -- modo que dos conversiones simultáneas dan una sola venta sin bloqueos
    -- adicionales. Leer-decidir-escribir daría dos.
    update public.reservations
    set status = 'converted', updated_at = now()
    where id = p_reservation_id and status = 'active'
    returning * into reservation;

    if reservation.id is null then
      raise exception using errcode = '23514',
        message = 'La reserva no está activa: pudo vencer, liberarse o convertirse en otra venta.';
    end if;

    if reservation.branch_id <> p_branch_id then
      raise exception using errcode = '22023', message = 'La reserva pertenece a otra sede.';
    end if;

    -- Precios CONGELADOS al reservar: ver la decisión C de la cabecera.
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'variantId', l.variant_id, 'sku', l.sku, 'productName', l.product_name,
        'variantName', l.variant_name, 'brandName', l.brand_name,
        'quantity', l.quantity, 'unitPrice', l.unit_price,
        'subtotal', l.subtotal, 'purchaseMode', l.purchase_mode,
        'reservedStock', l.reserved_stock
      ) order by l.variant_id
    ), '[]'::jsonb)
      into ordered_lines
    from public.reservation_lines l
    where l.reservation_id = reservation.id;
  else
    if p_lines is null or jsonb_array_length(p_lines) = 0 then
      raise exception using errcode = '22023', message = 'La venta necesita al menos una línea.';
    end if;

    -- Precio, modalidad y disponibilidad se resuelven en PostgreSQL, nunca en
    -- el navegador. evaluate_cart_v2 aplica la regla mayorista y, desde 0028,
    -- devuelve la disponibilidad EFECTIVA contra existencias.
    evaluation := public.evaluate_cart_v2(p_lines);

    if exists (
      select 1 from jsonb_array_elements(evaluation -> 'lines') l
      where l ->> 'availability' = 'sold_out'
    ) then
      raise exception using errcode = '23514', message = 'La venta contiene una presentación agotada.';
    end if;

    if exists (
      select 1 from jsonb_array_elements(evaluation -> 'lines') l
      where (l ->> 'unitPrice') is null
    ) then
      raise exception using errcode = '22023',
        message = 'Hay una presentación sin precio: debe consultarse antes de vender.';
    end if;

    -- Orden ESTABLE por variante: es lo que impide el interbloqueo cuando dos
    -- ventas comparten variantes.
    select jsonb_agg(l order by (l ->> 'variantId'))
      into ordered_lines
    from jsonb_array_elements(evaluation -> 'lines') l;
  end if;

  if ordered_lines is null or jsonb_array_length(ordered_lines) = 0 then
    raise exception using errcode = '22023', message = 'La venta necesita al menos una línea.';
  end if;

  for line in select value from jsonb_array_elements(ordered_lines) loop
    gross := gross + ((line ->> 'subtotal')::numeric);
  end loop;

  discounts := public.prorate_discount(ordered_lines, coalesce(p_discount_total, 0));

  -- Límite de descuento: restricción automática, no flujo de aprobación.
  if coalesce(p_discount_total, 0) > 0 and actor is not null and not public.is_admin() then
    if actor_max_amount is null and actor_max_percent is null then
      raise exception using errcode = '42501',
        message = 'No tienes un límite de descuento autorizado. Pide a administración que lo configure.';
    end if;

    if actor_max_amount is not null and p_discount_total > actor_max_amount then
      raise exception using errcode = '42501',
        message = format('El descuento supera tu límite autorizado de %s.', actor_max_amount);
    end if;

    if actor_max_percent is not null and gross > 0
       and round((p_discount_total / gross) * 100, 2) > actor_max_percent then
      raise exception using errcode = '42501',
        message = format('El descuento supera tu límite autorizado de %s%%.', actor_max_percent);
    end if;
  end if;

  -- ------------------------------------------------------------------
  -- 1) INVENTARIO. Primero, y en orden estable por variante.
  -- ------------------------------------------------------------------
  for line in select value from jsonb_array_elements(ordered_lines) loop
    select v.tracks_inventory into tracked
    from public.product_variants v where v.id = (line ->> 'variantId')::uuid;

    if coalesce(tracked, false) then
      -- La reserva ya comprometió estas unidades: se libera lo comprometido
      -- ANTES de descontar la existencia, o el check `reserved <= on_hand`
      -- abortaría la propia conversión que él debía proteger.
      if coalesce((line ->> 'reservedStock')::boolean, false) then
        update public.inventory_stock
        set reserved = greatest(reserved - (line ->> 'quantity')::integer, 0)
        where variant_id = (line ->> 'variantId')::uuid and branch_id = p_branch_id;
      end if;

      movement := public.apply_inventory_movement(
        (line ->> 'variantId')::uuid, p_branch_id, 'sale',
        -1 * (line ->> 'quantity')::integer, null,
        'sale', new_sale_id, null, 'Venta', actor
      );
    else
      -- Ver la decisión B de la cabecera: lo que no se sigue, no se mueve. El
      -- costo queda declarado como desconocido, que es consultable, en lugar de
      -- confundirse con un margen del 100 %.
      movement := jsonb_build_object(
        'costBasis', 'unknown', 'unitCost', null, 'valueDelta', 0,
        'valuedUnits', 0, 'unvaluedUnits', (line ->> 'quantity')::integer
      );
    end if;

    movements := movements || jsonb_build_array(movement);
  end loop;

  -- ------------------------------------------------------------------
  -- 2) CORRELATIVO. Después del inventario: es el registro más contendido de
  --    la sede y retenerlo antes serializaría toda la caja.
  -- ------------------------------------------------------------------
  sale_number := public.next_document_number(p_branch_id, 'sale_note');

  idx := 0;
  for line in select value from jsonb_array_elements(ordered_lines) loop
    line_discount := coalesce((discounts -> idx ->> 'discount')::numeric, 0);
    discount_sum := discount_sum + line_discount;
    net_total := net_total + ((line ->> 'subtotal')::numeric - line_discount);
    idx := idx + 1;
  end loop;

  insert into public.sales (
    id, branch_id, sale_number, source_channel, source_reference, fulfillment_method,
    customer_name, customer_phone, customer_document, delivery_address,
    gross_subtotal, discount_total, total, notes, reservation_id,
    seller_id, seller_label, client_operation_id,
    entry_mode, conversation_id
  ) values (
    new_sale_id, p_branch_id, sale_number, p_source_channel, p_source_reference, p_fulfillment_method,
    coalesce(nullif(trim(coalesce(p_customer ->> 'name', '')), ''), reservation.customer_name),
    coalesce(nullif(trim(coalesce(p_customer ->> 'phone', '')), ''), reservation.customer_phone),
    coalesce(nullif(trim(coalesce(p_customer ->> 'document', '')), ''), reservation.customer_document),
    nullif(trim(coalesce(p_customer ->> 'address', '')), ''),
    gross, discount_sum, net_total, p_notes, reservation.id,
    actor, actor_name, p_client_operation_id,
    p_entry_mode, p_conversation_id
  );

  -- ------------------------------------------------------------------
  -- 3) LÍNEAS y COSTOS. El costo se captura AHORA, del propio asiento que
  --    acaba de escribirse, y nunca se reconstruye después consultando el
  --    promedio vigente —que para entonces ya habrá cambiado—.
  -- ------------------------------------------------------------------
  idx := 0;
  for line in select value from jsonb_array_elements(ordered_lines) loop
    line_discount := coalesce((discounts -> idx ->> 'discount')::numeric, 0);
    line_subtotal := (line ->> 'subtotal')::numeric - line_discount;
    movement := movements -> idx;

    insert into public.sale_lines (
      sale_id, variant_id, sku, product_name, variant_name, brand_name,
      quantity, unit_price, discount_amount, subtotal, purchase_mode, line_order
    ) values (
      new_sale_id, (line ->> 'variantId')::uuid, line ->> 'sku',
      line ->> 'productName', line ->> 'variantName', line ->> 'brandName',
      (line ->> 'quantity')::integer, (line ->> 'unitPrice')::numeric,
      line_discount, line_subtotal, coalesce(line ->> 'purchaseMode', 'retail'), idx
    )
    returning id into new_line_id;

    -- SIEMPRE hay fila de costo, incluso sin valoración: el hueco debe ser
    -- consultable («cuántas ventas no tienen costo»), no invisible.
    insert into public.sale_line_costs (
      sale_line_id, sale_id, unit_cost, total_cost, cost_basis, valued_units, unvalued_units
    ) values (
      new_line_id, new_sale_id,
      (movement ->> 'unitCost')::numeric,
      case when (movement ->> 'unitCost') is null then null
           else abs(coalesce((movement ->> 'valueDelta')::numeric, 0)) end,
      coalesce((movement ->> 'costBasis')::public.inventory_cost_basis, 'unknown'),
      coalesce((movement ->> 'valuedUnits')::integer, 0),
      coalesce((movement ->> 'unvaluedUnits')::integer, 0)
    );

    idx := idx + 1;
  end loop;

  -- ------------------------------------------------------------------
  -- 4) PAGOS. El adelanto conserva su received_at ORIGINAL para que el arqueo
  --    no lo cuente dos veces: el dinero entró el día que entró.
  -- ------------------------------------------------------------------
  if reservation.id is not null then
    insert into public.sale_payments (
      sale_id, method, amount, currency, reference,
      received_at, applied_at, applied_from_reservation_payment_id,
      created_by, created_by_label
    )
    select
      new_sale_id, 'reservation_advance', rp.amount, rp.currency,
      'Adelanto de ' || reservation.reservation_number,
      rp.received_at, now(), rp.id, actor, actor_name
    from public.reservation_payments rp
    where rp.reservation_id = reservation.id;

    select coalesce(sum(amount), 0) into paid
    from public.sale_payments where sale_id = new_sale_id;
  end if;

  for payment in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into public.sale_payments (
      sale_id, method, amount, tendered_amount, reference, evidence_path,
      received_at, applied_at, created_by, created_by_label
    ) values (
      new_sale_id,
      (payment ->> 'method')::public.payment_method,
      (payment ->> 'amount')::numeric,
      nullif(payment ->> 'tenderedAmount', '')::numeric,
      nullif(payment ->> 'reference', ''),
      nullif(payment ->> 'evidencePath', ''),
      coalesce(nullif(payment ->> 'receivedAt', '')::timestamptz, now()),
      now(), actor, actor_name
    );

    paid := paid + (payment ->> 'amount')::numeric;
  end loop;

  if paid <> net_total then
    raise exception using errcode = '23514',
      message = format('Los pagos aplicados suman %s y el total de la venta es %s.', paid, net_total);
  end if;

  return public.sale_detail(new_sale_id);
exception
  -- Un 23514 crudo imprime la fila entera en el DETAIL, incluido
  -- average_unit_cost, y src/lib/api/http.ts lo reenvía literalmente al
  -- navegador. Se reemite el mensaje sin el detalle.
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$function$;

comment on function public.register_sale is
  'Registra la venta. `p_entry_mode` y `p_conversation_id` son lo único que el '
  'llamante aporta sobre el origen; el resto lo resuelve resolve_sale_attribution(). '
  'La vendedora nunca elige un «origen» en pantalla.';

grant execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El origen se lee de la cadena, no se pregunta
-- ---------------------------------------------------------------------------
create or replace function public.resolve_sale_attribution()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  attribution public.channel_attributions%rowtype;
  conversation_channel uuid;
begin
  -- Rellena, no pisa: si quien inserta ya trajo un origen decidido (corrección
  -- administrativa, backfill de datos históricos), esa decisión manda.
  if new.acquisition_source_id is not null then
    return new;
  end if;

  -- El canal de conversación sale de la conversación misma, que es la verdad
  -- sobre DÓNDE se atendió. No se deduce del toque publicitario.
  if new.conversation_id is not null then
    select acc.channel_id into conversation_channel
    from public.channel_conversations c
    join public.channel_accounts acc on acc.id = c.channel_account_id
    where c.id = new.conversation_id;

    select * into attribution
    from public.channel_attributions a
    where a.conversation_id = new.conversation_id
    order by a.last_touch_at desc
    limit 1;
  end if;

  if attribution.id is null and new.reservation_id is not null then
    select * into attribution
    from public.channel_attributions a
    where a.reservation_id = new.reservation_id
    order by a.last_touch_at desc
    limit 1;
  end if;

  -- Sin rastro: mostrador. Es un dato afirmativo, no un hueco.
  if attribution.id is null then
    new.acquisition_source_id := (select id from public.marketing_sources where code = 'store_direct');
    new.conversation_channel_id := coalesce(
      new.conversation_channel_id,
      conversation_channel,
      (select id from public.channels where code = 'store')
    );
    new.attribution_method := 'direct';
    return new;
  end if;

  new.attribution_id := attribution.id;
  new.acquisition_source_id := attribution.last_source_id;
  new.campaign_id := attribution.last_campaign_id;
  new.attribution_method := attribution.attribution_method;
  new.conversation_channel_id := coalesce(
    new.conversation_channel_id,
    conversation_channel,
    attribution.last_channel_id
  );

  -- La foto. Se guarda entera porque el escalar de arriba sirve para agrupar,
  -- pero devolver la conversión a Meta o TikTok más adelante exige el click_id
  -- exacto, y auditar una atribución discutida exige ver de qué anuncio salió.
  new.attribution_snapshot := jsonb_strip_nulls(jsonb_build_object(
    'ad_set_id',      attribution.last_ad_set_id,
    'ad_id',          attribution.last_ad_id,
    'creative_id',    attribution.last_creative_id,
    'click_id',       attribution.click_id,
    'click_id_kind',  attribution.click_id_kind,
    'touch_id',       attribution.touch_id,
    'last_utm',       nullif(attribution.last_utm, '{}'::jsonb),
    'first_source_id', attribution.first_source_id,
    'first_touch_at', attribution.first_touch_at,
    'frozen_at',      now()
  ));

  return new;
end;
$$;

comment on function public.resolve_sale_attribution() is
  'Resuelve el origen de la venta leyendo su conversación o su reserva. Sin '
  'rastro, la venta es de mostrador (store_direct), que es un dato, no un '
  'desconocido. Lo que aquí se escribe lo congela sales_freeze_attribution.';

create trigger sales_resolve_attribution
  before insert on public.sales
  for each row
  execute function public.resolve_sale_attribution();

-- Función de disparador: la invoca PostgreSQL al insertar en `sales`, nunca un
-- cliente. Toda función nueva nace ejecutable por el rol PUBLIC —y `anon` es
-- miembro de PUBLIC—, así que sin este revoke queda llamable desde fuera. 0045
-- cerró esa puerta para lo que existía entonces; lo que nace después la cierra
-- en su propia migración.
revoke execute on function public.resolve_sale_attribution() from public;
