-- Bloque 2 · Migración 4 de 5 — Anulaciones, devoluciones y reembolsos.
--
-- Ver los invariantes de venta y dinero en docs/arquitectura.md.
--
-- LA REGLA QUE GOBIERNA ESTA MIGRACIÓN: el dinero que sale se registra igual de
-- bien que el que entra. Una venta anulada conserva su venta, su cobranza y su
-- kardex; lo que se añade es el asiento contrario. Nada se borra, nada se
-- reescribe, y toda corrección deja rastro con motivo y responsable.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. LA REVERSIÓN DEL COSTO VIVE EN EL KARDEX, NO EN UNA TABLA NUEVA. §12/0030-5
--    exige reponer valor con el costo CAPTURADO en sale_line_costs y «revertir
--    esas filas de COGS». Revertirlas reescribiendo sale_line_costs destruiría
--    la captura, que es justo lo que esa tabla existe para conservar. El asiento
--    contrario se escribe donde 0028 puso las columnas monetarias precisamente
--    para esto: inventory_movements, con unit_cost y value_delta. El COGS neto
--    es una resta, no una segunda fuente de verdad.
--
-- B. LO DEVUELTO SE REPONE VALORADO PRIMERO. Una salida consume antes las
--    unidades SIN valorar (regla de 0028). Al volver, se restituyen antes las
--    valoradas, hasta agotar las que esa línea llevaba. Es la única forma de que
--    devolver todo lo vendido deje la valoración exactamente como estaba: si se
--    repusiera al revés, una devolución parcial devolvería valor que la venta no
--    había consumido.
--
-- C. UNA LÍNEA MIXTA GENERA DOS ASIENTOS. apply_inventory_movement valora una
--    entrada entera o ninguna. Reponer 10 unidades de las que 6 tenían costo y 4
--    no, con un solo asiento, obligaría a inventar un costo medio para las 4 o a
--    perder el de las 6. Se escriben dos asientos y el kardex queda exacto.

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.cancellation_reason as enum (
  'customer_regret', 'wrong_item', 'pricing_error', 'duplicate_operation',
  'payment_failed', 'other'
);

-- Solo `resellable` vuelve al stock vendible. Lo dañado se registra igual —la
-- clienta lo devolvió y el dinero salió— pero no reaparece como disponible.
create type public.return_item_condition as enum (
  'resellable', 'damaged', 'expired', 'incomplete'
);

create type public.reservation_advance_policy as enum ('refund', 'retain');

-- ---------------------------------------------------------------------------
-- 1. Anulación
-- ---------------------------------------------------------------------------

create table public.sale_cancellations (
  id uuid primary key default gen_random_uuid(),
  -- ÚNICO: impide la segunda anulación sin necesidad de leer-decidir-escribir.
  sale_id uuid not null unique references public.sales(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  reason_code public.cancellation_reason not null,
  -- Obligatoria: un código sin explicación no sirve para entender qué pasó seis
  -- meses después, que es cuando se consulta una anulación.
  explanation text not null,
  evidence_path text,
  actor_id uuid,
  actor_label text,
  occurred_at timestamptz not null default now(),
  constraint sale_cancellations_explanation_not_blank check (length(trim(explanation)) > 0)
);

comment on table public.sale_cancellations is
  'Anulación de una venta. La venta original sobrevive intacta: esto es el '
  'asiento contrario, no un borrado.';

create index sale_cancellations_branch_idx on public.sale_cancellations(branch_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 2. Devolución
-- ---------------------------------------------------------------------------

create table public.returns (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- Numeración derivada de la nota de venta: una devolución siempre pertenece a
  -- una venta, así que no compite por el correlativo más contendido de la sede.
  return_number text not null,
  reason text,
  notes text,
  refund_total numeric(12, 2) not null default 0,
  currency char(3) not null default 'PEN',
  actor_id uuid,
  actor_label text,
  client_operation_id uuid not null,
  occurred_at timestamptz not null default now(),
  constraint returns_refund_non_negative check (refund_total >= 0),
  constraint returns_currency_pen check (currency = 'PEN'),
  constraint returns_number_unique unique (sale_id, return_number),
  constraint returns_operation_unique unique (branch_id, client_operation_id)
);

create index returns_sale_idx on public.returns(sale_id, occurred_at desc);
create index returns_branch_idx on public.returns(branch_id, occurred_at desc);

create table public.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns(id) on delete cascade,
  -- Al documento cascada; al libro de la venta, restrictivo.
  sale_line_id uuid not null references public.sale_lines(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text,
  product_name text,
  variant_name text,
  quantity integer not null,
  condition public.return_item_condition not null,
  -- Reparto por DIFERENCIA ACUMULADA, nunca unitario × cantidad: así la última
  -- devolución absorbe el residuo y el céntimo sale siempre a favor de la
  -- clienta en lugar de cobrarse dos veces.
  refund_amount numeric(12, 2) not null default 0,
  restocked boolean not null default false,
  created_at timestamptz not null default now(),
  constraint return_lines_quantity_positive check (quantity > 0),
  constraint return_lines_refund_non_negative check (refund_amount >= 0),
  -- Solo lo vendible vuelve al stock.
  constraint return_lines_restock_only_resellable check (
    not restocked or condition = 'resellable'
  ),
  constraint return_lines_unique unique (return_id, sale_line_id)
);

create index return_lines_sale_line_idx on public.return_lines(sale_line_id);
create index return_lines_variant_idx on public.return_lines(variant_id);

-- ---------------------------------------------------------------------------
-- 3. Reembolso
-- ---------------------------------------------------------------------------
-- Origen excluyente entre TRES, no entre dos: el reembolso del adelanto de una
-- reserva cancelada no es venta ni devolución, y con dos columnas quedaba
-- inconstruible.

create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  sale_cancellation_id uuid references public.sale_cancellations(id) on delete cascade,
  return_id uuid references public.returns(id) on delete cascade,
  reservation_id uuid references public.reservations(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- Sin método, el arqueo no puede restar el efectivo que sale del cajón y el
  -- descuadre acabaría atribuido a la vendedora.
  method public.payment_method not null,
  amount numeric(12, 2) not null,
  currency char(3) not null default 'PEN',
  reference text,
  evidence_path text,
  paid_at timestamptz not null default now(),
  actor_id uuid,
  actor_label text,
  created_at timestamptz not null default now(),
  constraint refunds_amount_positive check (amount > 0),
  constraint refunds_currency_pen check (currency = 'PEN'),
  constraint refunds_single_origin check (
    num_nonnulls(sale_cancellation_id, return_id, reservation_id) = 1
  )
);

comment on table public.refunds is
  'Salida de dinero. Origen excluyente entre anulación, devolución y adelanto '
  'de reserva cancelada. Sin políticas de update ni delete: se corrige por '
  'reversión registrada.';

create index refunds_cancellation_idx on public.refunds(sale_cancellation_id) where sale_cancellation_id is not null;
create index refunds_return_idx on public.refunds(return_id) where return_id is not null;
create index refunds_reservation_idx on public.refunds(reservation_id) where reservation_id is not null;
create index refunds_cash_idx on public.refunds(paid_at, method);

-- ---------------------------------------------------------------------------
-- 4. Topes acumulados
-- ---------------------------------------------------------------------------
-- Sin ellos, dos devoluciones de 5 y 4 sobre una línea de 7 pasan sin
-- obstáculo: 9 unidades repuestas y 9 reembolsadas. Y una venta de 100 puede
-- pagar 190 en reembolsos.

create or replace function public.assert_returned_within_sold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_sale_line uuid := case when tg_op = 'DELETE' then old.sale_line_id else new.sale_line_id end;
  sold integer;
  returned integer;
begin
  select l.quantity into sold from public.sale_lines l where l.id = affected_sale_line;

  if sold is null then
    return null;
  end if;

  select coalesce(sum(rl.quantity), 0) into returned
  from public.return_lines rl where rl.sale_line_id = affected_sale_line;

  if returned > sold then
    raise exception using
      errcode = '23514',
      message = format('No se pueden devolver %s unidades de una línea que vendió %s.', returned, sold);
  end if;

  return null;
end;
$$;

revoke all on function public.assert_returned_within_sold() from public, anon;

create constraint trigger return_lines_within_sold
after insert or update or delete on public.return_lines
deferrable initially deferred
for each row execute function public.assert_returned_within_sold();

create or replace function public.assert_refund_within_collected()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  origin_sale uuid;
  origin_reservation uuid;
  collected numeric(12, 2);
  refunded numeric(12, 2);
begin
  -- El reembolso no lleva sale_id: se deriva del origen para que no exista una
  -- segunda copia de la verdad que pueda contradecir a la primera.
  select coalesce(
    (select c.sale_id from public.sale_cancellations c where c.id = new.sale_cancellation_id),
    (select r.sale_id from public.returns r where r.id = new.return_id)
  ) into origin_sale;

  if origin_sale is not null then
    select coalesce(sum(p.amount), 0) into collected
    from public.sale_payments p where p.sale_id = origin_sale;

    select coalesce(sum(f.amount), 0) into refunded
    from public.refunds f
    where f.sale_cancellation_id in (select c.id from public.sale_cancellations c where c.sale_id = origin_sale)
       or f.return_id in (select r.id from public.returns r where r.sale_id = origin_sale);

    if refunded > collected then
      raise exception using
        errcode = '23514',
        message = format('Los reembolsos de la venta (%s) superan lo efectivamente cobrado (%s).',
                         refunded, collected);
    end if;

    return null;
  end if;

  origin_reservation := new.reservation_id;

  if origin_reservation is not null then
    select coalesce(sum(p.amount), 0) into collected
    from public.reservation_payments p where p.reservation_id = origin_reservation;

    select coalesce(sum(f.amount), 0) into refunded
    from public.refunds f where f.reservation_id = origin_reservation;

    if refunded > collected then
      raise exception using
        errcode = '23514',
        message = format('Los reembolsos del adelanto (%s) superan lo recibido (%s).', refunded, collected);
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.assert_refund_within_collected() from public, anon;

create constraint trigger refunds_within_collected
after insert or update on public.refunds
deferrable initially deferred
for each row execute function public.assert_refund_within_collected();

-- ---------------------------------------------------------------------------
-- 5. Reposición al costo capturado
-- ---------------------------------------------------------------------------
-- Con la secuencia comprar 10 @ 10 / vender 10 / comprar 10 @ 30 / anular, al
-- promedio VIGENTE el saldo queda en 600,00 —200,00 inventados— y al costo
-- CAPTURADO en 400,00, que es exactamente lo desembolsado.
--
-- Devuelve las unidades repuestas para que quien llama sepa si hubo asiento.

create or replace function public.restore_sold_units(
  p_sale_id uuid,
  p_sale_line_id uuid,
  p_variant_id uuid,
  p_branch_id uuid,
  p_quantity integer,
  p_movement_type public.inventory_movement_type,
  p_source_type text,
  p_source_id uuid,
  p_source_label text,
  p_reason text,
  p_actor_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  captured public.sale_line_costs%rowtype;
  already_returned integer := 0;
  valued_before integer;
  valued_now integer;
  unvalued_now integer;
begin
  -- Si la venta no movió inventario —variante sin seguimiento entonces— la
  -- devolución tampoco lo mueve, aunque hoy la variante ya se siga: reponer
  -- unidades que nunca se descontaron inventaría existencia.
  if not exists (
    select 1 from public.inventory_movements m
    where m.source_type = 'sale' and m.source_id = p_sale_id and m.variant_id = p_variant_id
  ) then
    return 0;
  end if;

  select * into captured from public.sale_line_costs where sale_line_id = p_sale_line_id;

  -- Cuenta solo lo repuesto ANTES: quien llama invoca esta función antes de
  -- insertar la línea de la devolución en curso, precisamente para que el fondo
  -- valorado no se descuente dos veces.
  select coalesce(sum(rl.quantity), 0) into already_returned
  from public.return_lines rl
  where rl.sale_line_id = p_sale_line_id and rl.restocked;

  -- Se descuenta lo ya repuesto en devoluciones anteriores para no restituir
  -- dos veces el mismo fondo valorado.
  valued_before := least(already_returned, coalesce(captured.valued_units, 0));
  valued_now := greatest(least(p_quantity, coalesce(captured.valued_units, 0) - valued_before), 0);
  unvalued_now := p_quantity - valued_now;

  if valued_now > 0 and captured.unit_cost is not null then
    perform public.apply_inventory_movement(
      p_variant_id, p_branch_id, p_movement_type, valued_now, captured.unit_cost,
      p_source_type, p_source_id, p_source_label, p_reason, p_actor_id
    );
  elsif valued_now > 0 then
    -- Sin costo capturado no se inventa uno: vuelven como no valoradas.
    unvalued_now := unvalued_now + valued_now;
    valued_now := 0;
  end if;

  if unvalued_now > 0 then
    perform public.apply_inventory_movement(
      p_variant_id, p_branch_id, p_movement_type, unvalued_now, null,
      p_source_type, p_source_id, p_source_label, p_reason, p_actor_id
    );
  end if;

  return p_quantity;
end;
$$;

revoke all on function public.restore_sold_units(
  uuid, uuid, uuid, uuid, integer, public.inventory_movement_type, text, uuid, text, text, uuid
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Anular una venta
-- ---------------------------------------------------------------------------

create or replace function public.cancel_sale(
  p_sale_id uuid,
  p_reason_code public.cancellation_reason,
  p_explanation text,
  p_refunds jsonb default null,
  p_evidence_path text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  sale public.sales%rowtype;
  cancellation_id uuid := gen_random_uuid();
  line record;
  refund jsonb;
  declared_refund numeric(12, 2) := 0;
  collected numeric(12, 2);
begin
  if nullif(trim(coalesce(p_explanation, '')), '') is null then
    raise exception using errcode = '22023', message = 'Una anulación exige una explicación.';
  end if;

  -- Candado sobre la cabecera: serializa dos anulaciones simultáneas antes de
  -- que ninguna toque el inventario.
  select * into sale from public.sales where id = p_sale_id for update;

  if sale.id is null then
    raise exception using errcode = '22023', message = 'La venta no existe.';
  end if;

  perform public.assert_branch_access(sale.branch_id, 'anular ventas');

  if sale.status <> 'confirmed' then
    raise exception using errcode = '23514', message = 'La venta ya no está confirmada.';
  end if;

  -- La prohibición es en AMBAS direcciones: sale_cancellations.sale_id único
  -- impide la segunda anulación, y esto impide anular lo ya devuelto. Sin la
  -- segunda mitad, una venta de S/ 100 podía pagar S/ 190 en reembolsos.
  if exists (select 1 from public.returns r where r.sale_id = p_sale_id) then
    raise exception using errcode = '23514',
      message = 'La venta tiene devoluciones registradas: no puede anularse. Regístrala como devolución.';
  end if;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  insert into public.sale_cancellations (
    id, sale_id, branch_id, reason_code, explanation, evidence_path, actor_id, actor_label
  ) values (
    cancellation_id, p_sale_id, sale.branch_id, p_reason_code, trim(p_explanation),
    nullif(trim(coalesce(p_evidence_path, '')), ''), actor, actor_name
  );

  update public.sales set status = 'cancelled', updated_at = now() where id = p_sale_id;

  -- 1) EXISTENCIAS, en orden estable por variante y al costo CAPTURADO.
  for line in
    select l.id, l.variant_id, l.quantity, l.sku
    from public.sale_lines l
    where l.sale_id = p_sale_id
    order by l.variant_id
  loop
    perform public.restore_sold_units(
      p_sale_id, line.id, line.variant_id, sale.branch_id, line.quantity,
      'sale_cancelled', 'sale_cancellation', cancellation_id,
      'Anulación de ' || sale.sale_number, trim(p_explanation), actor
    );
  end loop;

  -- 2) DINERO. Una anulación sin reembolso registrado deja la caja descuadrada
  --    y el descuadre acaba atribuido a quien atendió.
  select coalesce(sum(p.amount), 0) into collected
  from public.sale_payments p where p.sale_id = p_sale_id;

  if p_refunds is null or jsonb_array_length(p_refunds) = 0 then
    -- Por omisión, el dinero vuelve por donde entró. El adelanto trasladado se
    -- reembolsa como tal: su método deja de ser reservation_advance porque ya
    -- no se está aplicando un adelanto, se está devolviendo dinero.
    insert into public.refunds (
      sale_cancellation_id, branch_id, method, amount, reference, actor_id, actor_label
    )
    select
      cancellation_id, sale.branch_id,
      case when p.method = 'reservation_advance' then 'cash'::public.payment_method else p.method end,
      p.amount,
      'Reversión de ' || sale.sale_number,
      actor, actor_name
    from public.sale_payments p
    where p.sale_id = p_sale_id;

    declared_refund := collected;
  else
    for refund in select value from jsonb_array_elements(p_refunds) loop
      insert into public.refunds (
        sale_cancellation_id, branch_id, method, amount, reference, evidence_path,
        actor_id, actor_label
      ) values (
        cancellation_id, sale.branch_id,
        (refund ->> 'method')::public.payment_method,
        (refund ->> 'amount')::numeric,
        nullif(refund ->> 'reference', ''),
        nullif(refund ->> 'evidencePath', ''),
        actor, actor_name
      );

      declared_refund := declared_refund + (refund ->> 'amount')::numeric;
    end loop;

    if declared_refund <> collected then
      raise exception using errcode = '23514',
        message = format('La anulación devuelve %s y la venta cobró %s: deben coincidir.',
                         declared_refund, collected);
    end if;
  end if;

  return public.sale_detail(p_sale_id);
exception
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Registrar una devolución
-- ---------------------------------------------------------------------------
-- El bloqueo de las LÍNEAS es la primera sentencia real: dos devoluciones
-- simultáneas de la misma sale_line reponen el doble y reembolsan el doble con
-- COMMIT limpio —write skew—. El doble clic secuencial ya se rechaza solo por
-- la validación de saldo devolvible; lo que se escapa es la simultaneidad.

create or replace function public.register_return(
  p_sale_id uuid,
  p_lines jsonb,
  p_client_operation_id uuid,
  p_reason text default null,
  p_refunds jsonb default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  sale public.sales%rowtype;
  existing_id uuid;
  new_return_id uuid := gen_random_uuid();
  new_return_number text;
  entry jsonb;
  sale_line public.sale_lines%rowtype;
  line_quantity integer;
  line_condition public.return_item_condition;
  returned_before integer;
  refunded_before numeric(12, 2);
  line_refund numeric(12, 2);
  refundable numeric(12, 2) := 0;
  declared_refund numeric(12, 2) := 0;
  refund jsonb;
  ordered_lines jsonb;
begin
  if p_client_operation_id is null then
    raise exception using errcode = '22023', message = 'Falta el identificador de operación.';
  end if;

  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    raise exception using errcode = '22023', message = 'La devolución necesita al menos una línea.';
  end if;

  select * into sale from public.sales where id = p_sale_id;

  if sale.id is null then
    raise exception using errcode = '22023', message = 'La venta no existe.';
  end if;

  perform public.assert_branch_access(sale.branch_id, 'registrar devoluciones');

  perform pg_advisory_xact_lock(
    hashtextextended(sale.branch_id::text || ':' || p_client_operation_id::text, 0)
  );

  select id into existing_id from public.returns
  where branch_id = sale.branch_id and client_operation_id = p_client_operation_id;

  if existing_id is not null then
    return public.return_detail(existing_id);
  end if;

  -- Precondición que cierra la dirección que §4 no cubría: una venta anulada no
  -- admite devolución. Los dos únicos estados de la venta existen para que este
  -- predicado sea escribible.
  if sale.status <> 'confirmed' then
    raise exception using errcode = '23514',
      message = 'Solo se devuelve sobre una venta confirmada: esta ya fue anulada.';
  end if;

  -- BLOQUEO DE LAS LÍNEAS antes de calcular ningún saldo devolvible.
  select jsonb_agg(l order by (l ->> 'saleLineId')) into ordered_lines
  from jsonb_array_elements(p_lines) l;

  perform 1 from public.sale_lines
  where id in (select (value ->> 'saleLineId')::uuid from jsonb_array_elements(ordered_lines))
  order by id
  for update;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  select sale.sale_number || '-D' ||
         (1 + (select count(*) from public.returns r where r.sale_id = p_sale_id))::text
    into new_return_number;

  insert into public.returns (
    id, sale_id, branch_id, return_number, reason, notes,
    actor_id, actor_label, client_operation_id
  ) values (
    new_return_id, p_sale_id, sale.branch_id, new_return_number,
    nullif(trim(coalesce(p_reason, '')), ''), nullif(trim(coalesce(p_notes, '')), ''),
    actor, actor_name, p_client_operation_id
  );

  for entry in select value from jsonb_array_elements(ordered_lines) loop
    select * into sale_line from public.sale_lines where id = (entry ->> 'saleLineId')::uuid;

    if sale_line.id is null or sale_line.sale_id <> p_sale_id then
      raise exception using errcode = '22023', message = 'Una línea no pertenece a esta venta.';
    end if;

    line_quantity := (entry ->> 'quantity')::integer;
    line_condition := coalesce(nullif(entry ->> 'condition', ''), 'resellable')::public.return_item_condition;

    if line_quantity is null or line_quantity <= 0 then
      raise exception using errcode = '22023', message = 'La cantidad devuelta debe ser positiva.';
    end if;

    select coalesce(sum(rl.quantity), 0), coalesce(sum(rl.refund_amount), 0)
      into returned_before, refunded_before
    from public.return_lines rl where rl.sale_line_id = sale_line.id;

    if returned_before + line_quantity > sale_line.quantity then
      raise exception using errcode = '23514',
        message = format('De %s se vendieron %s unidades y ya se devolvieron %s: no caben %s más.',
                         coalesce(sale_line.sku, 'esa presentación'),
                         sale_line.quantity, returned_before, line_quantity);
    end if;

    -- Diferencia ACUMULADA, no unitario × cantidad: con el prorrateo del
    -- descuento, 7 × 14,32 = 100,24 sobre 100,23 cobrados. Así el residuo lo
    -- absorbe la última devolución y nunca se devuelve de más.
    line_refund := round(sale_line.subtotal * ((returned_before + line_quantity)::numeric / sale_line.quantity), 2)
                   - refunded_before;
    refundable := refundable + line_refund;

    -- El asiento va ANTES de insertar la línea: restore_sold_units cuenta lo ya
    -- repuesto leyendo return_lines, y con la línea en curso ya escrita
    -- descontaría dos veces el fondo valorado de esta misma devolución.
    if line_condition = 'resellable' then
      perform public.restore_sold_units(
        p_sale_id, sale_line.id, sale_line.variant_id, sale.branch_id, line_quantity,
        'return_restock', 'return', new_return_id,
        'Devolución ' || new_return_number,
        coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Devolución'), actor
      );
    end if;

    insert into public.return_lines (
      return_id, sale_line_id, variant_id, sku, product_name, variant_name,
      quantity, condition, refund_amount, restocked
    ) values (
      new_return_id, sale_line.id, sale_line.variant_id, sale_line.sku,
      sale_line.product_name, sale_line.variant_name,
      line_quantity, line_condition, line_refund,
      line_condition = 'resellable'
    );
  end loop;

  update public.returns set refund_total = refundable where id = new_return_id;

  -- El dinero puede salir ahora, salir por otro medio o no salir todavía. Lo
  -- que no puede es superar lo devuelto.
  if p_refunds is not null and jsonb_array_length(p_refunds) > 0 then
    for refund in select value from jsonb_array_elements(p_refunds) loop
      insert into public.refunds (
        return_id, branch_id, method, amount, reference, evidence_path, actor_id, actor_label
      ) values (
        new_return_id, sale.branch_id,
        (refund ->> 'method')::public.payment_method,
        (refund ->> 'amount')::numeric,
        nullif(refund ->> 'reference', ''),
        nullif(refund ->> 'evidencePath', ''),
        actor, actor_name
      );

      declared_refund := declared_refund + (refund ->> 'amount')::numeric;
    end loop;

    if declared_refund > refundable then
      raise exception using errcode = '23514',
        message = format('El reembolso declarado (%s) supera lo devuelto (%s).',
                         declared_refund, refundable);
    end if;
  end if;

  return public.return_detail(new_return_id);
exception
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Cancelar una reserva con su adelanto
-- ---------------------------------------------------------------------------
-- El estado 'cancelled' de reservations no lo producía ningún contrato. La
-- retención no mueve dinero físico —el arqueo ya lo contó el día que entró— así
-- que lo único que faltaba era el vehículo del reembolso.

create or replace function public.cancel_reservation(
  p_reservation_id uuid,
  p_reason text,
  p_advance_policy public.reservation_advance_policy default 'refund',
  p_refund_method public.payment_method default 'cash'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  reservation public.reservations%rowtype;
  advance numeric(12, 2);
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Cancelar una reserva exige un motivo.';
  end if;

  select * into reservation from public.reservations where id = p_reservation_id;

  if reservation.id is null then
    raise exception using errcode = '22023', message = 'La reserva no existe.';
  end if;

  perform public.assert_branch_access(reservation.branch_id, 'cancelar reservas');

  if reservation.status = 'converted' then
    raise exception using errcode = '23514',
      message = 'La reserva ya se convirtió en venta: anula la venta, no la reserva.';
  end if;

  if reservation.status = 'active' then
    -- La liberación aplica la transición condicional y devuelve lo comprometido.
    perform public.release_reservation(p_reservation_id, trim(p_reason), 'cancelled');
  end if;
  -- Una reserva ya vencida o liberada no tiene nada comprometido que devolver,
  -- pero su adelanto sigue en caja y hay que resolverlo igual: conserva su
  -- estado y solo se registra la salida de dinero.

  select coalesce(sum(p.amount), 0) into advance
  from public.reservation_payments p where p.reservation_id = p_reservation_id;

  if p_advance_policy = 'refund' and advance > 0 then
    select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
    from public.admin_profiles p where p.id = actor;

    insert into public.refunds (
      reservation_id, branch_id, method, amount, reference, actor_id, actor_label
    ) values (
      p_reservation_id, reservation.branch_id, p_refund_method, advance,
      'Adelanto de ' || reservation.reservation_number, actor, actor_name
    );
  end if;

  return public.reservation_detail(p_reservation_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Lecturas
-- ---------------------------------------------------------------------------

create or replace function public.return_detail(p_return_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'returnNumber', r.return_number,
    'saleId', r.sale_id,
    'saleNumber', (select s.sale_number from public.sales s where s.id = r.sale_id),
    'branchId', r.branch_id,
    'reason', r.reason,
    'notes', r.notes,
    'refundTotal', r.refund_total,
    'currency', r.currency,
    'actorLabel', r.actor_label,
    'occurredAt', r.occurred_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'saleLineId', l.sale_line_id, 'variantId', l.variant_id,
        'sku', l.sku, 'productName', l.product_name, 'variantName', l.variant_name,
        'quantity', l.quantity, 'condition', l.condition,
        'refundAmount', l.refund_amount, 'restocked', l.restocked
      ) order by l.created_at, l.id)
      from public.return_lines l where l.return_id = r.id
    ), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', f.id, 'method', f.method, 'amount', f.amount,
        'reference', f.reference, 'paidAt', f.paid_at
      ) order by f.paid_at, f.id)
      from public.refunds f where f.return_id = r.id
    ), '[]'::jsonb)
  )
  from public.returns r where r.id = p_return_id;
$$;

-- Margen de una venta. El COGS NETO es una resta contra el kardex, no una
-- segunda tabla de costos: lo repuesto por una anulación o una devolución
-- vendible ya está escrito ahí con su value_delta.
create or replace function public.sale_margin(p_sale_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'El margen es información administrativa.';
  end if;

  select jsonb_build_object(
    'saleId', s.id,
    'saleNumber', s.sale_number,
    'status', s.status,
    'revenue', s.total,
    'refunded', coalesce((
      select sum(f.amount) from public.refunds f
      where f.sale_cancellation_id in (select c.id from public.sale_cancellations c where c.sale_id = s.id)
         or f.return_id in (select r.id from public.returns r where r.sale_id = s.id)
    ), 0),
    'grossCost', coalesce((
      select sum(c.total_cost) from public.sale_line_costs c where c.sale_id = s.id
    ), 0),
    'restoredCost', coalesce((
      select sum(m.value_delta)
      from public.inventory_movements m
      where (m.source_type = 'sale_cancellation'
             and m.source_id in (select c.id from public.sale_cancellations c where c.sale_id = s.id))
         or (m.source_type = 'return'
             and m.source_id in (select r.id from public.returns r where r.sale_id = s.id))
    ), 0),
    -- No calculable cuando alguna línea salió de unidades sin costo conocido:
    -- un margen inventado es peor que un margen ausente.
    'costKnown', not exists (
      select 1 from public.sale_line_costs c
      where c.sale_id = s.id and c.cost_basis = 'unknown'
    )
  ) into result
  from public.sales s where s.id = p_sale_id;

  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------

alter table public.sale_cancellations enable row level security;
alter table public.returns enable row level security;
alter table public.return_lines enable row level security;
alter table public.refunds enable row level security;

create policy "staff read cancellations of their branches"
on public.sale_cancellations for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "staff read returns of their branches"
on public.returns for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "staff read return lines"
on public.return_lines for select to authenticated
using (exists (select 1 from public.returns r
               where r.id = return_id and r.branch_id in (select public.staff_branch_ids())));

-- Sin políticas de update ni delete sobre el dinero que sale.
create policy "staff read refunds of their branches"
on public.refunds for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

-- ---------------------------------------------------------------------------
-- 11. Privilegios
-- ---------------------------------------------------------------------------

grant select on public.sale_cancellations to authenticated;
grant select on public.returns to authenticated;
grant select on public.return_lines to authenticated;
grant select on public.refunds to authenticated;

grant select, insert, update, delete on
  public.sale_cancellations, public.returns, public.return_lines, public.refunds
to service_role;

revoke truncate on public.sale_cancellations, public.returns,
  public.return_lines, public.refunds
from anon, authenticated, service_role;

revoke all on function public.cancel_sale(uuid, public.cancellation_reason, text, jsonb, text) from public, anon;
revoke all on function public.register_return(uuid, jsonb, uuid, text, jsonb, text) from public, anon;
revoke all on function public.cancel_reservation(uuid, text, public.reservation_advance_policy, public.payment_method) from public, anon;
revoke all on function public.return_detail(uuid) from public, anon;
revoke all on function public.sale_margin(uuid) from public, anon;

grant execute on function public.cancel_sale(uuid, public.cancellation_reason, text, jsonb, text) to authenticated, service_role;
grant execute on function public.register_return(uuid, jsonb, uuid, text, jsonb, text) to authenticated, service_role;
grant execute on function public.cancel_reservation(uuid, text, public.reservation_advance_policy, public.payment_method) to authenticated, service_role;
grant execute on function public.return_detail(uuid) to authenticated, service_role;
grant execute on function public.sale_margin(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Auditoría
-- ---------------------------------------------------------------------------

select public.attach_audit('public.sale_cancellations');
select public.attach_audit('public.returns');
select public.attach_audit('public.return_lines');
select public.attach_audit('public.refunds');

commit;
