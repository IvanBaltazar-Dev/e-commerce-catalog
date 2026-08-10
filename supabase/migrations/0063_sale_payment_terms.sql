-- ---------------------------------------------------------------------------
-- 0063 · Contra entrega: la mercadería sale antes que el dinero
-- ---------------------------------------------------------------------------
-- Hasta aquí una venta registrada era, por definición, una venta cobrada:
-- `register_sale` exigía que los pagos sumaran EXACTAMENTE el total. Contra
-- entrega rompe eso, y no por un caso raro: es como se vende a provincia.
--
--   la clienta pide → adelanta (Yape, Plin, a veces transferencia o tarjeta)
--   → se despacha, y el inventario baja → recibe el pedido y paga el saldo
--
-- Entre el tercer paso y el cuarto pueden pasar días, y en ese hueco la tienda
-- ya no tiene la mercadería y todavía no tiene el dinero. Eso es un saldo por
-- cobrar, y tiene que ser CONSULTABLE: si no se puede preguntar «cuánto me
-- deben y quién», se acaba llevando en un cuaderno.
--
-- TRES DECISIONES DE ALCANCE
--
-- 1. Contra entrega NO es un estado de la venta, son sus CONDICIONES DE PAGO.
--    Una venta contra entrega está tan confirmada como cualquier otra. Lo que
--    cambia es cuándo entra el dinero. Meterlo en `sale_status` habría mezclado
--    «esta venta vale» con «esta venta está cobrada», que es justo la confusión
--    que produce el problema.
--
--    (Confirmada NO quiere decir despachada. Dónde está el pedido es una tercera
--    dimensión y la añade 0064: `sales.fulfillment_status`.)
--
-- 2. Qué métodos la admiten es un DATO, no código. Hoy: delivery y envío a
--    provincia sí; mostrador y recojo no, porque ahí se cobra completo y en el
--    acto. Si mañana cambia, se cambia una fila.
--
-- 3. NO se restringe el medio del adelanto. Ivan observó que casi nunca es
--    efectivo —Yape y Plin lo normal, transferencia a veces, tarjeta poco—,
--    pero eso es una frecuencia, no una regla: prohibir el efectivo por si acaso
--    rompería la venta del día que alguien pague en billetes. El control real ya
--    existe y es 0057: esos cuatro medios no se registran sin su número de
--    operación.
--
-- LO QUE NO HACE FALTA TOCAR: el arqueo. El cajón se alimenta por disparador
-- sobre las tablas de dinero (0034), así que el saldo cobrado tres días después
-- entra en la caja del día que entra, sin que nadie lo empuje. Era la parte que
-- más miedo daba y estaba resuelta desde el principio.
-- ---------------------------------------------------------------------------

create type public.sale_payment_terms as enum (
  'immediate',    -- se cobra completo al registrar. Es lo de siempre.
  'on_delivery'   -- adelanto ahora, saldo cuando la clienta recibe el pedido
);

comment on type public.sale_payment_terms is
  'CUÁNDO se cobra una venta, no si vale. Una venta contra entrega está tan '
  'confirmada como cualquier otra: lo que le falta es dinero, no validez.';

alter table public.sales
  add column payment_terms public.sale_payment_terms not null default 'immediate';

comment on column public.sales.payment_terms is
  'Condiciones de pago. `immediate` es lo de siempre y sigue siendo el valor por '
  'defecto: ninguna venta existente cambia de significado por esta migración.';

-- Buscar lo que está por cobrar es la consulta que justifica todo esto.
create index sales_on_delivery_idx on public.sales (branch_id, issued_at)
  where payment_terms = 'on_delivery';

-- ---------------------------------------------------------------------------
-- 1. Qué métodos admiten contra entrega — junto al resto de sus requisitos
-- ---------------------------------------------------------------------------
alter table public.fulfillment_requirements
  add column allows_on_delivery boolean not null default false,
  add column requires_advance boolean not null default true,
  /* Porcentaje mínimo del total que hay que adelantar. Queda en cero: la dueña
     no ha fijado un mínimo y no es de este código inventárselo. Existe la
     columna para que fijarlo sea cambiar una fila y no migrar. */
  add column min_advance_percent numeric(5, 2) not null default 0;

comment on column public.fulfillment_requirements.allows_on_delivery is
  'Si este método admite cobrar el saldo al entregar. En mostrador y en recojo '
  'no: ahí la clienta está delante y se cobra completo.';

comment on column public.fulfillment_requirements.min_advance_percent is
  'Mínimo del total que debe adelantarse. En cero mientras la dueña no fije uno: '
  'lo que exige es que HAYA adelanto, no cuánto.';

update public.fulfillment_requirements
set allows_on_delivery = true
where method in ('local_delivery', 'shipping');

alter table public.fulfillment_requirements
  add constraint fulfillment_requirements_advance_range
  check (min_advance_percent >= 0 and min_advance_percent <= 100);

-- ---------------------------------------------------------------------------
-- 2. Cobrar el saldo dos veces no puede pasar
-- ---------------------------------------------------------------------------
-- El mismo candado que protege a la venta entera: un botón pulsado dos veces
-- devuelve lo ya cobrado en lugar de volver a cobrarlo.
alter table public.sale_payments
  add column client_operation_id uuid;

create unique index sale_payments_operation_unique
  on public.sale_payments (client_operation_id)
  where client_operation_id is not null;

-- ---------------------------------------------------------------------------
-- 3. La regla del dinero, en UN solo sitio
-- ---------------------------------------------------------------------------
-- Devuelve qué está mal con lo cobrado, o null si está bien. La consulta
-- `register_sale` para fallar en el acto —con la clienta delante, enterarse al
-- cerrar la transacción es tarde— y la consulta el disparador diferido para que
-- ningún otro camino pueda dejar una venta descuadrada. Una sola definición: si
-- mañana cambia, no hay dos sitios que puedan discrepar.
create or replace function public.sale_payment_problem(p_sale_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
  v_req public.fulfillment_requirements%rowtype;
  v_paid numeric(12, 2);
  v_minimo numeric(12, 2);
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then
    return null;
  end if;

  -- Una venta anulada se salda por reembolso, que es otro documento y otra
  -- tabla. Exigirle cuadratura aquí sería pedirle dos veces lo mismo.
  if v_sale.status = 'cancelled' then
    return null;
  end if;

  select coalesce(sum(amount), 0) into v_paid
  from public.sale_payments where sale_id = p_sale_id;

  -- Cobrar de más NUNCA vale, con las condiciones que sean: lo que sobra no es
  -- vuelto, ni adelanto, ni saldo a favor.
  if v_paid > v_sale.total then
    return format('Los pagos suman %s y el total de la venta es %s: lo que sobra no es vuelto.',
                  v_paid, v_sale.total);
  end if;

  if v_sale.payment_terms = 'immediate' then
    if v_paid <> v_sale.total then
      return format('Los pagos aplicados suman %s y el total de la venta es %s.',
                    v_paid, v_sale.total);
    end if;
    return null;
  end if;

  -- A partir de aquí, contra entrega.
  select * into v_req from public.fulfillment_requirements
  where method = v_sale.fulfillment_method;

  if not coalesce(v_req.allows_on_delivery, false) then
    return 'El pago contra entrega solo existe cuando hay algo que entregar: en mostrador y en recojo se cobra completo.';
  end if;

  if coalesce(v_req.requires_advance, true) and v_paid <= 0 then
    return 'Un pedido contra entrega necesita un adelanto: sin él no es contra entrega, es fiado.';
  end if;

  v_minimo := round(v_sale.total * coalesce(v_req.min_advance_percent, 0) / 100, 2);
  if v_paid < v_minimo then
    return format('El adelanto es de %s y para este envío hay que adelantar al menos %s.',
                  v_paid, v_minimo);
  end if;

  return null;
end;
$$;

comment on function public.sale_payment_problem(uuid) is
  'Qué está mal con lo cobrado de una venta, o null si está bien. Única '
  'definición de la regla del dinero: la consulta el contrato para fallar en el '
  'acto y el disparador diferido para que nadie pueda esquivarla.';

revoke execute on function public.sale_payment_problem(uuid) from public;
grant execute on function public.sale_payment_problem(uuid) to authenticated, service_role;

-- El disparador que obliga NO se crea aquí: ya existía desde 0029, diferido y
-- colgado de las dos tablas correctas (`sales_require_payment` y
-- `sale_payments_cover_total`). Lo único que le faltaba era saber que hay ventas
-- que no se cobran enteras el mismo día.
--
-- Añadir un segundo disparador con la regla nueva habría dejado dos
-- comprobaciones distintas del mismo dinero, y la vieja rechazando lo que la
-- nueva admite. Así que se le cambia el cuerpo y se le deja consultar la regla
-- única. Los disparadores no se tocan: siguen apuntando a esta función.
create or replace function public.assert_sale_fully_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_sale_id uuid;
  problema text;
begin
  if tg_table_name = 'sales' then
    affected_sale_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    affected_sale_id := case when tg_op = 'DELETE' then old.sale_id else new.sale_id end;
  end if;

  problema := public.sale_payment_problem(affected_sale_id);
  if problema is not null then
    raise exception using errcode = '23514', message = problema;
  end if;

  return null;
end;
$$;

comment on function public.assert_sale_fully_paid() is
  'Impide que una venta quede descuadrada. Desde 0063 «pagada» significa «pagada '
  'según sus condiciones»: entera al registrarla, o con su adelanto si el saldo '
  'se cobra al entregar. La regla no está aquí, se consulta en '
  'sale_payment_problem, que es la misma que aplica el contrato.';

-- ---------------------------------------------------------------------------
-- 4. Cobrar el saldo
-- ---------------------------------------------------------------------------
-- No hay que tocar la caja: el disparador de 0034 mete cada pago en la sesión
-- abierta de su sede el día que se recibe. El dinero entra el día que entra.
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

  -- IDEMPOTENCIA, igual que en la venta: el candado serializa los reintentos del
  -- mismo botón antes de escribir nada, y si ya se cobró se devuelve lo cobrado
  -- en lugar de volver a cobrarlo.
  perform pg_advisory_xact_lock(
    hashtextextended(p_sale_id::text || ':' || p_client_operation_id::text, 0)
  );

  if exists (select 1 from public.sale_payments where client_operation_id = p_client_operation_id) then
    return public.sale_detail(p_sale_id);
  end if;

  if v_sale.payment_terms <> 'on_delivery' then
    raise exception using errcode = '23514',
      message = 'Esta venta se cobró al registrarla: no tiene saldo pendiente.';
  end if;

  select v_sale.total - coalesce(sum(amount), 0) into v_pendiente
  from public.sale_payments where sale_id = p_sale_id;

  if v_pendiente <= 0 then
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

  if v_nuevo <> v_pendiente then
    raise exception using errcode = '23514',
      message = format('El saldo pendiente es %s y lo que se está cobrando suma %s.',
                       v_pendiente, v_nuevo);
  end if;

  -- Las condiciones de pago NO se tocan al cobrar: «esta venta se vendió contra
  -- entrega» es un hecho de cómo se vendió, y sobrescribirlo dejaría sin
  -- respuesta la pregunta de cuánto se vende así. Que ya no deba nada se
  -- responde con el saldo, que es la suma de sus pagos y no puede desfasarse.
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
  'Cobra el saldo de una venta contra entrega. No toca la caja a mano: el '
  'disparador del cajón mete cada pago en la sesión del día en que se recibe.';

revoke execute on function public.settle_sale_balance(uuid, jsonb, uuid) from public;
grant execute on function public.settle_sale_balance(uuid, jsonb, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. El detalle dice cuánto falta
-- ---------------------------------------------------------------------------
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
    -- Lo cobrado y lo que falta se derivan de los pagos: no hay una columna
    -- «saldo» que pueda quedarse desfasada de la suma que dice representar.
    'paidTotal', coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0),
    'balance', s.total - coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0),
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

-- ---------------------------------------------------------------------------
-- 6. `register_sale` aprende las condiciones de pago
-- ---------------------------------------------------------------------------
-- Tercera vez que esta migración reescribe el cuerpo entero de `register_sale`
-- por añadirle un parámetro (0055, 0061 y ahora). Funciona, es la convención del
-- repositorio y las pruebas lo cubren, pero tres copias de trescientas líneas en
-- el historial es una copia de más: cada una puede derivar de las otras.
--
-- AVISO PARA EL SIGUIENTE PARÁMETRO: no lo añadas así. Toca agrupar las
-- opciones escalares —canal, referencia, modo de entrada, conversación,
-- persona, condiciones— en un único `p_options jsonb`, y a partir de ahí crecer
-- sin cambiar la firma. Este comentario existe para que esa decisión se tome a
-- propósito y no se descubra otra vez a la cuarta.
--
-- Dos cambios en el cuerpo respecto a 0061, y nada más:
--   · la venta guarda sus condiciones de pago;
--   · la comprobación del dinero deja de estar escrita aquí y consulta
--     `sale_payment_problem`, que es la misma que aplica el disparador.

drop function if exists public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb
);

CREATE OR REPLACE FUNCTION public.register_sale(p_branch_id uuid, p_lines jsonb, p_payments jsonb, p_client_operation_id uuid, p_source_channel sale_source_channel DEFAULT 'in_store'::sale_source_channel, p_fulfillment_method fulfillment_method DEFAULT 'in_store'::fulfillment_method, p_customer jsonb DEFAULT NULL::jsonb, p_discount_total numeric DEFAULT 0, p_notes text DEFAULT NULL::text, p_reservation_id uuid DEFAULT NULL::uuid, p_source_reference text DEFAULT NULL::text, p_entry_mode sale_entry_mode DEFAULT 'store_quick'::sale_entry_mode, p_conversation_id uuid DEFAULT NULL::uuid, p_person_id uuid DEFAULT NULL::uuid, p_parties jsonb DEFAULT NULL::jsonb, p_payment_terms sale_payment_terms DEFAULT 'immediate'::sale_payment_terms)
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
  payment_problem text;
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
    entry_mode, conversation_id, person_id, payment_terms
  ) values (
    new_sale_id, p_branch_id, sale_number, p_source_channel, p_source_reference, p_fulfillment_method,
    coalesce(nullif(trim(coalesce(p_customer ->> 'name', '')), ''), reservation.customer_name),
    coalesce(nullif(trim(coalesce(p_customer ->> 'phone', '')), ''), reservation.customer_phone),
    coalesce(nullif(trim(coalesce(p_customer ->> 'document', '')), ''), reservation.customer_document),
    nullif(trim(coalesce(p_customer ->> 'address', '')), ''),
    gross, discount_sum, net_total, p_notes, reservation.id,
    actor, actor_name, p_client_operation_id,
    p_entry_mode, p_conversation_id, p_person_id, p_payment_terms
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

  -- La regla del dinero vive en `sale_payment_problem` desde 0063, y aquí solo
  -- se consulta. Se comprueba EN EL ACTO además de en el disparador diferido
  -- porque quien cobra tiene una clienta delante: enterarse al cerrar la
  -- transacción es enterarse tarde.
  payment_problem := public.sale_payment_problem(new_sale_id);
  if payment_problem is not null then
    raise exception using errcode = '23514', message = payment_problem;
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
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb,
  public.sale_payment_terms
) is
  'Registra una venta completa en una sola transacción. `p_payment_terms` decide '
  'si se cobra entera al registrarla o si queda saldo para cuando la clienta '
  'reciba el pedido.';

revoke execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb,
  public.sale_payment_terms
) from public;

grant execute on function public.register_sale(
  uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method,
  jsonb, numeric, text, uuid, text, public.sale_entry_mode, uuid, uuid, jsonb,
  public.sale_payment_terms
) to authenticated, service_role;
