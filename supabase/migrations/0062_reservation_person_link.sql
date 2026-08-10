-- ---------------------------------------------------------------------------
-- 0062 · La reserva guarda a QUIÉN se le reservó, no solo cómo se llamaba
-- ---------------------------------------------------------------------------
-- 0054 dio `person_id` a la venta y 0055 enseñó a `register_sale` a escribirlo.
-- La reserva se quedó fuera, y eso deja un agujero de identidad en el sitio
-- exacto donde más se nota: una clienta que reserva es, por definición, una
-- clienta que vuelve. Sin enlace, «Rosa Díaz» la reserva y «Rosa Diaz» la
-- recoge, y su historial queda partido en dos.
--
-- Y hay una segunda pérdida, silenciosa: al convertir la reserva en venta, la
-- venta nacía sin clienta aunque la reserva supiera quién era.
-- ---------------------------------------------------------------------------

alter table public.reservations
  add column person_id uuid references public.persons (id);

comment on column public.reservations.person_id is
  'La clienta identificada, cuando la hay. Los campos customer_* siguen siendo '
  'la instantánea de cómo se escribió su nombre al reservar: lo que se enlaza y '
  'lo que se imprime son cosas distintas.';

create index reservations_person_idx on public.reservations (person_id)
  where person_id is not null;

-- ---------------------------------------------------------------------------
-- 1. La venta hereda la clienta de su reserva
-- ---------------------------------------------------------------------------
-- Va en la base y no en `register_sale` por dos motivos. Uno: la firma de
-- `register_sale` no cambia, y restar una tercera copia de sus trescientas
-- líneas a la historia del repositorio es un bien en sí mismo. Dos, el que
-- importa: así lo hereda CUALQUIER camino que convierta una reserva, incluido
-- el que todavía no existe. Que el llamador se acuerde no es una garantía; que
-- no pueda olvidarlo, sí.
create or replace function public.inherit_sale_person_from_reservation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.person_id is null and new.reservation_id is not null then
    select r.person_id into new.person_id
    from public.reservations r where r.id = new.reservation_id;
  end if;
  return new;
end;
$$;

comment on function public.inherit_sale_person_from_reservation() is
  'Una venta que nace de una reserva hereda su clienta. Solo rellena el hueco: '
  'si el llamador mandó una persona, manda la suya.';

revoke execute on function public.inherit_sale_person_from_reservation() from public;

-- Antes que `sales_resolve_attribution` por orden alfabético del nombre, que es
-- el orden en que PostgreSQL dispara los BEFORE de una misma tabla. No hay
-- dependencia entre ambos, pero dejarlo al azar del nombre sería frágil por
-- accidente.
create trigger sales_a_inherit_person
  before insert on public.sales
  for each row
  execute function public.inherit_sale_person_from_reservation();

-- ---------------------------------------------------------------------------
-- 2. `create_reservation` aprende a escribirla
-- ---------------------------------------------------------------------------
-- Mismo aviso de siempre: añadir un parámetro crea una SOBRECARGA, hay que
-- borrar la firma anterior y rehacer los privilegios.
drop function if exists public.create_reservation(
  uuid, jsonb, jsonb, timestamptz, uuid, jsonb, text
);

CREATE OR REPLACE FUNCTION public.create_reservation(p_branch_id uuid, p_lines jsonb, p_customer jsonb, p_expires_at timestamp with time zone, p_client_operation_id uuid, p_advance jsonb DEFAULT NULL::jsonb, p_notes text DEFAULT NULL::text, p_person_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  actor_name text;
  existing_id uuid;
  evaluation jsonb;
  line jsonb;
  new_id uuid := gen_random_uuid();
  reservation_number text;
  total numeric(12, 2) := 0;
  advance_amount numeric(12, 2);
  stock public.inventory_stock%rowtype;
  ordered_lines jsonb;
  reserved_flags jsonb := '[]'::jsonb;
  tracked boolean;
  idx integer := 0;
begin
  if p_client_operation_id is null then
    raise exception using errcode = '22023', message = 'Falta el identificador de operación.';
  end if;

  perform public.assert_branch_access(p_branch_id, 'reservar');

  if nullif(trim(coalesce(p_customer ->> 'name', '')), '') is null then
    raise exception using errcode = '22023', message = 'Una reserva exige el nombre del cliente.';
  end if;

  if p_expires_at is null or p_expires_at <= now() then
    raise exception using errcode = '22023', message = 'La fecha de vencimiento debe ser futura.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_branch_id::text || ':' || p_client_operation_id::text, 0)
  );

  select id into existing_id from public.reservations
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing_id is not null then
    return public.reservation_detail(existing_id);
  end if;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  evaluation := public.evaluate_cart_v2(p_lines);

  if exists (
    select 1 from jsonb_array_elements(evaluation -> 'lines') l
    where (l ->> 'unitPrice') is null
  ) then
    raise exception using errcode = '22023',
      message = 'Hay una presentación sin precio: debe consultarse antes de reservar.';
  end if;

  select jsonb_agg(l order by (l ->> 'variantId')) into ordered_lines
  from jsonb_array_elements(evaluation -> 'lines') l;

  for line in select value from jsonb_array_elements(ordered_lines) loop
    total := total + ((line ->> 'subtotal')::numeric);
  end loop;

  advance_amount := nullif(p_advance ->> 'amount', '')::numeric;

  if advance_amount is not null and advance_amount > total then
    raise exception using errcode = '22023',
      message = format('El adelanto (%s) no puede superar el total reservado (%s).', advance_amount, total);
  end if;

  -- 1) EXISTENCIAS primero. Una reserva NO disminuye on_hand: incrementa
  --    reserved, y la disponibilidad efectiva es on_hand - reserved.
  for line in select value from jsonb_array_elements(ordered_lines) loop
    select v.tracks_inventory into tracked
    from public.product_variants v where v.id = (line ->> 'variantId')::uuid;

    if coalesce(tracked, false) then
      insert into public.inventory_stock as s (variant_id, branch_id, on_hand, reserved)
      values ((line ->> 'variantId')::uuid, p_branch_id, 0, 0)
      on conflict (variant_id, branch_id) do update set updated_at = s.updated_at;

      select * into stock from public.inventory_stock
      where variant_id = (line ->> 'variantId')::uuid and branch_id = p_branch_id
      for update;

      if stock.on_hand - stock.reserved < (line ->> 'quantity')::integer then
        raise exception using errcode = '23514',
          message = format('No hay disponibilidad suficiente de %s: quedan %s.',
                           coalesce(line ->> 'sku', 'la presentación'),
                           stock.on_hand - stock.reserved);
      end if;

      update public.inventory_stock
      set reserved = reserved + (line ->> 'quantity')::integer
      where variant_id = (line ->> 'variantId')::uuid and branch_id = p_branch_id;
    end if;

    reserved_flags := reserved_flags || jsonb_build_array(to_jsonb(coalesce(tracked, false)));
  end loop;

  -- 2) CORRELATIVO después, igual que en la venta.
  reservation_number := public.next_document_number(p_branch_id, 'reservation');

  insert into public.reservations (
    id, branch_id, reservation_number, customer_name, customer_phone, customer_document,
    expires_at, total, notes, created_by, created_by_label, client_operation_id, person_id
  ) values (
    new_id, p_branch_id, reservation_number,
    trim(p_customer ->> 'name'),
    nullif(trim(coalesce(p_customer ->> 'phone', '')), ''),
    nullif(trim(coalesce(p_customer ->> 'document', '')), ''),
    p_expires_at, total, p_notes, actor, actor_name, p_client_operation_id, p_person_id
  );

  idx := 0;
  for line in select value from jsonb_array_elements(ordered_lines) loop
    insert into public.reservation_lines (
      reservation_id, variant_id, sku, product_name, variant_name, brand_name,
      quantity, unit_price, subtotal, purchase_mode, reserved_stock
    ) values (
      new_id, (line ->> 'variantId')::uuid, line ->> 'sku',
      line ->> 'productName', line ->> 'variantName', line ->> 'brandName',
      (line ->> 'quantity')::integer, (line ->> 'unitPrice')::numeric,
      (line ->> 'subtotal')::numeric, coalesce(line ->> 'purchaseMode', 'retail'),
      coalesce((reserved_flags ->> idx)::boolean, false)
    );
    idx := idx + 1;
  end loop;

  if advance_amount is not null then
    insert into public.reservation_payments (
      reservation_id, method, amount, tendered_amount, reference, evidence_path,
      received_at, created_by, created_by_label
    ) values (
      new_id, (p_advance ->> 'method')::public.payment_method,
      advance_amount,
      nullif(p_advance ->> 'tenderedAmount', '')::numeric,
      nullif(p_advance ->> 'reference', ''),
      nullif(p_advance ->> 'evidencePath', ''),
      coalesce(nullif(p_advance ->> 'receivedAt', '')::timestamptz, now()),
      actor, actor_name
    );
  end if;

  return public.reservation_detail(new_id);
exception
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$function$;

revoke execute on function public.create_reservation(
  uuid, jsonb, jsonb, timestamptz, uuid, jsonb, text, uuid
) from public;

grant execute on function public.create_reservation(
  uuid, jsonb, jsonb, timestamptz, uuid, jsonb, text, uuid
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. El detalle la devuelve
-- ---------------------------------------------------------------------------
create or replace function public.reservation_detail(p_reservation_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'id', r.id,
    'reservationNumber', r.reservation_number,
    'branchId', r.branch_id,
    'branchName', (select b.name from public.branches b where b.id = r.branch_id),
    'status', r.status,
    'customerName', r.customer_name,
    'customerPhone', r.customer_phone,
    'customerDocument', r.customer_document,
    'personId', r.person_id,
    'expiresAt', r.expires_at,
    'total', r.total,
    'currency', r.currency,
    'notes', r.notes,
    'releaseReason', r.release_reason,
    'advanceTotal', coalesce((select sum(p.amount) from public.reservation_payments p where p.reservation_id = r.id), 0),
    'balance', r.total - coalesce((select sum(p.amount) from public.reservation_payments p where p.reservation_id = r.id), 0),
    'saleId', (select s.id from public.sales s where s.reservation_id = r.id),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', l.variant_id, 'sku', l.sku, 'productName', l.product_name,
        'variantName', l.variant_name, 'brandName', l.brand_name, 'quantity', l.quantity,
        'unitPrice', l.unit_price, 'subtotal', l.subtotal,
        'purchaseMode', l.purchase_mode, 'reservedStock', l.reserved_stock
      ) order by l.created_at, l.variant_id)
      from public.reservation_lines l where l.reservation_id = r.id
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'method', p.method, 'amount', p.amount, 'receivedAt', p.received_at
      ) order by p.received_at, p.id)
      from public.reservation_payments p where p.reservation_id = r.id
    ), '[]'::jsonb)
  )
  from public.reservations r where r.id = p_reservation_id;
$function$;
