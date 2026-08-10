-- ---------------------------------------------------------------------------
-- 0055 · La venta guarda a QUIÉN se le vendió, no solo cómo se llamaba
-- ---------------------------------------------------------------------------
-- 0054 añadió `sales.person_id` pero `register_sale` no podía escribirlo, así
-- que asociar una clienta desde el mostrador habría copiado su nombre a un
-- campo de texto y perdido el enlace — exactamente el problema que 0054 vino a
-- resolver.
--
-- Mismo aviso que en 0053: añadir un parámetro crea una SOBRECARGA, hay que
-- borrar la firma anterior y rehacer los GRANT.
-- ---------------------------------------------------------------------------

drop function if exists public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid
);

CREATE OR REPLACE FUNCTION public.register_sale(p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_client_operation_id uuid, p_source_channel sale_source_channel DEFAULT 'in_store'::sale_source_channel, p_fulfillment_method fulfillment_method DEFAULT 'in_store'::fulfillment_method, p_customer jsonb DEFAULT NULL::jsonb, p_discount_total numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_reservation_id uuid DEFAULT NULL::uuid, p_source_reference text DEFAULT NULL::text, p_entry_mode sale_entry_mode DEFAULT 'store_quick'::sale_entry_mode, p_conversation_id uuid DEFAULT NULL::uuid, p_person_id uuid DEFAULT NULL::uuid)
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
    entry_mode, conversation_id, person_id
  ) values (
    new_sale_id, p_branch_id, sale_number, p_source_channel, p_source_reference, p_fulfillment_method,
    coalesce(nullif(trim(coalesce(p_customer ->> 'name', '')), ''), reservation.customer_name),
    coalesce(nullif(trim(coalesce(p_customer ->> 'phone', '')), ''), reservation.customer_phone),
    coalesce(nullif(trim(coalesce(p_customer ->> 'document', '')), ''), reservation.customer_document),
    nullif(trim(coalesce(p_customer ->> 'address', '')), ''),
    gross, discount_sum, net_total, p_notes, reservation.id,
    actor, actor_name, p_client_operation_id,
    p_entry_mode, p_conversation_id, p_person_id
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

-- La firma nueva es una función NUEVA para PostgreSQL, y toda función nueva nace
-- ejecutable por el rol PUBLIC, del que `anon` es miembro. Aquí eso no es un
-- detalle de higiene: `assert_branch_access` deja pasar sin comprobar nada cuando
-- no hay usuario en la sesión —así es como entra el servidor con su clave de
-- servicio— y una petición con la clave anon tampoco tiene usuario. Sin este
-- revoke, un desconocido registra ventas, mueve inventario y quema correlativos.
revoke execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid
) from public;

grant execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid
) to authenticated, service_role;
