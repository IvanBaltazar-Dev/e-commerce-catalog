-- ---------------------------------------------------------------------------
-- 0066 · El saldo por cobrar descuenta lo que la clienta devolvió
-- ---------------------------------------------------------------------------
-- DEFECTO ENCONTRADO AL REVISAR LAS DEVOLUCIONES SOBRE VENTAS CONTRA ENTREGA.
-- Reproducido antes de tocar nada:
--
--   Venta contra entrega de S/ 60, adelanto de S/ 5. El motorizado llega, la
--   clienta rechaza una unidad de S/ 15 y se la devuelve en el acto. No se le
--   reembolsa nada, porque nunca pagó por esa unidad: solo había adelantado 5.
--
--   El sistema decía que debía S/ 55. Debe S/ 40 —60 menos los 15 que devolvió,
--   menos los 5 que adelantó— y `settle_sale_balance` cobraba los 55 sin
--   protestar. Quince soles de más, en la puerta de su casa.
--
-- La causa es que el saldo se calculaba como `total - cobrado`, y esa resta
-- ignora que parte de la mercadería volvió. La devolución existía, estaba bien
-- registrada y valorada —`return_lines.refund_amount` guarda cuánto vale lo que
-- volvió—, pero nadie la restaba de lo que quedaba por cobrar.
--
-- LA FÓRMULA COMPLETA es esta, y a partir de aquí vive en UN solo sitio:
--
--   pendiente = total − devuelto − cobrado + reembolsado
--
--   · devuelto     lo que la clienta ya no se lleva (valor de lo devuelto)
--   · cobrado      lo que entregó
--   · reembolsado  lo que se le devolvió en dinero, que vuelve a deberse
--
-- Comprobada en los dos sentidos: una venta al contado con devolución y su
-- reembolso da cero (60 − 15 − 60 + 15), y la contra entrega del ejemplo da 40.
--
-- LO QUE NO CAMBIA: `sale_payment_problem`. Esa regla dice si la venta se cobró
-- COMO CORRESPONDÍA EN SU MOMENTO —entera si era inmediata, con su adelanto si
-- era contra entrega— y una devolución posterior no invalida aquel cobro. Son
-- dos preguntas distintas y se responden por separado.
-- ---------------------------------------------------------------------------

/**
 * Cuánto le queda por pagar a la clienta, ya descontado lo que devolvió.
 *
 * Puede salir NEGATIVO, y eso es información, no un error: significa que la
 * tienda le debe dinero a ella —devolvió más de lo que le queda por pagar— y
 * que lo que corresponde es un reembolso, no un cobro.
 */
create or replace function public.sale_pending_amount(p_sale_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select round(
    s.total
    - coalesce((
        select sum(rl.refund_amount)
        from public.return_lines rl
        join public.returns r on r.id = rl.return_id
        where r.sale_id = s.id
      ), 0)
    - coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0)
    + coalesce((
        select sum(f.amount)
        from public.refunds f
        where f.return_id in (select r.id from public.returns r where r.sale_id = s.id)
           or f.sale_cancellation_id in (select c.id from public.sale_cancellations c where c.sale_id = s.id)
      ), 0)
  , 2)
  from public.sales s
  where s.id = p_sale_id;
$$;

comment on function public.sale_pending_amount(uuid) is
  'Lo que la clienta todavía debe: total menos lo devuelto, menos lo cobrado, '
  'más lo que ya se le reembolsó. Única definición del saldo; en negativo '
  'significa que la deuda es de la tienda.';

revoke execute on function public.sale_pending_amount(uuid) from public;
grant execute on function public.sale_pending_amount(uuid) to authenticated, service_role;

/** Valor de lo que volvió a la tienda. Se expone para poder EXPLICAR el saldo:
 *  un número que baja sin decir por qué se lee como un error. */
create or replace function public.sale_returned_amount(p_sale_id uuid)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(round(sum(rl.refund_amount), 2), 0)
  from public.return_lines rl
  join public.returns r on r.id = rl.return_id
  where r.sale_id = p_sale_id;
$$;

revoke execute on function public.sale_returned_amount(uuid) from public;
grant execute on function public.sale_returned_amount(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cobrar el saldo, ya sin cobrar de más
-- ---------------------------------------------------------------------------
create or replace function public.settle_sale_balance(
  p_sale_id uuid,
  p_payments jsonb,
  p_client_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  v_sale public.sales%rowtype;
  payment jsonb;
  v_pendiente numeric(12, 2);
  v_nuevo numeric(12, 2) := 0;
  v_problema text;
begin
  if p_client_operation_id is null then
    raise exception using errcode = '22023', message = 'Falta el identificador de operación.';
  end if;

  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception using errcode = '22023', message = 'Esa venta no existe.';
  end if;

  perform public.assert_branch_access(v_sale.branch_id, 'cobrar el saldo de una venta');

  -- EL CANDADO ES DE LA VENTA (0064): con el identificador de operación dentro,
  -- dos celulares cobrando a la vez tomaban candados distintos y los dos
  -- cobraban.
  perform pg_advisory_xact_lock(hashtextextended(p_sale_id::text, 0));

  if exists (select 1 from public.sale_payments where client_operation_id = p_client_operation_id) then
    return public.sale_detail(p_sale_id);
  end if;

  if v_sale.status = 'cancelled' then
    raise exception using errcode = '23514',
      message = 'Esta venta está anulada: su saldo se resuelve por devolución, no cobrando.';
  end if;

  if v_sale.payment_terms <> 'on_delivery' then
    raise exception using errcode = '23514',
      message = 'Esta venta se cobró al registrarla: no tiene saldo pendiente.';
  end if;

  -- Se relee DESPUÉS del candado, y ya descontando lo devuelto: si la clienta
  -- rechazó parte del pedido al recibirlo, esa parte no se le cobra.
  v_pendiente := public.sale_pending_amount(p_sale_id);

  if v_pendiente < 0 then
    raise exception using errcode = '23514',
      message = format('Esta venta no tiene saldo por cobrar: la tienda le debe %s a la clienta.',
                       abs(v_pendiente));
  end if;

  if v_pendiente = 0 then
    raise exception using errcode = '23514', message = 'Esta venta ya está cobrada por completo.';
  end if;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  for payment in select value from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    insert into public.sale_payments (
      sale_id, method, amount, tendered_amount, reference, evidence_path,
      received_at, applied_at, created_by, created_by_label, client_operation_id
    ) values (
      p_sale_id,
      (payment ->> 'method')::public.payment_method,
      (payment ->> 'amount')::numeric,
      nullif(payment ->> 'tenderedAmount', '')::numeric,
      nullif(payment ->> 'reference', ''),
      nullif(payment ->> 'evidencePath', ''),
      coalesce(nullif(payment ->> 'receivedAt', '')::timestamptz, now()),
      now(), actor, actor_name, p_client_operation_id
    );

    v_nuevo := v_nuevo + (payment ->> 'amount')::numeric;
  end loop;

  -- El saldo se cobra de una vez, aunque se reparta entre varios medios.
  if v_nuevo <> v_pendiente then
    raise exception using errcode = '23514',
      message = format('El saldo pendiente es %s y lo que se está cobrando suma %s.',
                       v_pendiente, v_nuevo);
  end if;

  -- Las condiciones de pago NO se tocan: cómo se vendió es un hecho.
  v_problema := public.sale_payment_problem(p_sale_id);
  if v_problema is not null then
    raise exception using errcode = '23514', message = v_problema;
  end if;

  return public.sale_detail(p_sale_id);
exception
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$$;

comment on function public.settle_sale_balance(uuid, jsonb, uuid) is
  'Cobra el saldo de una venta contra entrega, descontando lo que la clienta '
  'devolvió al recibir. El candado es de la venta, así que dos dispositivos a la '
  'vez no pueden cobrarlo dos veces.';

revoke execute on function public.settle_sale_balance(uuid, jsonb, uuid) from public;
grant execute on function public.settle_sale_balance(uuid, jsonb, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Y lo que se lee en pantalla dice lo mismo
-- ---------------------------------------------------------------------------
create or replace function public.pending_operations()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ventas as (
    select
      s.id, s.sale_number as number, s.issued_at as happened_at, s.branch_id,
      s.fulfillment_method, s.fulfillment_status, s.payment_terms,
      s.customer_name, s.customer_phone, s.person_id, s.total,
      coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0) as paid,
      public.sale_pending_amount(s.id) as pendiente,
      public.sale_returned_amount(s.id) as devuelto
    from public.sales s
    where s.status = 'confirmed'
      and (s.fulfillment_status <> 'delivered' or s.payment_terms = 'on_delivery')
  )
  select jsonb_build_object(
    'sales', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'sale',
        'id', v.id,
        'number', v.number,
        'happenedAt', v.happened_at,
        'branchId', v.branch_id,
        'customerName', coalesce(
          (select pr.full_name from public.persons pr where pr.id = v.person_id),
          v.customer_name
        ),
        'customerPhone', v.customer_phone,
        'fulfillmentMethod', v.fulfillment_method,
        'fulfillmentStatus', v.fulfillment_status,
        'paymentTerms', v.payment_terms,
        'total', v.total,
        'paidTotal', v.paid,
        'returnedTotal', v.devuelto,
        'balance', v.pendiente,
        'needsDelivery', v.fulfillment_status <> 'delivered',
        -- Solo se cobra lo que de verdad se debe. Un saldo negativo NO es un
        -- pendiente de cobro: es un reembolso pendiente, y se resuelve por otro
        -- camino.
        'needsPayment', v.pendiente > 0
      ) order by v.happened_at)
      from ventas v
      where v.fulfillment_status <> 'delivered' or v.pendiente > 0
    ), '[]'::jsonb),
    'reservations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', 'reservation',
        'id', r.id,
        'number', r.reservation_number,
        'happenedAt', r.expires_at,
        'branchId', r.branch_id,
        'customerName', coalesce(
          (select pr.full_name from public.persons pr where pr.id = r.person_id),
          r.customer_name
        ),
        'customerPhone', r.customer_phone,
        'total', r.total,
        'paidTotal', coalesce((select sum(p.amount) from public.reservation_payments p where p.reservation_id = r.id), 0),
        'balance', r.total - coalesce((select sum(p.amount) from public.reservation_payments p where p.reservation_id = r.id), 0),
        'expiresAt', r.expires_at
      ) order by r.expires_at)
      from public.reservations r
      where r.status = 'active'
    ), '[]'::jsonb)
  );
$$;

comment on function public.pending_operations() is
  'Lo que queda por hacer: reservas vivas, pedidos por entregar y ventas por '
  'cobrar. El saldo se resuelve AQUÍ y ya viene neto de devoluciones.';

revoke execute on function public.pending_operations() from public;
grant execute on function public.pending_operations() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El detalle de la venta, con el saldo neto y lo devuelto a la vista
-- ---------------------------------------------------------------------------
-- `returnedTotal` se expone para poder EXPLICAR por qué bajó el saldo: un
-- número que baja sin decir por qué se lee como un error del sistema.

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
    -- DÓNDE está el pedido. Ni si la venta vale ni si está cobrada: la tercera
    -- dimensión, que 0064 añadió y sin esta clave sería invisible en pantalla.
    'fulfillmentStatus', s.fulfillment_status,
    'paymentTerms', s.payment_terms,
    'customerName', s.customer_name,
    'customerPhone', s.customer_phone,
    'customerDocument', s.customer_document,
    'deliveryAddress', s.delivery_address,
    'personId', s.person_id,
    'grossSubtotal', s.gross_subtotal,
    'discountTotal', s.discount_total,
    'total', s.total,
    'currency', s.currency,
    -- Lo cobrado, lo devuelto y lo que falta se derivan: no hay una columna
    -- «saldo» que pueda quedarse desfasada de la suma que dice representar.
    -- Y desde 0066 el saldo va NETO de devoluciones: lo que la clienta rechazó
    -- al recibir no se le vuelve a cobrar.
    'paidTotal', coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0),
    'returnedTotal', public.sale_returned_amount(s.id),
    'balance', public.sale_pending_amount(s.id),
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