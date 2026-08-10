-- ---------------------------------------------------------------------------
-- 0061 · La venta escribe sus roles, y la entrega incompleta deja de pasar
-- ---------------------------------------------------------------------------
-- 0060 puso el modelo y la regla, pero dejó dos cosas a medias a propósito:
--
--   · `register_sale` no sabía escribir en `sale_parties`, así que decir «lo
--     recibe su hermana» no tenía por dónde entrar.
--   · No había nada que impidiera registrar un delivery sin destinatario. La
--     regla existía y se podía consultar; no obligaba.
--
-- Las dos entran aquí JUNTAS, y ese es el motivo de que 0060 no las trajera:
-- activar el bloqueo antes de que la pantalla recogiera esos datos habría roto
-- la venta con delivery que hoy funciona.
--
-- El bloqueo es un disparador de restricción DIFERIDO, no una comprobación en
-- el navegador. La diferencia importa: `register_sale` inserta primero la venta
-- y después sus roles, así que una comprobación inmediata dispararía cuando aún
-- no existe el destinatario y rechazaría ventas correctas. Diferido, se evalúa
-- el estado FINAL de la transacción. Y al vivir en la base, la regla vale
-- también para un script, para el asistente y para cualquier pantalla futura:
-- nadie puede saltársela por descuido.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Qué se le dice a quien vende
-- ---------------------------------------------------------------------------
-- El mensaje nombra lo que falta, no la tabla donde falta. Quien cobra necesita
-- saber qué preguntarle a la clienta, y «sale_parties.phone» no es eso.
create or replace function public.enforce_sale_fulfillment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale_id uuid;
  v_gaps text[];
  v_falta text[] := '{}';
  v_gap text;
  v_texto text;
  v_n integer;
begin
  if tg_table_name = 'sales' then
    v_sale_id := new.id;
  elsif tg_op = 'DELETE' then
    v_sale_id := old.sale_id;
  else
    v_sale_id := new.sale_id;
  end if;

  v_gaps := public.sale_fulfillment_gaps(v_sale_id);

  -- Sin huecos, o venta ya borrada (el rol cae por cascada): nada que impedir.
  if array_length(v_gaps, 1) is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  foreach v_gap in array v_gaps loop
    v_falta := v_falta || case v_gap
      when 'recipient' then 'a quién se le entrega'
      when 'phone'     then 'un teléfono de contacto'
      when 'address'   then 'la dirección'
      when 'document'  then 'el documento del destinatario'
      else v_gap
    end;
  end loop;

  -- «A, B y C», no «A, B, C»: el mensaje lo lee una persona con una clienta
  -- delante.
  v_n := array_length(v_falta, 1);
  v_texto := case
    when v_n = 1 then v_falta[1]
    else array_to_string(v_falta[1:v_n - 1], ', ') || ' y ' || v_falta[v_n]
  end;

  raise exception using errcode = '23514',
    message = format('Para entregar esta venta falta %s.', v_texto);
end;
$$;

comment on function public.enforce_sale_fulfillment() is
  'Impide cerrar una venta a la que le falta lo necesario para entregarla. Lee '
  'la misma regla que consulta la pantalla —sale_fulfillment_gaps— para que no '
  'puedan discrepar: la pantalla lo pide antes, esto lo impide después.';

revoke execute on function public.enforce_sale_fulfillment() from public;

-- Diferido: se evalúa al cerrar la transacción, cuando la venta ya tiene sus
-- roles escritos. `of fulfillment_method` acota el UPDATE a lo único que puede
-- volver insuficiente lo que ya estaba completo.
create constraint trigger sales_enforce_fulfillment
  after insert or update of fulfillment_method on public.sales
  deferrable initially deferred
  for each row
  execute function public.enforce_sale_fulfillment();

-- Y por el otro lado: quitar o vaciar al destinatario de una venta ya cerrada
-- la dejaría igual de inentregable que no haberlo puesto nunca.
create constraint trigger sale_parties_enforce_fulfillment
  after update or delete on public.sale_parties
  deferrable initially deferred
  for each row
  execute function public.enforce_sale_fulfillment();

-- ---------------------------------------------------------------------------
-- 2. El detalle de la venta cuenta quién recibe
-- ---------------------------------------------------------------------------
-- Sin esto, la nota impresa y la pantalla de cierre seguirían diciendo el nombre
-- de la compradora donde debería ir el de quien recibe.
create or replace function public.sale_detail(p_sale_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'id', s.id,
    'saleNumber', s.sale_number,
    'branchId', s.branch_id,
    'branchName', (select b.name from public.branches b where b.id = s.branch_id),
    'status', s.status,
    'sourceChannel', s.source_channel,
    'sourceReference', s.source_reference,
    'fulfillmentMethod', s.fulfillment_method,
    'customerName', s.customer_name,
    'customerPhone', s.customer_phone,
    'customerDocument', s.customer_document,
    'deliveryAddress', s.delivery_address,
    'personId', s.person_id,
    'grossSubtotal', s.gross_subtotal,
    'discountTotal', s.discount_total,
    'total', s.total,
    'currency', s.currency,
    'notes', s.notes,
    'reservationId', s.reservation_id,
    'sellerLabel', s.seller_label,
    'issuedAt', s.issued_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'variantId', l.variant_id, 'sku', l.sku,
        'productName', l.product_name, 'variantName', l.variant_name,
        'brandName', l.brand_name,
        'quantity', l.quantity, 'unitPrice', l.unit_price,
        'discountAmount', l.discount_amount, 'subtotal', l.subtotal,
        'purchaseMode', l.purchase_mode,
        'cost', case when public.is_admin() then (
          select jsonb_build_object(
            'unitCost', c.unit_cost, 'totalCost', c.total_cost,
            'costBasis', c.cost_basis,
            'valuedUnits', c.valued_units, 'unvaluedUnits', c.unvalued_units
          )
          from public.sale_line_costs c where c.sale_line_id = l.id
        ) end
      ) order by l.line_order, l.created_at)
      from public.sale_lines l where l.sale_id = s.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'method', p.method, 'amount', p.amount,
        'tenderedAmount', p.tendered_amount,
        'change', case when p.tendered_amount is null then null else p.tendered_amount - p.amount end,
        'reference', p.reference,
        'receivedAt', p.received_at, 'appliedAt', p.applied_at,
        'fromReservation', p.applied_from_reservation_payment_id is not null
      ) order by p.applied_at, p.id)
      from public.sale_payments p where p.sale_id = s.id
    ), '[]'::jsonb),
    -- Los datos que se muestran son los EFECTIVOS: si el rol lo cumple la
    -- compradora y no se repitió nada, aquí sale lo que se sabe de ella. Así la
    -- nota imprime «Recibe: Rosa Díaz» sin que nadie haya copiado su nombre.
    'parties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'role', sp.role,
        'isBuyer', sp.is_buyer,
        'personId', sp.person_id,
        'fullName', coalesce(
          sp.full_name,
          (select pr.full_name from public.persons pr where pr.id = sp.person_id),
          case when sp.is_buyer then s.customer_name end
        ),
        'phone', coalesce(
          sp.phone,
          (select pr.phone_normalized from public.persons pr where pr.id = sp.person_id),
          case when sp.is_buyer then s.customer_phone end
        ),
        'documentNumber', coalesce(
          sp.document_number,
          (select pr.document_number from public.persons pr where pr.id = sp.person_id),
          case when sp.is_buyer then s.customer_document end
        ),
        'address', coalesce(sp.address, s.delivery_address),
        'notes', sp.notes
      ) order by sp.role)
      from public.sale_parties sp where sp.sale_id = s.id
    ), '[]'::jsonb),
    'taxDocument', (
      select jsonb_build_object('id', t.id, 'kind', t.kind, 'status', t.status,
                                'receiverTaxId', t.receiver_tax_id, 'receiverName', t.receiver_name,
                                'requestedAt', t.requested_at)
      from public.tax_document_requests t where t.sale_id = s.id
    )
  )
  from public.sales s where s.id = p_sale_id;
$function$;

-- ---------------------------------------------------------------------------
-- 3. `register_sale` aprende a escribir los roles
-- ---------------------------------------------------------------------------
-- Mismo aviso que en 0053 y 0055: añadir un parámetro crea una SOBRECARGA, hay
-- que borrar la firma anterior y rehacer los privilegios.
drop function if exists public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid
);

CREATE OR REPLACE FUNCTION public.register_sale(p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_client_operation_id uuid, p_source_channel sale_source_channel DEFAULT 'in_store'::sale_source_channel, p_fulfillment_method fulfillment_method DEFAULT 'in_store'::fulfillment_method, p_customer jsonb DEFAULT NULL::jsonb, p_discount_total numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_reservation_id uuid DEFAULT NULL::uuid, p_source_reference text DEFAULT NULL::text, p_entry_mode sale_entry_mode DEFAULT 'store_quick'::sale_entry_mode, p_conversation_id uuid DEFAULT NULL::uuid, p_person_id uuid DEFAULT NULL::uuid, p_parties jsonb DEFAULT NULL::jsonb)
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
  party jsonb;
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
  -- 3) LOS ROLES DE LA ENTREGA. Van pegados a la cabecera porque son parte de
  --    ella: quién recibe y quién está autorizado a recoger. Sus datos son de
  --    ESTA entrega y no tocan la ficha de nadie.
  -- ------------------------------------------------------------------
  for party in select value from jsonb_array_elements(coalesce(p_parties, '[]'::jsonb)) loop
    -- Una fila vacía no es un error de quien vende: es la pantalla mandando un
    -- rol que no se llegó a rellenar. Se ignora, y si de verdad hacía falta, el
    -- disparador diferido lo dirá al cerrar con el nombre de lo que falta.
    if coalesce((party ->> 'isBuyer')::boolean, false)
       or nullif(btrim(coalesce(party ->> 'personId', '')), '') is not null
       or nullif(btrim(coalesce(party ->> 'fullName', '')), '') is not null
    then
      insert into public.sale_parties (
        sale_id, role, person_id, full_name, phone, document_number, address, notes, is_buyer
      ) values (
        new_sale_id,
        (party ->> 'role')::public.sale_party_role,
        nullif(btrim(coalesce(party ->> 'personId', '')), '')::uuid,
        nullif(btrim(coalesce(party ->> 'fullName', '')), ''),
        nullif(btrim(coalesce(party ->> 'phone', '')), ''),
        nullif(btrim(coalesce(party ->> 'documentNumber', '')), ''),
        nullif(btrim(coalesce(party ->> 'address', '')), ''),
        nullif(btrim(coalesce(party ->> 'notes', '')), ''),
        coalesce((party ->> 'isBuyer')::boolean, false)
      );
    end if;
  end loop;

  -- ------------------------------------------------------------------
  -- 4) LÍNEAS y COSTOS. El costo se captura AHORA, del propio asiento que
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
  -- 5) PAGOS. El adelanto conserva su received_at ORIGINAL para que el arqueo
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

comment on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb
) is
  'Registra una venta completa en una sola transacción. `p_parties` trae los '
  'roles de la entrega —quién recibe, quién está autorizado a recoger—; los '
  'campos `customer_*` siguen siendo la instantánea de la compradora.';

revoke execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb
) from public;

grant execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb
) to authenticated, service_role;
