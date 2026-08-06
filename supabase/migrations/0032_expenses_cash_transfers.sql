-- Bloque 2 · Migración 5 de 5 — Gastos, caja y arqueo, traslados e inventario inicial.
--
-- Cierra el circuito económico: hasta aquí el dinero entraba y salía sin que
-- nadie pudiera cuadrar el cajón al final del día.
--
-- DECISIONES QUE GOBIERNAN ESTA MIGRACIÓN:
--
-- A. EL ARQUEO SUMA POR `received_at`, NO POR `applied_at`. Un adelanto de enero
--    aplicado a una venta de febrero entró en caja en enero. 0029 separó las dos
--    fechas precisamente para que esta consulta fuese escribible.
--
-- B. SOLO EL EFECTIVO SE CUENTA EN EL CAJÓN. Yape, Plin, transferencia y tarjeta
--    se resumen por método pero no afectan la diferencia de arqueo: nadie los
--    cuenta a mano al cerrar.
--
-- C. EL TRASLADO ES UNA SOLA TRANSACCIÓN CON DOS MITADES. `transfer_out` y
--    `transfer_in` comparten identificador y se escriben juntos o no se escribe
--    ninguno. Media transferencia es inventario inventado o desaparecido.
--
-- D. EL LOTE DE CARGA INICIAL ES REVERSIBLE MIENTRAS NO HAYA HISTORIA POSTERIOR.
--    Equivocarse contando 1.500 SKU es lo normal; lo que no puede pasar es
--    deshacer una carga sobre la que ya se vendió.

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.expense_recurrence as enum ('one_off', 'recurring');

create type public.cash_session_status as enum ('open', 'closed');

create type public.cash_movement_kind as enum (
  'opening_float', 'sale', 'reservation_advance', 'refund',
  'supplier_payment', 'expense', 'withdrawal', 'manual_income'
);

create type public.transfer_status as enum (
  'requested', 'dispatched', 'received', 'rejected', 'cancelled'
);

create type public.initial_load_status as enum ('committed', 'reverted');

-- ---------------------------------------------------------------------------
-- 1. Gastos
-- ---------------------------------------------------------------------------

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  -- Distingue el gasto de tienda del administrativo y del asociado a compras,
  -- que es lo que el reporte de rentabilidad necesita separar.
  scope text not null default 'store',
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  constraint expense_categories_code_format check (code ~ '^[A-Z0-9]+(_[A-Z0-9]+)*$'),
  constraint expense_categories_name_not_blank check (length(trim(name)) > 0),
  constraint expense_categories_scope check (scope in ('store', 'administrative', 'purchasing'))
);

insert into public.expense_categories (code, name, scope, sort_order) values
  ('ALQUILER', 'Alquiler del local', 'store', 10),
  ('SERVICIOS', 'Luz, agua e internet', 'store', 20),
  ('PERSONAL', 'Personal y honorarios', 'administrative', 30),
  ('FLETE', 'Flete y transporte de mercadería', 'purchasing', 40),
  ('ADUANAS', 'Aduanas e importación', 'purchasing', 50),
  ('INSUMOS', 'Insumos y material de tienda', 'store', 60),
  ('PUBLICIDAD', 'Publicidad y contenido', 'administrative', 70),
  ('MANTENIMIENTO', 'Mantenimiento y reparaciones', 'store', 80),
  ('OTROS', 'Otros gastos', 'administrative', 999);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  expense_category_id uuid not null references public.expense_categories(id) on delete restrict,
  -- Beneficiario opcional: un gasto puede no tener proveedor registrado.
  supplier_id uuid references public.suppliers(id) on delete restrict,
  payee_name text,
  method public.payment_method not null,
  amount numeric(14, 2) not null,
  currency char(3) not null default 'PEN',
  incurred_at date not null default current_date,
  document_kind public.tax_document_kind,
  document_series text,
  document_number text,
  evidence_path text,
  description text not null,
  recurrence public.expense_recurrence not null default 'one_off',
  -- Anulación sin borrado físico: el gasto original nunca desaparece.
  voided_at timestamptz,
  void_reason text,
  voided_by uuid,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_amount_positive check (amount > 0),
  constraint expenses_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint expenses_description_not_blank check (length(trim(description)) > 0),
  constraint expenses_void_paired check ((voided_at is null) = (void_reason is null)),
  constraint expenses_operation_unique unique (branch_id, client_operation_id)
);

create index expenses_branch_date_idx on public.expenses(branch_id, incurred_at desc);
create index expenses_category_idx on public.expenses(expense_category_id, incurred_at desc);
create index expenses_supplier_idx on public.expenses(supplier_id) where supplier_id is not null;

create trigger expenses_set_updated_at
before update on public.expenses
for each row execute function public.set_updated_at();

-- Imputación a una compra, una recepción o una venta. Alcance excluyente, el
-- patrón de wholesale_rules. Sin fila = gasto general.
create table public.expense_allocations (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete restrict,
  purchase_order_id uuid references public.purchase_orders(id) on delete restrict,
  goods_receipt_id uuid references public.goods_receipts(id) on delete restrict,
  sale_id uuid references public.sales(id) on delete restrict,
  amount numeric(14, 2) not null,
  created_at timestamptz not null default now(),
  constraint expense_allocations_amount_positive check (amount > 0),
  constraint expense_allocations_exactly_one_target check (
    num_nonnulls(purchase_order_id, goods_receipt_id, sale_id) = 1
  )
);

create index expense_allocations_expense_idx on public.expense_allocations(expense_id);
create index expense_allocations_receipt_idx on public.expense_allocations(goods_receipt_id);

-- No se puede imputar más de lo gastado.
create or replace function public.assert_expense_allocation_limit()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  spent numeric(14, 2);
  allocated numeric(14, 2);
begin
  select e.amount into spent from public.expenses e
  where e.id = coalesce(new.expense_id, old.expense_id);

  if spent is null then
    return null;
  end if;

  select coalesce(sum(a.amount), 0) into allocated
  from public.expense_allocations a
  where a.expense_id = coalesce(new.expense_id, old.expense_id);

  if allocated > spent then
    raise exception using
      errcode = '23514',
      message = format('Lo imputado (%s) supera el importe del gasto (%s).', allocated, spent);
  end if;

  return null;
end;
$$;

revoke all on function public.assert_expense_allocation_limit() from public;

create constraint trigger expense_allocations_within_expense
after insert or update on public.expense_allocations
deferrable initially deferred
for each row execute function public.assert_expense_allocation_limit();

-- ---------------------------------------------------------------------------
-- 2. Caja
-- ---------------------------------------------------------------------------

create table public.cash_sessions (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  session_number text not null,
  status public.cash_session_status not null default 'open',
  opening_float numeric(14, 2) not null default 0,
  opened_at timestamptz not null default now(),
  opened_by uuid,
  opened_by_label text,
  closed_at timestamptz,
  closed_by uuid,
  closed_by_label text,
  -- Lo que la persona cuenta físicamente al cerrar.
  counted_cash numeric(14, 2),
  -- Lo que el sistema esperaba, congelado al cerrar para que el arqueo no
  -- cambie si después se registra una operación con fecha anterior.
  expected_cash numeric(14, 2),
  difference numeric(14, 2),
  closing_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cash_sessions_float_non_negative check (opening_float >= 0),
  constraint cash_sessions_counted_non_negative check (counted_cash is null or counted_cash >= 0),
  constraint cash_sessions_number_unique unique (branch_id, session_number),
  constraint cash_sessions_closed_complete check (
    status = 'open' or (closed_at is not null and counted_cash is not null and expected_cash is not null)
  )
);

comment on table public.cash_sessions is
  'Apertura y cierre de caja por sede. La diferencia se congela al cerrar: el '
  'arqueo es una foto, no una consulta que cambia sola.';

-- Una sola caja abierta por sede.
create unique index cash_sessions_one_open_per_branch
on public.cash_sessions(branch_id) where status = 'open';

create index cash_sessions_branch_idx on public.cash_sessions(branch_id, opened_at desc);

create trigger cash_sessions_set_updated_at
before update on public.cash_sessions
for each row execute function public.set_updated_at();

-- Movimientos de caja. De solo adición: el historial es inmutable.
create table public.cash_movements (
  id bigint generated always as identity primary key,
  cash_session_id uuid not null references public.cash_sessions(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  kind public.cash_movement_kind not null,
  method public.payment_method not null,
  -- Con signo: positivo entra, negativo sale.
  amount numeric(14, 2) not null,
  -- Origen polimórfico, sin FK, con etiqueta legible. Misma regla que el kardex.
  source_type text,
  source_id uuid,
  source_label text,
  actor_id uuid,
  actor_label text,
  note text,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint cash_movements_amount_not_zero check (amount <> 0)
);

create index cash_movements_session_idx on public.cash_movements(cash_session_id, id);
create index cash_movements_branch_idx on public.cash_movements(branch_id, occurred_at desc);

create trigger cash_movements_no_update
before update on public.cash_movements
for each row execute function public.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- 3. Traslados entre sedes
-- ---------------------------------------------------------------------------

create table public.inventory_transfers (
  id uuid primary key default gen_random_uuid(),
  transfer_number text not null,
  status public.transfer_status not null default 'requested',
  origin_branch_id uuid not null references public.branches(id) on delete restrict,
  destination_branch_id uuid not null references public.branches(id) on delete restrict,
  requested_at timestamptz not null default now(),
  dispatched_at timestamptz,
  received_at timestamptz,
  resolved_at timestamptz,
  reason text,
  discrepancy_note text,
  requested_by uuid,
  requested_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_transfers_distinct_branches check (origin_branch_id <> destination_branch_id),
  constraint inventory_transfers_number_unique unique (transfer_number),
  constraint inventory_transfers_operation_unique unique (origin_branch_id, client_operation_id)
);

comment on table public.inventory_transfers is
  'Traslado entre sedes. Las dos mitades del movimiento comparten este '
  'identificador y se escriben en la misma transacción: media transferencia es '
  'inventario inventado o desaparecido.';

create index inventory_transfers_origin_idx on public.inventory_transfers(origin_branch_id, requested_at desc);
create index inventory_transfers_destination_idx on public.inventory_transfers(destination_branch_id, requested_at desc);

create trigger inventory_transfers_set_updated_at
before update on public.inventory_transfers
for each row execute function public.set_updated_at();

create table public.inventory_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  inventory_transfer_id uuid not null references public.inventory_transfers(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text,
  product_name text,
  variant_name text,
  requested_units integer not null,
  dispatched_units integer,
  received_units integer,
  -- Valor que salió de la sede origen, para que la de destino lo incorpore al
  -- mismo costo y el traslado no cree ni destruya valor.
  unit_cost numeric(16, 6),
  cost_basis public.inventory_cost_basis,
  created_at timestamptz not null default now(),
  constraint inventory_transfer_lines_requested_positive check (requested_units > 0),
  constraint inventory_transfer_lines_dispatched_valid check (
    dispatched_units is null or (dispatched_units >= 0 and dispatched_units <= requested_units)
  ),
  constraint inventory_transfer_lines_received_valid check (
    received_units is null or received_units >= 0
  ),
  constraint inventory_transfer_lines_unique unique (inventory_transfer_id, variant_id)
);

create index inventory_transfer_lines_transfer_idx on public.inventory_transfer_lines(inventory_transfer_id);
create index inventory_transfer_lines_variant_idx on public.inventory_transfer_lines(variant_id);

-- ---------------------------------------------------------------------------
-- 4. Lote de carga inicial
-- ---------------------------------------------------------------------------
-- 0028 dejó `load_initial_inventory` sin trazabilidad de lote: no había forma de
-- saber qué se cargó junto ni de deshacerlo.

create table public.initial_load_batches (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  batch_number text not null,
  status public.initial_load_status not null default 'committed',
  -- Fecha de la toma física, que no es la fecha de captura.
  counted_at date not null default current_date,
  row_count integer not null default 0,
  total_units integer not null default 0,
  valued_units integer not null default 0,
  notes text,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  reverted_at timestamptz,
  revert_reason text,
  constraint initial_load_batches_counts_non_negative check (
    row_count >= 0 and total_units >= 0 and valued_units >= 0 and valued_units <= total_units
  ),
  constraint initial_load_batches_number_unique unique (batch_number),
  constraint initial_load_batches_operation_unique unique (branch_id, client_operation_id),
  constraint initial_load_batches_revert_paired check ((reverted_at is null) = (revert_reason is null))
);

create table public.initial_load_rows (
  id uuid primary key default gen_random_uuid(),
  initial_load_batch_id uuid not null references public.initial_load_batches(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text not null,
  quantity integer not null,
  unit_cost numeric(16, 6),
  inventory_movement_id bigint,
  created_at timestamptz not null default now(),
  constraint initial_load_rows_quantity_non_negative check (quantity >= 0),
  constraint initial_load_rows_cost_non_negative check (unit_cost is null or unit_cost >= 0),
  constraint initial_load_rows_unique unique (initial_load_batch_id, variant_id)
);

create index initial_load_rows_batch_idx on public.initial_load_rows(initial_load_batch_id);
create index initial_load_rows_variant_idx on public.initial_load_rows(variant_id);


-- ---------------------------------------------------------------------------
-- 5. Caja: apertura, movimientos y cierre
-- ---------------------------------------------------------------------------

create or replace function public.open_cash_session(
  p_branch_id uuid,
  p_opening_float numeric default 0,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  new_id uuid := gen_random_uuid();
  session_number text;
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede abrir caja.';
  end if;

  if not exists (select 1 from public.staff_branch_ids() as allowed(id) where allowed.id = p_branch_id) then
    raise exception using errcode = '42501', message = 'No tienes permiso sobre esa sede.';
  end if;

  if exists (select 1 from public.cash_sessions where branch_id = p_branch_id and status = 'open') then
    raise exception using errcode = '23514',
      message = 'Ya hay una caja abierta en esta sede: ciérrala antes de abrir otra.';
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  session_number := 'CAJA-' || to_char(now(), 'YYYYMMDD') || '-' ||
    lpad((coalesce((select count(*) from public.cash_sessions where branch_id = p_branch_id), 0) + 1)::text, 3, '0');

  insert into public.cash_sessions (
    id, branch_id, session_number, opening_float, opened_by, opened_by_label, closing_note
  ) values (
    new_id, p_branch_id, session_number, coalesce(p_opening_float, 0), actor, actor_name, p_note
  );

  if coalesce(p_opening_float, 0) > 0 then
    insert into public.cash_movements (
      cash_session_id, branch_id, kind, method, amount,
      source_type, source_label, actor_id, actor_label, note
    ) values (
      new_id, p_branch_id, 'opening_float', 'cash', p_opening_float,
      'cash_session', session_number, actor, actor_name, 'Fondo de apertura'
    );
  end if;

  return public.cash_session_detail(new_id);
end;
$$;

-- Registra en caja una operación ya ocurrida. Se invoca desde los contratos de
-- venta, reembolso, pago a proveedor y gasto, y por eso acepta la fecha real de
-- entrada del dinero: el arqueo suma por cuándo ENTRÓ, no por cuándo se aplicó.
create or replace function public.record_cash_movement(
  p_branch_id uuid,
  p_kind public.cash_movement_kind,
  p_method public.payment_method,
  p_amount numeric,
  p_source_type text default null,
  p_source_id uuid default null,
  p_source_label text default null,
  p_note text default null,
  p_actor_id uuid default null
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  session public.cash_sessions%rowtype;
  actor uuid := coalesce(p_actor_id, auth.uid());
  actor_name text;
  movement_id bigint;
begin
  select * into session from public.cash_sessions
  where branch_id = p_branch_id and status = 'open';

  -- Sin caja abierta el movimiento no se pierde: simplemente no se registra en
  -- el cajón. Obligar a abrir caja para poder vender rompería la operación.
  if session.id is null then
    return null;
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  insert into public.cash_movements (
    cash_session_id, branch_id, kind, method, amount,
    source_type, source_id, source_label, actor_id, actor_label, note
  ) values (
    session.id, p_branch_id, p_kind, p_method, p_amount,
    p_source_type, p_source_id, p_source_label, actor, actor_name, p_note
  )
  returning id into movement_id;

  return movement_id;
end;
$$;

create or replace function public.close_cash_session(
  p_cash_session_id uuid,
  p_counted_cash numeric,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  session public.cash_sessions%rowtype;
  actor uuid := auth.uid();
  actor_name text;
  expected numeric(14, 2);
begin
  if not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo puede cerrar caja.';
  end if;

  -- Transición condicional: si otra sesión la cerró mientras tanto, esta no
  -- encuentra fila y aborta sin escribir un arqueo duplicado.
  select * into session from public.cash_sessions
  where id = p_cash_session_id and status = 'open'
  for update;

  if session.id is null then
    raise exception using errcode = '23514', message = 'La caja ya no está abierta.';
  end if;

  if not exists (select 1 from public.staff_branch_ids() as allowed(id) where allowed.id = session.branch_id) then
    raise exception using errcode = '42501', message = 'No tienes permiso sobre esa sede.';
  end if;

  if p_counted_cash is null or p_counted_cash < 0 then
    raise exception using errcode = '22023', message = 'Declara el efectivo contado para cerrar.';
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  -- SOLO EL EFECTIVO cuadra el cajón: nadie cuenta a mano los Yape al cerrar.
  select coalesce(sum(m.amount), 0) into expected
  from public.cash_movements m
  where m.cash_session_id = session.id and m.method = 'cash';

  update public.cash_sessions
  set status = 'closed',
      closed_at = now(),
      closed_by = actor,
      closed_by_label = actor_name,
      counted_cash = p_counted_cash,
      expected_cash = expected,
      difference = p_counted_cash - expected,
      closing_note = coalesce(p_note, closing_note)
  where id = p_cash_session_id;

  return public.cash_session_detail(p_cash_session_id);
end;
$$;

create or replace function public.cash_session_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'sessionNumber', s.session_number, 'branchId', s.branch_id,
    'status', s.status, 'openingFloat', s.opening_float,
    'openedAt', s.opened_at, 'openedByLabel', s.opened_by_label,
    'closedAt', s.closed_at, 'closedByLabel', s.closed_by_label,
    'countedCash', s.counted_cash, 'expectedCash', s.expected_cash,
    'difference', s.difference,
    -- Resumen por medio de pago: lo que el arqueo necesita ver de un vistazo.
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', t.method, 'total', t.total, 'movements', t.movements
      ) order by t.method)
      from (
        select m.method, sum(m.amount) as total, count(*) as movements
        from public.cash_movements m where m.cash_session_id = s.id
        group by m.method
      ) t
    ), '[]'::jsonb),
    'byKind', coalesce((
      select jsonb_agg(jsonb_build_object('kind', t.kind, 'total', t.total) order by t.kind)
      from (
        select m.kind, sum(m.amount) as total
        from public.cash_movements m where m.cash_session_id = s.id
        group by m.kind
      ) t
    ), '[]'::jsonb),
    'expectedCashNow', coalesce((
      select sum(m.amount) from public.cash_movements m
      where m.cash_session_id = s.id and m.method = 'cash'
    ), 0)
  )
  from public.cash_sessions s where s.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 6. Gastos
-- ---------------------------------------------------------------------------

create or replace function public.register_expense(
  p_branch_id uuid,
  p_expense_category_id uuid,
  p_method public.payment_method,
  p_amount numeric,
  p_description text,
  p_client_operation_id uuid,
  p_supplier_id uuid default null,
  p_payee_name text default null,
  p_incurred_at date default null,
  p_document jsonb default null,
  p_evidence_path text default null,
  p_recurrence public.expense_recurrence default 'one_off',
  p_allocations jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  existing public.expenses%rowtype;
  new_id uuid := gen_random_uuid();
  entry jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede registrar gastos.';
  end if;

  select * into existing from public.expenses
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.expense_detail(existing.id);
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  insert into public.expenses (
    id, branch_id, expense_category_id, supplier_id, payee_name, method, amount,
    incurred_at, document_kind, document_series, document_number, evidence_path,
    description, recurrence, created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_branch_id, p_expense_category_id, p_supplier_id,
    nullif(trim(coalesce(p_payee_name, '')), ''), p_method, p_amount,
    coalesce(p_incurred_at, current_date),
    nullif(p_document ->> 'kind', '')::public.tax_document_kind,
    nullif(p_document ->> 'series', ''), nullif(p_document ->> 'number', ''),
    p_evidence_path, p_description, p_recurrence, actor, actor_name, p_client_operation_id
  );

  for entry in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    insert into public.expense_allocations (
      expense_id, purchase_order_id, goods_receipt_id, sale_id, amount
    ) values (
      new_id,
      nullif(entry ->> 'purchaseOrderId', '')::uuid,
      nullif(entry ->> 'goodsReceiptId', '')::uuid,
      nullif(entry ->> 'saleId', '')::uuid,
      (entry ->> 'amount')::numeric
    );
  end loop;

  -- El gasto sale del cajón solo si se pagó en efectivo.
  perform public.record_cash_movement(
    p_branch_id, 'expense', p_method, -1 * p_amount,
    'expense', new_id, 'Gasto', p_description, actor
  );

  return public.expense_detail(new_id);
end;
$$;

create or replace function public.void_expense(p_expense_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expense public.expenses%rowtype;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede anular gastos.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Anular un gasto exige un motivo.';
  end if;

  -- Sin borrado físico: el gasto original se conserva marcado.
  update public.expenses
  set voided_at = now(), void_reason = p_reason, voided_by = auth.uid()
  where id = p_expense_id and voided_at is null
  returning * into expense;

  if expense.id is null then
    raise exception using errcode = '23514', message = 'El gasto no existe o ya estaba anulado.';
  end if;

  perform public.record_cash_movement(
    expense.branch_id, 'expense', expense.method, expense.amount,
    'expense_void', expense.id, 'Anulación de gasto', p_reason, auth.uid()
  );

  return public.expense_detail(p_expense_id);
end;
$$;

create or replace function public.expense_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', e.id, 'branchId', e.branch_id, 'category', c.name, 'categoryCode', c.code,
    'scope', c.scope, 'method', e.method, 'amount', e.amount, 'currency', e.currency,
    'incurredAt', e.incurred_at, 'description', e.description,
    'supplierId', e.supplier_id, 'payeeName', e.payee_name,
    'recurrence', e.recurrence, 'evidencePath', e.evidence_path,
    'voidedAt', e.voided_at, 'voidReason', e.void_reason,
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'purchaseOrderId', a.purchase_order_id,
        'goodsReceiptId', a.goods_receipt_id,
        'saleId', a.sale_id, 'amount', a.amount
      ))
      from public.expense_allocations a where a.expense_id = e.id
    ), '[]'::jsonb)
  )
  from public.expenses e
  join public.expense_categories c on c.id = e.expense_category_id
  where e.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 7. Traslados
-- ---------------------------------------------------------------------------
-- Las dos mitades se escriben en la MISMA transacción. Media transferencia es
-- inventario inventado o desaparecido.

create or replace function public.register_transfer(
  p_origin_branch_id uuid,
  p_destination_branch_id uuid,
  p_lines jsonb,
  p_client_operation_id uuid,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  existing public.inventory_transfers%rowtype;
  new_id uuid := gen_random_uuid();
  transfer_number text;
  entry jsonb;
  out_movement jsonb;
  ordered_lines jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede trasladar mercadería.';
  end if;

  if p_origin_branch_id = p_destination_branch_id then
    raise exception using errcode = '22023', message = 'El origen y el destino deben ser sedes distintas.';
  end if;

  select * into existing from public.inventory_transfers
  where origin_branch_id = p_origin_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.transfer_detail(existing.id);
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  transfer_number := 'TRA-' || to_char(now(), 'YYYY') || '-' ||
    lpad((coalesce((select count(*) from public.inventory_transfers), 0) + 1)::text, 5, '0');

  insert into public.inventory_transfers (
    id, transfer_number, status, origin_branch_id, destination_branch_id,
    dispatched_at, received_at, resolved_at, reason,
    requested_by, requested_by_label, client_operation_id
  ) values (
    new_id, transfer_number, 'received', p_origin_branch_id, p_destination_branch_id,
    now(), now(), now(), p_reason, actor, actor_name, p_client_operation_id
  );

  -- Orden estable por (variante, sede): ordenar solo por variante no es orden
  -- total con clave compuesta, y un traslado toca DOS filas del mismo variant_id.
  select jsonb_agg(l order by (l ->> 'variantId')) into ordered_lines
  from jsonb_array_elements(p_lines) l;

  for entry in select value from jsonb_array_elements(ordered_lines) loop
    -- Sale del origen. El movimiento devuelve el costo al que salió.
    out_movement := public.apply_inventory_movement(
      (entry ->> 'variantId')::uuid, p_origin_branch_id, 'transfer_out',
      -1 * (entry ->> 'units')::integer, null,
      'inventory_transfer', new_id, transfer_number, coalesce(p_reason, 'Traslado entre sedes'), actor
    );

    -- Y entra al destino AL MISMO COSTO: un traslado no crea ni destruye valor.
    perform public.apply_inventory_movement(
      (entry ->> 'variantId')::uuid, p_destination_branch_id, 'transfer_in',
      (entry ->> 'units')::integer,
      nullif(out_movement ->> 'unitCost', '')::numeric,
      'inventory_transfer', new_id, transfer_number, coalesce(p_reason, 'Traslado entre sedes'), actor
    );

    insert into public.inventory_transfer_lines (
      inventory_transfer_id, variant_id, sku, product_name, variant_name,
      requested_units, dispatched_units, received_units, unit_cost, cost_basis
    )
    select
      new_id, v.id, v.sku, p.name, v.name,
      (entry ->> 'units')::integer, (entry ->> 'units')::integer, (entry ->> 'units')::integer,
      nullif(out_movement ->> 'unitCost', '')::numeric,
      (out_movement ->> 'costBasis')::public.inventory_cost_basis
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (entry ->> 'variantId')::uuid;

    -- La variante debe seguirse también en el destino, o su existencia allí
    -- quedaría invisible para la disponibilidad efectiva.
    update public.product_variants
    set tracks_inventory = true
    where id = (entry ->> 'variantId')::uuid and not tracks_inventory;
  end loop;

  return public.transfer_detail(new_id);
end;
$$;

create or replace function public.transfer_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', t.id, 'transferNumber', t.transfer_number, 'status', t.status,
    'originBranchId', t.origin_branch_id, 'destinationBranchId', t.destination_branch_id,
    'requestedAt', t.requested_at, 'receivedAt', t.received_at, 'reason', t.reason,
    'discrepancyNote', t.discrepancy_note,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', l.variant_id, 'sku', l.sku, 'productName', l.product_name,
        'variantName', l.variant_name, 'requestedUnits', l.requested_units,
        'dispatchedUnits', l.dispatched_units, 'receivedUnits', l.received_units,
        'differenceUnits', coalesce(l.dispatched_units, 0) - coalesce(l.received_units, 0),
        'costBasis', l.cost_basis
      ) order by l.created_at)
      from public.inventory_transfer_lines l where l.inventory_transfer_id = t.id
    ), '[]'::jsonb)
  )
  from public.inventory_transfers t where t.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 8. Lote de carga inicial con reversión controlada
-- ---------------------------------------------------------------------------

create or replace function public.commit_initial_load_batch(
  p_branch_id uuid,
  p_rows jsonb,
  p_client_operation_id uuid,
  p_counted_at date default null,
  p_notes text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := coalesce(p_actor_id, auth.uid());
  actor_name text;
  existing public.initial_load_batches%rowtype;
  new_id uuid := gen_random_uuid();
  batch_number text;
  preview jsonb;
  entry jsonb;
  movement jsonb;
  units integer := 0;
  valued integer := 0;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede cargar la existencia inicial.';
  end if;

  if actor is null then
    raise exception using errcode = '22023',
      message = 'La carga inicial exige un actor explícito cuando no hay sesión.';
  end if;

  select * into existing from public.initial_load_batches
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.initial_load_batch_detail(existing.id);
  end if;

  -- Se reutiliza la validación de 0028 en modo previsualización: SKU
  -- inexistente, duplicado, cantidad negativa o seguimiento ya activo.
  preview := public.load_initial_inventory(p_rows, 'preview', actor);

  if (preview ->> 'rejected')::integer > 0 then
    raise exception using errcode = '22023',
      message = format('El lote tiene %s fila(s) con problemas: %s',
                       preview ->> 'rejected', preview -> 'issues');
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  batch_number := 'INV-' || to_char(coalesce(p_counted_at, current_date), 'YYYYMMDD') || '-' ||
    lpad((coalesce((select count(*) from public.initial_load_batches), 0) + 1)::text, 3, '0');

  insert into public.initial_load_batches (
    id, branch_id, batch_number, counted_at, notes,
    created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_branch_id, batch_number, coalesce(p_counted_at, current_date), p_notes,
    actor, actor_name, p_client_operation_id
  );

  for entry in select value from jsonb_array_elements(preview -> 'rows') loop
    if (entry ->> 'quantity')::integer > 0 then
      movement := public.apply_inventory_movement(
        (entry ->> 'variantId')::uuid, (entry ->> 'branchId')::uuid, 'initial_load',
        (entry ->> 'quantity')::integer,
        nullif(entry ->> 'unitCost', '')::numeric,
        'initial_load_batch', new_id, batch_number, 'Toma física inicial', actor
      );
    end if;

    insert into public.initial_load_rows (
      initial_load_batch_id, variant_id, sku, quantity, unit_cost, inventory_movement_id
    ) values (
      new_id, (entry ->> 'variantId')::uuid, entry ->> 'sku',
      (entry ->> 'quantity')::integer,
      nullif(entry ->> 'unitCost', '')::numeric,
      nullif(movement ->> 'movementId', '')::bigint
    );

    update public.product_variants
    set tracks_inventory = true
    where id = (entry ->> 'variantId')::uuid and not tracks_inventory;

    units := units + (entry ->> 'quantity')::integer;
    if (entry ->> 'unitCost') is not null then
      valued := valued + (entry ->> 'quantity')::integer;
    end if;
  end loop;

  update public.initial_load_batches
  set row_count = jsonb_array_length(preview -> 'rows'), total_units = units, valued_units = valued
  where id = new_id;

  return public.initial_load_batch_detail(new_id);
end;
$$;

-- Deshacer una carga es legítimo mientras nadie haya operado encima. Después
-- deja de serlo: revertirla reescribiría un promedio ya usado para vender.
create or replace function public.revert_initial_load_batch(
  p_batch_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  batch public.initial_load_batches%rowtype;
  row_record public.initial_load_rows%rowtype;
  blocking integer;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede revertir una carga inicial.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Revertir una carga exige un motivo.';
  end if;

  select * into batch from public.initial_load_batches
  where id = p_batch_id and status = 'committed'
  for update;

  if batch.id is null then
    raise exception using errcode = '23514', message = 'El lote no existe o ya fue revertido.';
  end if;

  -- Si hay CUALQUIER movimiento posterior sobre esas variantes en esa sede, la
  -- reversión dejaría de ser una corrección para convertirse en una mentira.
  select count(*) into blocking
  from public.inventory_movements m
  join public.initial_load_rows r
    on r.variant_id = m.variant_id and r.initial_load_batch_id = batch.id
  where m.branch_id = batch.branch_id
    and m.id > coalesce(r.inventory_movement_id, 0);

  if blocking > 0 then
    raise exception using errcode = '23514',
      message = format('No se puede revertir: ya hay %s movimiento(s) posteriores sobre esas presentaciones.', blocking);
  end if;

  for row_record in
    select * from public.initial_load_rows
    where initial_load_batch_id = batch.id order by variant_id
  loop
    if row_record.quantity > 0 then
      perform public.apply_inventory_movement(
        row_record.variant_id, batch.branch_id, 'adjustment',
        -1 * row_record.quantity, null,
        'initial_load_revert', batch.id, batch.batch_number,
        'Reversión de carga inicial: ' || p_reason, auth.uid()
      );
    end if;

    -- Vuelve a quedar sin seguimiento: nunca llegó a tener existencia válida.
    update public.product_variants
    set tracks_inventory = false
    where id = row_record.variant_id;
  end loop;

  update public.initial_load_batches
  set status = 'reverted', reverted_at = now(), revert_reason = p_reason
  where id = batch.id;

  return public.initial_load_batch_detail(batch.id);
end;
$$;

create or replace function public.initial_load_batch_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', b.id, 'batchNumber', b.batch_number, 'branchId', b.branch_id,
    'status', b.status, 'countedAt', b.counted_at,
    'rowCount', b.row_count, 'totalUnits', b.total_units, 'valuedUnits', b.valued_units,
    'unvaluedUnits', b.total_units - b.valued_units,
    'createdAt', b.created_at, 'createdByLabel', b.created_by_label,
    'revertedAt', b.reverted_at, 'revertReason', b.revert_reason,
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', r.variant_id, 'sku', r.sku,
        'quantity', r.quantity, 'unitCost', r.unit_cost
      ) order by r.sku)
      from public.initial_load_rows r where r.initial_load_batch_id = b.id
    ), '[]'::jsonb)
  )
  from public.initial_load_batches b where b.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 9. Consultas operativas
-- ---------------------------------------------------------------------------

-- Alertas de bajo stock. El umbral es por variante y sede, con un valor por
-- defecto conservador mientras no exista configuración fina.
create or replace view public.low_stock_alerts
with (security_invoker = true)
as
select
  s.variant_id,
  s.branch_id,
  b.name as branch_name,
  v.sku,
  p.name as product_name,
  v.name as variant_name,
  s.on_hand,
  s.reserved,
  s.available_quantity
from public.inventory_stock s
join public.product_variants v on v.id = s.variant_id and v.tracks_inventory
join public.products p on p.id = v.product_id
join public.branches b on b.id = s.branch_id and b.is_active
where s.available_quantity <= 5;

-- Margen por venta, con el costo desconocido señalado en vez de escondido.
create or replace view public.sale_margins
with (security_invoker = true)
as
select
  s.id as sale_id,
  s.sale_number,
  s.branch_id,
  s.issued_at,
  s.total as revenue,
  sum(c.total_cost) as cost,
  case
    when bool_or(c.cost_basis = 'unknown') then null
    else s.total - sum(c.total_cost)
  end as margin,
  bool_or(c.cost_basis = 'unknown') as has_unknown_cost,
  bool_or(c.cost_basis = 'mixed') as has_mixed_cost
from public.sales s
join public.sale_lines l on l.sale_id = s.id
join public.sale_line_costs c on c.sale_line_id = l.id
where s.status = 'confirmed'
group by s.id, s.sale_number, s.branch_id, s.issued_at, s.total;

comment on view public.sale_margins is
  'Margen por venta. Cuando alguna línea tiene costo desconocido el margen es '
  'NULL y no cero: un margen no calculable no es un margen del 100 %.';


-- ---------------------------------------------------------------------------
-- 10. RLS
-- ---------------------------------------------------------------------------

alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_allocations enable row level security;
alter table public.cash_sessions enable row level security;
alter table public.cash_movements enable row level security;
alter table public.inventory_transfers enable row level security;
alter table public.inventory_transfer_lines enable row level security;
alter table public.initial_load_batches enable row level security;
alter table public.initial_load_rows enable row level security;

-- Las categorías son diccionario: el personal las lee para elegir.
create policy "staff read expense categories"
on public.expense_categories for select to authenticated
using (public.is_staff());

create policy "admins manage expense categories"
on public.expense_categories for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Los gastos son dinero de la empresa: solo administración.
create policy "admins manage expenses"
on public.expenses for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage expense allocations"
on public.expense_allocations for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- La caja SÍ la opera la vendedora: es su cajón.
create policy "staff manage cash sessions of their branches"
on public.cash_sessions for all to authenticated
using (branch_id in (select public.staff_branch_ids()))
with check (branch_id in (select public.staff_branch_ids()));

-- Historial inmutable: se lee, nunca se edita ni se borra.
create policy "staff read cash movements of their branches"
on public.cash_movements for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

-- Los traslados mueven inventario entre sedes: administración.
create policy "admins manage transfers"
on public.inventory_transfers for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage transfer lines"
on public.inventory_transfer_lines for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage initial load batches"
on public.initial_load_batches for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage initial load rows"
on public.initial_load_rows for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 11. Privilegios
-- ---------------------------------------------------------------------------

grant select on public.expense_categories to authenticated;
grant select, insert, update on public.expense_categories to authenticated, service_role;
grant select, insert, update on public.expenses to authenticated, service_role;
grant select, insert on public.expense_allocations to authenticated, service_role;
grant select, insert, update on public.cash_sessions to authenticated, service_role;
grant select, insert on public.cash_movements to authenticated, service_role;
grant select, insert, update on public.inventory_transfers to authenticated, service_role;
grant select, insert, update on public.inventory_transfer_lines to authenticated, service_role;
grant select, insert, update on public.initial_load_batches to authenticated, service_role;
grant select, insert on public.initial_load_rows to authenticated, service_role;
grant select on public.low_stock_alerts to authenticated;
grant select on public.sale_margins to authenticated;

revoke truncate on public.expense_categories, public.expenses, public.expense_allocations,
  public.cash_sessions, public.cash_movements, public.inventory_transfers,
  public.inventory_transfer_lines, public.initial_load_batches, public.initial_load_rows
from anon, authenticated, service_role;

revoke all on function public.open_cash_session(uuid, numeric, text) from public, anon;
revoke all on function public.close_cash_session(uuid, numeric, text) from public, anon;
revoke all on function public.record_cash_movement(uuid, public.cash_movement_kind, public.payment_method, numeric, text, uuid, text, text, uuid) from public, anon;
revoke all on function public.cash_session_detail(uuid) from public, anon;
revoke all on function public.register_expense(uuid, uuid, public.payment_method, numeric, text, uuid, uuid, text, date, jsonb, text, public.expense_recurrence, jsonb) from public, anon;
revoke all on function public.void_expense(uuid, text) from public, anon;
revoke all on function public.expense_detail(uuid) from public, anon;
revoke all on function public.register_transfer(uuid, uuid, jsonb, uuid, text) from public, anon;
revoke all on function public.transfer_detail(uuid) from public, anon;
revoke all on function public.commit_initial_load_batch(uuid, jsonb, uuid, date, text, uuid) from public, anon;
revoke all on function public.revert_initial_load_batch(uuid, text) from public, anon;
revoke all on function public.initial_load_batch_detail(uuid) from public, anon;

grant execute on function public.open_cash_session(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.close_cash_session(uuid, numeric, text) to authenticated, service_role;
grant execute on function public.record_cash_movement(uuid, public.cash_movement_kind, public.payment_method, numeric, text, uuid, text, text, uuid) to authenticated, service_role;
grant execute on function public.cash_session_detail(uuid) to authenticated, service_role;
grant execute on function public.register_expense(uuid, uuid, public.payment_method, numeric, text, uuid, uuid, text, date, jsonb, text, public.expense_recurrence, jsonb) to authenticated, service_role;
grant execute on function public.void_expense(uuid, text) to authenticated, service_role;
grant execute on function public.expense_detail(uuid) to authenticated, service_role;
grant execute on function public.register_transfer(uuid, uuid, jsonb, uuid, text) to authenticated, service_role;
grant execute on function public.transfer_detail(uuid) to authenticated, service_role;
grant execute on function public.commit_initial_load_batch(uuid, jsonb, uuid, date, text, uuid) to authenticated, service_role;
grant execute on function public.revert_initial_load_batch(uuid, text) to authenticated, service_role;
grant execute on function public.initial_load_batch_detail(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Auditoría
-- ---------------------------------------------------------------------------
-- cash_movements queda fuera: ya es un libro de solo adición por diseño, igual
-- que inventory_movements.

select public.attach_audit('public.expense_categories');
select public.attach_audit('public.expenses');
select public.attach_audit('public.expense_allocations');
select public.attach_audit('public.cash_sessions');
select public.attach_audit('public.inventory_transfers');
select public.attach_audit('public.inventory_transfer_lines');
select public.attach_audit('public.initial_load_batches');
select public.attach_audit('public.initial_load_rows');

commit;
