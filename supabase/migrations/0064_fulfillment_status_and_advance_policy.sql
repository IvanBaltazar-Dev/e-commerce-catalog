-- ---------------------------------------------------------------------------
-- 0064 · Tres dimensiones, no dos — y el adelanto deja de decir dos cosas
-- ---------------------------------------------------------------------------
-- Cierra cuatro cosas que 0063 dejó a medias. Las cuatro son del mismo tipo de
-- error: un dato que dice una cosa y una regla que impone otra.
--
-- A. EL ADELANTO MÍNIMO DECÍA CERO Y EXIGÍA MÁS QUE CERO.
--    `requires_advance = true` con `min_advance_percent = 0` se lee como «no hay
--    mínimo», y sin embargo un adelanto de cero se rechazaba. Las dos reglas
--    eran datos —no había nada quemado en código—, pero el CERO era la palabra
--    equivocada: confundía «no fijamos porcentaje» con «no exigimos nada».
--
--    A partir de aquí el porcentaje admite NULL y eso es lo que significa cada
--    combinación, sin ambigüedad:
--
--      requires_advance = false                    → se puede no adelantar nada
--      requires_advance = true,  percent = NULL    → hay que adelantar algo,
--                                                    pero la dueña no fija cuánto
--      requires_advance = true,  percent = 30      → hay que adelantar el 30 %
--
--    Hoy Bellaroshé está en el caso del medio, que es exactamente lo que Ivan
--    describió: siempre hay adelanto, y nadie ha dicho de cuánto.
--
-- B. CONFIRMADA NO QUIERE DECIR DESPACHADA.
--    0063 dijo «una venta contra entrega está tan confirmada como cualquier
--    otra: se despachó», y esa segunda mitad estaba mal. Una venta puede
--    confirmarse hoy, prepararse mañana, salir por la tarde y entregarse dos
--    días después. `sale_status` nunca representó la entrega —solo tiene
--    `confirmed` y `cancelled`—, así que el problema no era que la mezclara:
--    era que la entrega NO EXISTÍA como dimensión. Aquí se añade.
--
--    Quedan tres, independientes entre sí:
--
--      VENTA    sale_status         confirmed | cancelled
--      ENTREGA  fulfillment_status  pending → ready → dispatched → delivered
--                                   (y failed cuando no se pudo entregar)
--      COBRO    payment_terms + el saldo, que se deriva de los pagos
--
--    Independientes de verdad: se puede entregar y cobrar después, y se puede
--    cobrar y entregar después. Las dos cosas pasan.
--
-- C. COBRAR EL SALDO NO ESTABA A SALVO DE DOS DISPOSITIVOS A LA VEZ.
--    El candado de 0063 se calculaba con la venta Y el identificador de
--    operación, así que dos peticiones simultáneas con identificadores
--    DISTINTOS —dos celulares, dos vendedoras— tomaban candados distintos y
--    ninguno esperaba al otro. Las dos leían un saldo de 15 y las dos lo
--    cobraban. La restricción diferida habría cazado alguna, pero depender de
--    eso es depender de que dos instantáneas se solapen como conviene.
--    El candado pasa a ser de la VENTA.
--
-- D. EL SALDO SE CALCULABA EN LA PANTALLA.
--    La ruta de pendientes traía las ventas y sus pagos y restaba en JavaScript.
--    Funciona hasta que un segundo sitio reste distinto. `pending_operations`
--    devuelve la lista ya resuelta: quién, qué falta y cuánto.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. El adelanto mínimo dice una sola cosa
-- ---------------------------------------------------------------------------
alter table public.fulfillment_requirements
  alter column min_advance_percent drop not null,
  alter column min_advance_percent drop default;

update public.fulfillment_requirements set min_advance_percent = null;

comment on column public.fulfillment_requirements.min_advance_percent is
  'Porcentaje del total que hay que adelantar. NULL significa «no se fija '
  'cuánto», que NO es lo mismo que cero: si el método exige adelanto, con NULL '
  'basta cualquier importe mayor que cero. Cero significaría que se admite no '
  'adelantar nada, y para eso está requires_advance.';

comment on column public.fulfillment_requirements.requires_advance is
  'Si hace falta adelantar algo para vender contra entrega. Es la política de '
  'SI; min_advance_percent es la de CUÁNTO. Separadas porque hoy Bellaroshé '
  'exige lo primero y no ha fijado lo segundo.';

-- ---------------------------------------------------------------------------
-- B. Dónde está el pedido
-- ---------------------------------------------------------------------------
create type public.sale_fulfillment_status as enum (
  'pending',     -- confirmada, todavía sin preparar
  'ready',       -- preparada y esperando a que salga o a que la recojan
  'dispatched',  -- salió: la lleva el motorizado o está en la agencia
  'delivered',   -- en manos de quien la recibe
  'failed'       -- no se pudo entregar; volverá a intentarse o se devuelve
);

comment on type public.sale_fulfillment_status is
  'DÓNDE está el pedido, que no es ni si la venta vale (sale_status) ni si está '
  'cobrada (los pagos). Una venta entregada puede estar sin cobrar y una venta '
  'cobrada puede estar sin entregar: las dos cosas pasan y ninguna es un error.';

alter table public.sales
  add column fulfillment_status public.sale_fulfillment_status not null default 'pending';

-- Lo que está por entregar es media pantalla de pendientes: se consulta seguido.
create index sales_fulfillment_pending_idx on public.sales (branch_id, issued_at)
  where fulfillment_status <> 'delivered' and status = 'confirmed';

-- En el mostrador la clienta se lleva su bolsa: nace entregada. En todo lo
-- demás, nace pendiente. Va en un disparador y no en `register_sale` porque se
-- deduce del método —no es una decisión de quien vende— y porque así vale para
-- cualquier camino que registre una venta, incluidos los que no existen aún.
create or replace function public.default_sale_fulfillment_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.fulfillment_method = 'in_store' then
    new.fulfillment_status := 'delivered';
  end if;
  return new;
end;
$$;

revoke execute on function public.default_sale_fulfillment_status() from public;

create trigger sales_b_default_fulfillment_status
  before insert on public.sales
  for each row
  execute function public.default_sale_fulfillment_status();

-- Y las ventas que ya existen. El disparador solo alcanza a las nuevas, así que
-- sin esto toda venta de mostrador anterior a esta migración aparecería en
-- «por entregar» —y son casi todas—. Lo que se afirma aquí es lo único que se
-- sabe con certeza: una venta de mostrador se entregó en el mostrador.
--
-- Las demás se quedan en `pending` a propósito. Un envío de la semana pasada
-- pudo entregarse o no, y marcarlo como entregado sería inventar un hecho
-- operativo. Que aparezcan pendientes es correcto: alguien tiene que mirarlas.
update public.sales
set fulfillment_status = 'delivered'
where fulfillment_method = 'in_store';

/**
 * Mover el pedido de estado. Las transiciones válidas viven aquí y no en la
 * pantalla: marcar «entregado» algo que nunca salió es un error de operación, no
 * de interfaz, y tiene que fallar igual desde un script.
 */
create or replace function public.mark_sale_fulfillment(
  p_sale_id uuid,
  p_status public.sale_fulfillment_status,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sale public.sales%rowtype;
  v_orden constant text[] := array['pending', 'ready', 'dispatched', 'delivered'];
  v_desde integer;
  v_hasta integer;
begin
  select * into v_sale from public.sales where id = p_sale_id;
  if v_sale.id is null then
    raise exception using errcode = '22023', message = 'Esa venta no existe.';
  end if;

  perform public.assert_branch_access(v_sale.branch_id, 'mover una entrega');

  if v_sale.status = 'cancelled' then
    raise exception using errcode = '23514',
      message = 'Esta venta está anulada: ya no hay nada que entregar.';
  end if;

  if v_sale.fulfillment_status = p_status then
    return public.sale_detail(p_sale_id);
  end if;

  if v_sale.fulfillment_status = 'delivered' then
    raise exception using errcode = '23514',
      message = 'Este pedido ya se entregó. Si volvió, lo que corresponde es una devolución.';
  end if;

  -- `failed` se alcanza desde cualquier punto anterior a la entrega, y desde
  -- `failed` se puede reintentar: un timbre al que nadie contesta no es el final
  -- del pedido.
  if p_status <> 'failed' and v_sale.fulfillment_status <> 'failed' then
    v_desde := array_position(v_orden, v_sale.fulfillment_status::text);
    v_hasta := array_position(v_orden, p_status::text);
    if v_hasta < v_desde then
      raise exception using errcode = '23514',
        message = 'Un pedido no vuelve atrás en su entrega: corrige lo que esté mal y avanza.';
    end if;
  end if;

  update public.sales
  set fulfillment_status = p_status,
      notes = case
        when nullif(btrim(coalesce(p_note, '')), '') is null then notes
        else btrim(coalesce(notes || E'\n', '') || p_note)
      end,
      updated_at = now()
  where id = p_sale_id;

  return public.sale_detail(p_sale_id);
end;
$$;

comment on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) is
  'Mueve el pedido por sus estados de entrega. No toca el cobro: se puede '
  'entregar sin haber cobrado y cobrar sin haber entregado.';

revoke execute on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) from public;
grant execute on function public.mark_sale_fulfillment(uuid, public.sale_fulfillment_status, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- A (continuación) · La regla del dinero, con el mínimo bien dicho
-- ---------------------------------------------------------------------------
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

  if not coalesce(v_req.requires_advance, true) then
    return null;
  end if;

  -- El mínimo sale ENTERO del dato: si hay porcentaje, se aplica; si no lo hay,
  -- el mínimo es «algo», y «algo» es el céntimo más pequeño que existe. No hay
  -- ningún umbral escrito aquí que la fila no diga.
  v_minimo := case
    when v_req.min_advance_percent is null then 0.01
    else greatest(round(v_sale.total * v_req.min_advance_percent / 100, 2), 0.01)
  end;

  if v_paid < v_minimo then
    if v_req.min_advance_percent is null then
      return 'Un pedido contra entrega necesita un adelanto: sin él no es contra entrega, es fiado.';
    end if;
    return format('El adelanto es de %s y para este método hay que adelantar al menos %s (%s %% del total).',
                  v_paid, v_minimo, v_req.min_advance_percent);
  end if;

  return null;
end;
$$;

comment on function public.sale_payment_problem(uuid) is
  'Qué está mal con lo cobrado de una venta, o null si está bien. Única '
  'definición de la regla del dinero, y desde 0064 tampoco esconde el umbral: '
  'lo que exige sale entero de fulfillment_requirements.';

-- ---------------------------------------------------------------------------
-- C. Cobrar el saldo, a salvo de dos dispositivos a la vez
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

  -- EL CANDADO ES DE LA VENTA, no de la venta más el identificador de operación.
  -- Con el identificador dentro, dos celulares cobrando el mismo saldo a la vez
  -- tomaban candados distintos, ninguno esperaba al otro, los dos leían el mismo
  -- saldo y los dos lo cobraban. Así el segundo espera al primero y, al mirar,
  -- ya no queda nada que cobrar.
  perform pg_advisory_xact_lock(hashtextextended(p_sale_id::text, 0));

  -- Y el identificador sigue haciendo su trabajo: el MISMO botón pulsado dos
  -- veces devuelve lo ya cobrado en lugar de cobrarlo otra vez.
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

  -- Se relee DESPUÉS del candado: es el punto entero de tomarlo.
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

  -- El saldo se cobra de una vez, aunque se reparta entre varios medios: quien
  -- recibe el pedido paga lo que falta, no una parte de lo que falta. Si algún
  -- día hacen falta cobros parciales, se cambia esta comparación por `>` y la
  -- pantalla deja de bloquear el importe.
  if v_nuevo <> v_pendiente then
    raise exception using errcode = '23514',
      message = format('El saldo pendiente es %s y lo que se está cobrando suma %s.',
                       v_pendiente, v_nuevo);
  end if;

  -- Las condiciones de pago NO se tocan: «esta venta se vendió contra entrega»
  -- es un hecho de cómo se vendió, y sobrescribirlo dejaría sin respuesta cuánto
  -- se vende así, cuánto tarda en cobrarse y qué canal la genera. Que ya no deba
  -- nada se responde con el saldo, que es la suma de sus pagos.
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
  'Cobra el saldo de una venta contra entrega. El candado es de la venta, así '
  'que dos dispositivos a la vez no pueden cobrarlo dos veces. No toca la caja: '
  'el disparador del cajón mete cada pago en la sesión del día que se recibe.';

revoke execute on function public.settle_sale_balance(uuid, jsonb, uuid) from public;
grant execute on function public.settle_sale_balance(uuid, jsonb, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- D. Pendientes: una sola lectura, y el saldo resuelto aquí
-- ---------------------------------------------------------------------------
-- Reúne lo que queda por hacer: reservas vivas, pedidos por entregar y ventas
-- por cobrar. Una fila puede ser dos cosas a la vez —un envío despachado que
-- además debe dinero— y por eso las banderas son independientes en vez de un
-- «tipo» que obligaría a elegir una.
--
-- La RLS de `sales` y `reservations` ya recorta por las sedes de quien consulta,
-- así que esta función es INVOKER a propósito: no hay que filtrar por sede aquí
-- ni se puede olvidar hacerlo.
create or replace function public.pending_operations()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with ventas as (
    select
      s.id,
      s.sale_number as number,
      s.issued_at as happened_at,
      s.branch_id,
      s.fulfillment_method,
      s.fulfillment_status,
      s.payment_terms,
      s.customer_name,
      s.customer_phone,
      s.person_id,
      s.total,
      coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0) as paid
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
        'balance', v.total - v.paid,
        -- Las dos banderas que deciden qué botón toca. Independientes: hay
        -- pedidos entregados sin cobrar y pedidos cobrados sin entregar.
        'needsDelivery', v.fulfillment_status <> 'delivered',
        'needsPayment', v.total - v.paid > 0
      ) order by v.happened_at)
      from ventas v
      where v.fulfillment_status <> 'delivered' or v.total - v.paid > 0
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
  'cobrar. El saldo se resuelve AQUÍ; ninguna pantalla vuelve a restar pagos '
  'contra el total por su cuenta.';

revoke execute on function public.pending_operations() from public;
grant execute on function public.pending_operations() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- B (continuación) · El detalle dice dónde está el pedido
-- ---------------------------------------------------------------------------
-- Sin esta clave la dimensión existiría en la base y sería invisible desde la
-- pantalla, que es tanto como no tenerla. Es el único cambio respecto a 0063.

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