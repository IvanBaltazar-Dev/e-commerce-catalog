-- Bloque 2 · Cierre — el cajón se alimenta del dinero, no de que cada contrato
-- se acuerde de avisarle.
--
-- DEFECTO ENCONTRADO POR LA PRUEBA INTEGRAL. `record_cash_movement` (0032)
-- declara en su propio comentario que «se invoca desde los contratos de venta,
-- reembolso, pago a proveedor y gasto», y el enumerado `cash_movement_kind` ya
-- reserva los cuatro valores. Pero solo `register_expense` y `void_expense` lo
-- llamaban: ninguna venta, ningún reembolso y ningún pago a proveedor llegaba
-- nunca al cajón.
--
-- La consecuencia no es cosmética. `close_cash_session` calcula el efectivo
-- esperado sumando `cash_movements` de la sesión, así que cerraba una caja con
-- 60,00 esperados cuando en el cajón había 131,25 de ventas reales, y declaraba
-- una diferencia de 71,25 —reproducido en `scripts/test-block2-integral.mjs`—.
-- Ese descuadre se atribuye a quien atendió, que es exactamente lo que el
-- modelo repite que no puede pasar.
--
-- POR QUÉ UN TRIGGER Y NO UNA LLAMADA EN CADA RPC. Colgar el aviso de cada
-- contrato lo deja a merced de que nadie lo olvide en el siguiente, y ya se
-- olvidó en tres. El cajón se alimenta de las TABLAS de dinero, que son cuatro
-- y están cerradas a escritura directa: cualquier contrato futuro que cobre o
-- pague queda registrado sin hacer nada.
--
-- QUÉ NO ENTRA AL CAJÓN:
--   · el adelanto TRASLADADO a una venta (`method = 'reservation_advance'`),
--     porque ese dinero entró el día de la reserva y ya se contó entonces;
--   · el dinero cuya fecha propia es anterior a la apertura de la sesión, que
--     es captura de una operación pasada y no un billete que entre hoy al
--     cajón.

begin;

create or replace function public.feed_cash_drawer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_branch uuid;
  kind public.cash_movement_kind;
  signed_amount numeric(14, 2);
  happened_at timestamptz;
  source_label text;
  session public.cash_sessions%rowtype;
  actor uuid := auth.uid();
begin
  if tg_table_name = 'sale_payments' then
    -- El adelanto trasladado NO es dinero nuevo: entró el día de la reserva.
    if new.method = 'reservation_advance' then
      return null;
    end if;

    select s.branch_id, s.sale_number into target_branch, source_label
    from public.sales s where s.id = new.sale_id;

    kind := 'sale';
    signed_amount := new.amount;
    happened_at := new.received_at;

  elsif tg_table_name = 'reservation_payments' then
    select r.branch_id, r.reservation_number into target_branch, source_label
    from public.reservations r where r.id = new.reservation_id;

    kind := 'reservation_advance';
    signed_amount := new.amount;
    happened_at := new.received_at;

  elsif tg_table_name = 'refunds' then
    target_branch := new.branch_id;
    kind := 'refund';
    signed_amount := -1 * new.amount;
    happened_at := new.paid_at;
    source_label := 'Reembolso';

  elsif tg_table_name = 'supplier_payments' then
    target_branch := new.branch_id;
    kind := 'supplier_payment';
    signed_amount := -1 * new.amount;
    happened_at := new.paid_at;
    source_label := 'Pago a proveedor';

  else
    return null;
  end if;

  if target_branch is null then
    return null;
  end if;

  -- Sin caja abierta el movimiento no se pierde: el arqueo del día se deriva de
  -- los documentos en `daily_cash_summary`. Lo que no ocurre es que aparezca en
  -- un cajón que nadie abrió.
  select * into session from public.cash_sessions
  where branch_id = target_branch and status = 'open';

  if session.id is null then
    return null;
  end if;

  -- Dinero anterior a la apertura: es captura de una operación pasada, no un
  -- billete que entre a ESTE cajón.
  if happened_at < session.opened_at then
    return null;
  end if;

  insert into public.cash_movements (
    cash_session_id, branch_id, kind, method, amount,
    source_type, source_id, source_label,
    actor_id, actor_label, occurred_at
  ) values (
    session.id, target_branch, kind, new.method, signed_amount,
    tg_table_name, new.id, source_label,
    actor,
    (select nullif(trim(coalesce(p.full_name, '')), '') from public.admin_profiles p where p.id = actor),
    happened_at
  );

  return null;
end;
$$;

revoke all on function public.feed_cash_drawer() from public, anon, authenticated;

create trigger sale_payments_feed_drawer
after insert on public.sale_payments
for each row execute function public.feed_cash_drawer();

create trigger reservation_payments_feed_drawer
after insert on public.reservation_payments
for each row execute function public.feed_cash_drawer();

create trigger refunds_feed_drawer
after insert on public.refunds
for each row execute function public.feed_cash_drawer();

create trigger supplier_payments_feed_drawer
after insert on public.supplier_payments
for each row execute function public.feed_cash_drawer();

comment on function public.feed_cash_drawer() is
  'Alimenta cash_movements desde las cuatro tablas de dinero. Excluye el '
  'adelanto trasladado y lo anterior a la apertura de la sesión.';

commit;
