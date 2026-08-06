-- Bloque 2 · Migración 3 de 5 — Compras, recepciones y cuentas con proveedores.
--
-- Ver docs/bloque-2-modelo.md §5 y las correcciones de su anexo.
--
-- REGLAS QUE IMPONE ESTA MIGRACIÓN:
--   La orden de compra NO incrementa inventario. Solo la recepción confirmada.
--   El costo incorporado sale de la RECEPCIÓN real, no de la cotización.
--   Una recepción confirmada no se edita: toda corrección es un movimiento
--   compensatorio.
--   El pago al proveedor no altera el costo histórico ya incorporado.
--   La deuda se DERIVA de documentos y pagos, nunca de un campo manual.
--
-- MONEDA FUNCIONAL: la valoración del inventario vive en soles. Una recepción
-- en dólares se convierte con el tipo de cambio del documento, y ese tipo queda
-- congelado en la línea. Sin eso, un promedio en USD competiría contra una venta
-- en PEN y el margen sería falso.

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.purchase_order_status as enum (
  'draft', 'sent', 'partially_received', 'received', 'cancelled'
);

create type public.purchase_terms as enum ('cash', 'credit');

create type public.goods_receipt_status as enum ('draft', 'confirmed', 'cancelled');

-- Cómo entra al inventario una unidad bonificada.
--   same_variant  el regalo es del mismo artículo: baja el costo efectivo, que
--                 es la distribución económica correcta y automática.
--   unvalued      el regalo es de OTRO artículo y no se declaró su valor: entra
--                 al fondo SIN VALORAR de 0028. No a costo cero, que fabricaría
--                 un promedio falso para esa otra variante.
--   declared      el regalo es de otro artículo y se declaró su valor unitario.
create type public.bonus_valuation as enum ('same_variant', 'unvalued', 'declared');

create type public.supplier_obligation_status as enum ('open', 'partially_paid', 'settled', 'void');

-- ---------------------------------------------------------------------------
-- 1. Orden de compra
-- ---------------------------------------------------------------------------

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  supplier_contact_id uuid references public.supplier_contacts(id) on delete set null,
  -- Sede de DESTINO: es donde entrará la mercadería.
  branch_id uuid not null references public.branches(id) on delete restrict,
  order_number text not null,
  status public.purchase_order_status not null default 'draft',
  terms public.purchase_terms not null default 'cash',
  payment_terms_days integer not null default 0,
  currency char(3) not null default 'PEN',
  -- Tipo de cambio de referencia al emitir. El que manda para el costo es el de
  -- la recepción, pero este permite comparar lo presupuestado con lo real.
  reference_exchange_rate numeric(12, 6),
  expected_at date,
  gross_total numeric(14, 4) not null default 0,
  discount_total numeric(14, 4) not null default 0,
  total numeric(14, 4) not null default 0,
  notes text,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  cancelled_at timestamptz,
  cancel_reason text,
  constraint purchase_orders_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint purchase_orders_amounts_non_negative check (
    gross_total >= 0 and discount_total >= 0 and total >= 0
  ),
  constraint purchase_orders_total_consistent check (total = gross_total - discount_total),
  constraint purchase_orders_terms_days check (payment_terms_days >= 0),
  constraint purchase_orders_rate_positive check (reference_exchange_rate is null or reference_exchange_rate > 0),
  constraint purchase_orders_number_unique unique (branch_id, order_number),
  constraint purchase_orders_operation_unique unique (branch_id, client_operation_id)
);

comment on table public.purchase_orders is
  'Orden de compra. NO incrementa inventario: solo la recepción confirmada lo hace.';

create index purchase_orders_supplier_idx on public.purchase_orders(supplier_id, created_at desc);
create index purchase_orders_status_idx on public.purchase_orders(status, expected_at);
create index purchase_orders_branch_idx on public.purchase_orders(branch_id, created_at desc);

create trigger purchase_orders_set_updated_at
before update on public.purchase_orders
for each row execute function public.set_updated_at();

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id) on delete restrict,
  -- La oferta resuelta y CONGELADA. Si la línea volviera a resolver el costo,
  -- el histórico de la compra cambiaría el día que alguien registre un acuerdo
  -- nuevo. Es la advertencia que dejó la Vertical 2.
  product_supplier_id uuid references public.product_suppliers(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text,
  product_name text,
  variant_name text,
  supplier_sku text,
  purchase_unit_label text,
  -- Unidades vendibles por unidad de compra, fotografiadas al emitir.
  pack_units integer not null default 1,
  ordered_units integer not null,
  unit_cost numeric(16, 6) not null,
  discount_amount numeric(14, 4) not null default 0,
  subtotal numeric(14, 4) not null,
  notes text,
  created_at timestamptz not null default now(),
  constraint purchase_order_lines_pack_positive check (pack_units > 0),
  constraint purchase_order_lines_ordered_positive check (ordered_units > 0),
  constraint purchase_order_lines_cost_non_negative check (unit_cost >= 0),
  constraint purchase_order_lines_discount_non_negative check (discount_amount >= 0),
  constraint purchase_order_lines_subtotal_consistent check (
    subtotal = (ordered_units * unit_cost) - discount_amount and subtotal >= 0
  )
);

create index purchase_order_lines_order_idx on public.purchase_order_lines(purchase_order_id);
create index purchase_order_lines_variant_idx on public.purchase_order_lines(variant_id);

-- ---------------------------------------------------------------------------
-- 2. Documentos del proveedor
-- ---------------------------------------------------------------------------

create table public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  kind public.tax_document_kind not null default 'invoice',
  series text,
  number text,
  issued_at date not null,
  due_date date,
  currency char(3) not null default 'PEN',
  exchange_rate numeric(12, 6),
  total numeric(14, 4) not null,
  file_path text,
  notes text,
  created_at timestamptz not null default now(),
  constraint supplier_documents_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint supplier_documents_total_positive check (total > 0),
  constraint supplier_documents_rate_positive check (exchange_rate is null or exchange_rate > 0),
  constraint supplier_documents_due_after_issue check (due_date is null or due_date >= issued_at),
  constraint supplier_documents_identity_unique unique (supplier_id, kind, series, number)
);

create index supplier_documents_supplier_idx on public.supplier_documents(supplier_id, issued_at desc);

-- ---------------------------------------------------------------------------
-- 3. Recepción
-- ---------------------------------------------------------------------------

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  -- OPCIONAL: existe la compra directa sin orden previa.
  purchase_order_id uuid references public.purchase_orders(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  supplier_document_id uuid references public.supplier_documents(id) on delete restrict,
  receipt_number text not null,
  status public.goods_receipt_status not null default 'draft',
  currency char(3) not null default 'PEN',
  -- El tipo de cambio de ESTA recepción. Es el que determina el costo en soles
  -- que entra al inventario, y queda congelado.
  exchange_rate numeric(12, 6),
  received_at timestamptz not null default now(),
  goods_total_pen numeric(16, 6) not null default 0,
  discrepancy_note text,
  notes text,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint goods_receipts_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint goods_receipts_rate_positive check (exchange_rate is null or exchange_rate > 0),
  -- Una recepción en moneda extranjera EXIGE su tipo de cambio: sin él el costo
  -- en soles sería indeterminado.
  constraint goods_receipts_foreign_needs_rate check (currency = 'PEN' or exchange_rate is not null),
  constraint goods_receipts_total_non_negative check (goods_total_pen >= 0),
  constraint goods_receipts_number_unique unique (branch_id, receipt_number),
  constraint goods_receipts_operation_unique unique (branch_id, client_operation_id)
);

comment on table public.goods_receipts is
  'Recepción de mercadería. Es el ÚNICO origen que aumenta existencias por '
  'compra, y solo al confirmarse. Una vez confirmada no se edita.';

create index goods_receipts_supplier_idx on public.goods_receipts(supplier_id, received_at desc);
create index goods_receipts_order_idx on public.goods_receipts(purchase_order_id);
create index goods_receipts_branch_idx on public.goods_receipts(branch_id, received_at desc);

create trigger goods_receipts_set_updated_at
before update on public.goods_receipts
for each row execute function public.set_updated_at();

create table public.goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete restrict,
  purchase_order_line_id uuid references public.purchase_order_lines(id) on delete restrict,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text,
  product_name text,
  variant_name text,
  pack_units integer not null default 1,
  -- Esperado según la orden. Nulo en compra directa.
  expected_units integer,
  -- Unidades VENDIBLES efectivamente recibidas en condición vendible.
  received_units integer not null default 0,
  -- Unidades bonificadas: llegan físicamente y no se pagan.
  bonus_units integer not null default 0,
  bonus_valuation public.bonus_valuation not null default 'same_variant',
  bonus_declared_unit_cost numeric(16, 6),
  -- Dañadas: llegan pero NO entran a disponibilidad vendible.
  damaged_units integer not null default 0,
  -- Costo unitario en la moneda del documento, y su conversión a soles.
  unit_cost numeric(16, 6) not null default 0,
  unit_cost_pen numeric(16, 6) not null default 0,
  discount_amount numeric(14, 4) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  constraint goods_receipt_lines_pack_positive check (pack_units > 0),
  constraint goods_receipt_lines_units_non_negative check (
    received_units >= 0 and bonus_units >= 0 and damaged_units >= 0
    and (expected_units is null or expected_units >= 0)
  ),
  constraint goods_receipt_lines_something_arrived check (
    received_units + bonus_units + damaged_units > 0
  ),
  constraint goods_receipt_lines_costs_non_negative check (
    unit_cost >= 0 and unit_cost_pen >= 0 and discount_amount >= 0
    and (bonus_declared_unit_cost is null or bonus_declared_unit_cost >= 0)
  ),
  -- La valoración declarada exige un importe; las otras dos lo prohíben.
  constraint goods_receipt_lines_bonus_declared_consistent check (
    (bonus_valuation = 'declared') = (bonus_declared_unit_cost is not null)
  ),
  constraint goods_receipt_lines_bonus_needs_units check (
    bonus_valuation = 'same_variant' or bonus_units > 0
  )
);

comment on column public.goods_receipt_lines.bonus_valuation is
  'same_variant: el regalo baja el costo efectivo del propio artículo. '
  'unvalued: regalo de otro artículo sin valor declarado, entra al fondo sin '
  'valorar de 0028 en lugar de a costo cero. declared: con valor explícito.';

create index goods_receipt_lines_receipt_idx on public.goods_receipt_lines(goods_receipt_id);
create index goods_receipt_lines_variant_idx on public.goods_receipt_lines(variant_id);
create index goods_receipt_lines_order_line_idx on public.goods_receipt_lines(purchase_order_line_id);

-- ---------------------------------------------------------------------------
-- 4. Obligaciones y pagos
-- ---------------------------------------------------------------------------
-- La deuda NO es un campo: se deriva de obligaciones menos asignaciones. Una
-- vista «recibido menos pagado» no sobrevive a adelantos, varias recepciones,
-- pagos que cubren varias compras y monedas distintas.

create table public.supplier_obligations (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  goods_receipt_id uuid references public.goods_receipts(id) on delete restrict,
  supplier_document_id uuid references public.supplier_documents(id) on delete restrict,
  currency char(3) not null default 'PEN',
  amount_due numeric(14, 4) not null,
  due_date date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text,
  constraint supplier_obligations_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint supplier_obligations_amount_positive check (amount_due > 0),
  -- Exactamente un origen, el patrón de wholesale_rules.
  constraint supplier_obligations_exactly_one_origin check (
    num_nonnulls(goods_receipt_id, supplier_document_id) = 1
  )
);

create index supplier_obligations_supplier_idx
on public.supplier_obligations(supplier_id, currency, due_date);

create trigger supplier_obligations_set_updated_at
before update on public.supplier_obligations
for each row execute function public.set_updated_at();

create table public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  branch_id uuid not null references public.branches(id) on delete restrict,
  -- Mismo enumerado que la caja: sin método el arqueo no puede restar una
  -- transferencia de un pago en efectivo del cajón.
  method public.payment_method not null,
  amount numeric(14, 4) not null,
  currency char(3) not null default 'PEN',
  exchange_rate numeric(12, 6),
  reference text,
  evidence_path text,
  paid_at timestamptz not null default now(),
  notes text,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  constraint supplier_payments_amount_positive check (amount > 0),
  constraint supplier_payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint supplier_payments_rate_positive check (exchange_rate is null or exchange_rate > 0),
  constraint supplier_payments_operation_unique unique (branch_id, client_operation_id)
);

create index supplier_payments_supplier_idx on public.supplier_payments(supplier_id, paid_at desc);
create index supplier_payments_branch_idx on public.supplier_payments(branch_id, paid_at desc);

create table public.supplier_payment_allocations (
  id uuid primary key default gen_random_uuid(),
  supplier_payment_id uuid not null references public.supplier_payments(id) on delete restrict,
  supplier_obligation_id uuid not null references public.supplier_obligations(id) on delete restrict,
  amount numeric(14, 4) not null,
  created_at timestamptz not null default now(),
  constraint supplier_payment_allocations_amount_positive check (amount > 0),
  constraint supplier_payment_allocations_unique unique (supplier_payment_id, supplier_obligation_id)
);

create index supplier_payment_allocations_obligation_idx
on public.supplier_payment_allocations(supplier_obligation_id);

-- Un pago no puede repartir más de lo que se desembolsó, ni una obligación
-- recibir más de lo que debe. Sin estos topes se asignarían 1.600 habiendo
-- pagado 1.000 y desaparecerían 600 de deuda sin que saliera dinero.
create or replace function public.assert_supplier_allocation_limits()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  payment public.supplier_payments%rowtype;
  obligation public.supplier_obligations%rowtype;
  allocated numeric(14, 4);
begin
  select * into payment from public.supplier_payments
  where id = coalesce(new.supplier_payment_id, old.supplier_payment_id);

  select * into obligation from public.supplier_obligations
  where id = coalesce(new.supplier_obligation_id, old.supplier_obligation_id);

  if payment.id is null or obligation.id is null then
    return null;
  end if;

  -- La moneda no se mezcla: un pago en soles no cancela una obligación en
  -- dólares sin una conversión explícita, que este modelo no hace por su cuenta.
  if payment.currency <> obligation.currency then
    raise exception using
      errcode = '22023',
      message = format('El pago está en %s y la obligación en %s: no se compensan sin conversión explícita.',
                       payment.currency, obligation.currency);
  end if;

  select coalesce(sum(a.amount), 0) into allocated
  from public.supplier_payment_allocations a
  where a.supplier_payment_id = payment.id;

  if allocated > payment.amount then
    raise exception using
      errcode = '23514',
      message = format('Las asignaciones (%s) superan el importe del pago (%s).', allocated, payment.amount);
  end if;

  select coalesce(sum(a.amount), 0) into allocated
  from public.supplier_payment_allocations a
  where a.supplier_obligation_id = obligation.id;

  if allocated > obligation.amount_due then
    raise exception using
      errcode = '23514',
      message = format('Lo asignado a la obligación (%s) supera lo exigible (%s).', allocated, obligation.amount_due);
  end if;

  return null;
end;
$$;

revoke all on function public.assert_supplier_allocation_limits() from public;

create constraint trigger supplier_payment_allocations_within_limits
after insert or update on public.supplier_payment_allocations
deferrable initially deferred
for each row execute function public.assert_supplier_allocation_limits();

-- La deuda, derivada y POR MONEDA. No se suman soles y dólares.
create or replace view public.supplier_balances
with (security_invoker = true)
as
select
  o.supplier_id,
  s.trade_name as supplier_name,
  o.currency,
  sum(o.amount_due) as total_due,
  sum(coalesce(paid.allocated, 0)) as total_paid,
  sum(o.amount_due - coalesce(paid.allocated, 0)) as balance,
  min(o.due_date) filter (where o.amount_due > coalesce(paid.allocated, 0)) as next_due_date
from public.supplier_obligations o
join public.suppliers s on s.id = o.supplier_id
left join lateral (
  select sum(a.amount) as allocated
  from public.supplier_payment_allocations a
  where a.supplier_obligation_id = o.id
) paid on true
where o.voided_at is null
group by o.supplier_id, s.trade_name, o.currency;

comment on view public.supplier_balances is
  'Deuda por proveedor y MONEDA. Derivada de obligaciones y asignaciones, nunca '
  'de un campo manual. No suma PEN con USD.';

-- Un pago sin asignar es un anticipo o crédito a favor del negocio.
create or replace view public.supplier_unallocated_payments
with (security_invoker = true)
as
select
  p.id as supplier_payment_id,
  p.supplier_id,
  p.currency,
  p.amount,
  coalesce(sum(a.amount), 0) as allocated,
  p.amount - coalesce(sum(a.amount), 0) as unallocated,
  p.paid_at
from public.supplier_payments p
left join public.supplier_payment_allocations a on a.supplier_payment_id = p.id
group by p.id, p.supplier_id, p.currency, p.amount, p.paid_at
having p.amount - coalesce(sum(a.amount), 0) > 0;


-- ---------------------------------------------------------------------------
-- 5. Emitir una orden de compra
-- ---------------------------------------------------------------------------
-- El costo se CONGELA aquí. Si la línea volviera a resolverlo, el histórico de
-- la compra cambiaría el día que alguien registre un acuerdo nuevo.

create or replace function public.issue_purchase_order(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_lines jsonb,
  p_client_operation_id uuid,
  p_currency char(3) default null,
  p_terms public.purchase_terms default 'cash',
  p_payment_terms_days integer default null,
  p_expected_at date default null,
  p_notes text default null
)
returns jsonb
language plpgsql
-- SECURITY DEFINER con guarda explícita `is_admin()`, por la misma razón que los
-- RPC de caja en 0029: el punto único de escritura de inventario dejó de ser
-- alcanzable por `authenticated` y solo se llega a él desde un contrato de
-- dominio. Sin esto, `register_goods_receipt` aborta con «permission denied for
-- function apply_inventory_movement» en cuanto lo invoca PostgREST —comprobado
-- contra la base local—, y ninguna recepción entraría al sistema.
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  supplier public.suppliers%rowtype;
  existing public.purchase_orders%rowtype;
  new_id uuid := gen_random_uuid();
  order_number text;
  entry jsonb;
  offer public.product_suppliers%rowtype;
  resolved_cost numeric(16, 6);
  gross numeric(14, 4) := 0;
  discounts numeric(14, 4) := 0;
  line_subtotal numeric(14, 4);
  currency char(3);
begin
  -- Las compras son dominio administrativo: la vendedora no las ve.
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede emitir órdenes de compra.';
  end if;

  select * into existing from public.purchase_orders
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.purchase_order_detail(existing.id);
  end if;

  select * into supplier from public.suppliers where id = p_supplier_id;

  if supplier.id is null then
    raise exception using errcode = '22023', message = 'El proveedor no existe.';
  end if;

  if supplier.status <> 'active' then
    raise exception using errcode = '23514',
      message = format('El proveedor %s no está habilitado para comprar.', supplier.trade_name);
  end if;

  currency := coalesce(p_currency, supplier.default_currency);

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  order_number := 'OC-' || to_char(now(), 'YYYY') || '-' ||
    lpad((coalesce((select count(*) from public.purchase_orders where branch_id = p_branch_id), 0) + 1)::text, 5, '0');

  insert into public.purchase_orders (
    id, supplier_id, branch_id, order_number, status, terms, payment_terms_days,
    currency, expected_at, notes, created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_supplier_id, p_branch_id, order_number, 'sent', p_terms,
    coalesce(p_payment_terms_days, supplier.payment_terms_days),
    currency, p_expected_at, p_notes, actor, actor_name, p_client_operation_id
  );

  for entry in select value from jsonb_array_elements(p_lines) loop
    select * into offer from public.product_suppliers
    where supplier_id = p_supplier_id
      and variant_id = (entry ->> 'variantId')::uuid
      and is_active
    order by is_preferred desc, priority desc
    limit 1;

    -- Cotización: si no se declara un costo, se toma el acuerdo vigente.
    resolved_cost := nullif(entry ->> 'unitCost', '')::numeric;

    if resolved_cost is null and offer.id is not null then
      select t.unit_cost into resolved_cost
      from public.supplier_cost_agreements a
      join public.supplier_cost_tiers t on t.supplier_cost_agreement_id = a.id
      where a.product_supplier_id = offer.id
        and a.is_active
        and a.validity @> now()
        and t.quantity_range @> (entry ->> 'orderedUnits')::integer
      limit 1;
    end if;

    if resolved_cost is null then
      raise exception using errcode = '22023',
        message = format('No hay costo vigente ni declarado para %s.', entry ->> 'variantId');
    end if;

    line_subtotal := ((entry ->> 'orderedUnits')::integer * resolved_cost)
                     - coalesce(nullif(entry ->> 'discountAmount', '')::numeric, 0);

    insert into public.purchase_order_lines (
      purchase_order_id, product_supplier_id, variant_id, sku, product_name, variant_name,
      supplier_sku, purchase_unit_label, pack_units, ordered_units, unit_cost,
      discount_amount, subtotal, notes
    )
    select
      new_id, offer.id, v.id, v.sku, p.name, v.name,
      offer.supplier_sku, coalesce(offer.purchase_unit_label, 'unidad'),
      coalesce(offer.pack_units, 1), (entry ->> 'orderedUnits')::integer, resolved_cost,
      coalesce(nullif(entry ->> 'discountAmount', '')::numeric, 0), line_subtotal,
      nullif(entry ->> 'notes', '')
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (entry ->> 'variantId')::uuid;

    gross := gross + ((entry ->> 'orderedUnits')::integer * resolved_cost);
    discounts := discounts + coalesce(nullif(entry ->> 'discountAmount', '')::numeric, 0);
  end loop;

  update public.purchase_orders
  set gross_total = gross, discount_total = discounts, total = gross - discounts
  where id = new_id;

  return public.purchase_order_detail(new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Registrar una recepción
-- ---------------------------------------------------------------------------
-- ES EL ÚNICO ORIGEN QUE AUMENTA EXISTENCIAS POR COMPRA, y solo al confirmarse.

create or replace function public.register_goods_receipt(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_lines jsonb,
  p_client_operation_id uuid,
  p_purchase_order_id uuid default null,
  p_currency char(3) default 'PEN',
  p_exchange_rate numeric default null,
  p_supplier_document jsonb default null,
  p_terms public.purchase_terms default 'cash',
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
  existing public.goods_receipts%rowtype;
  new_id uuid := gen_random_uuid();
  receipt_number text;
  entry jsonb;
  rate numeric(12, 6);
  cost_pen numeric(16, 6);
  received integer;
  bonus integer;
  damaged integer;
  effective_units integer;
  effective_cost numeric(16, 6);
  line_value numeric(16, 6);
  goods_total numeric(16, 6) := 0;
  document_id uuid;
  ordered_total integer;
  received_total integer;
  ordered_lines jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede registrar recepciones.';
  end if;

  select * into existing from public.goods_receipts
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.goods_receipt_detail(existing.id);
  end if;

  rate := case when p_currency = 'PEN' then 1 else p_exchange_rate end;

  if rate is null then
    raise exception using errcode = '22023',
      message = format('Una recepción en %s exige su tipo de cambio: sin él el costo en soles es indeterminado.', p_currency);
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  if p_supplier_document is not null and (p_supplier_document ->> 'number') is not null then
    insert into public.supplier_documents (
      supplier_id, kind, series, number, issued_at, due_date, currency, exchange_rate, total, file_path
    ) values (
      p_supplier_id,
      coalesce((p_supplier_document ->> 'kind')::public.tax_document_kind, 'invoice'),
      nullif(p_supplier_document ->> 'series', ''),
      p_supplier_document ->> 'number',
      coalesce(nullif(p_supplier_document ->> 'issuedAt', '')::date, current_date),
      nullif(p_supplier_document ->> 'dueDate', '')::date,
      p_currency, rate,
      (p_supplier_document ->> 'total')::numeric,
      nullif(p_supplier_document ->> 'filePath', '')
    )
    returning id into document_id;
  end if;

  receipt_number := 'REC-' || to_char(now(), 'YYYY') || '-' ||
    lpad((coalesce((select count(*) from public.goods_receipts where branch_id = p_branch_id), 0) + 1)::text, 5, '0');

  insert into public.goods_receipts (
    id, purchase_order_id, supplier_id, branch_id, supplier_document_id,
    receipt_number, status, currency, exchange_rate, notes,
    created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_purchase_order_id, p_supplier_id, p_branch_id, document_id,
    receipt_number, 'draft', p_currency, rate, p_notes,
    actor, actor_name, p_client_operation_id
  );

  -- Orden estable por variante: mismo criterio que la venta.
  select jsonb_agg(l order by (l ->> 'variantId')) into ordered_lines
  from jsonb_array_elements(p_lines) l;

  for entry in select value from jsonb_array_elements(ordered_lines) loop
    received := coalesce(nullif(entry ->> 'receivedUnits', '')::integer, 0);
    bonus := coalesce(nullif(entry ->> 'bonusUnits', '')::integer, 0);
    damaged := coalesce(nullif(entry ->> 'damagedUnits', '')::integer, 0);
    cost_pen := round(coalesce(nullif(entry ->> 'unitCost', '')::numeric, 0) * rate, 6);

    insert into public.goods_receipt_lines (
      goods_receipt_id, purchase_order_line_id, variant_id, sku, product_name, variant_name,
      pack_units, expected_units, received_units, bonus_units,
      bonus_valuation, bonus_declared_unit_cost, damaged_units,
      unit_cost, unit_cost_pen, discount_amount, notes
    )
    select
      new_id, nullif(entry ->> 'purchaseOrderLineId', '')::uuid, v.id, v.sku, p.name, v.name,
      coalesce(nullif(entry ->> 'packUnits', '')::integer, 1),
      nullif(entry ->> 'expectedUnits', '')::integer,
      received, bonus,
      coalesce((entry ->> 'bonusValuation')::public.bonus_valuation, 'same_variant'),
      nullif(entry ->> 'bonusDeclaredUnitCost', '')::numeric,
      damaged,
      coalesce(nullif(entry ->> 'unitCost', '')::numeric, 0), cost_pen,
      coalesce(nullif(entry ->> 'discountAmount', '')::numeric, 0),
      nullif(entry ->> 'notes', '')
    from public.product_variants v
    join public.products p on p.id = v.product_id
    where v.id = (entry ->> 'variantId')::uuid;

    line_value := (received * cost_pen) - coalesce(nullif(entry ->> 'discountAmount', '')::numeric, 0) * rate;
    goods_total := goods_total + greatest(line_value, 0);

    -- BONIFICACIÓN DEL MISMO ARTÍCULO: entra en el mismo movimiento y baja el
    -- costo efectivo. Es la distribución económica correcta y automática:
    -- 100 pagadas a 10 más 20 de regalo son 120 unidades a 1.000, o sea 8,3333.
    if coalesce((entry ->> 'bonusValuation')::public.bonus_valuation, 'same_variant') = 'same_variant' then
      effective_units := received + bonus;

      if effective_units > 0 then
        effective_cost := case when effective_units = 0 then null
                          else round(greatest(line_value, 0) / effective_units, 6) end;

        perform public.apply_inventory_movement(
          (entry ->> 'variantId')::uuid, p_branch_id, 'receipt',
          effective_units,
          case when cost_pen = 0 then null else effective_cost end,
          'goods_receipt', new_id, receipt_number, 'Recepción de mercadería', actor
        );
      end if;
    else
      -- Lo pagado entra por su lado.
      if received > 0 then
        perform public.apply_inventory_movement(
          (entry ->> 'variantId')::uuid, p_branch_id, 'receipt', received,
          case when cost_pen = 0 then null else round(greatest(line_value, 0) / received, 6) end,
          'goods_receipt', new_id, receipt_number, 'Recepción de mercadería', actor
        );
      end if;

      -- Y el regalo de OTRO artículo entra al fondo SIN VALORAR cuando no se
      -- declaró su valor. Nunca a costo cero: eso fabricaría un promedio falso
      -- para esa otra variante.
      if bonus > 0 then
        perform public.apply_inventory_movement(
          (entry ->> 'variantId')::uuid, p_branch_id, 'receipt', bonus,
          nullif(entry ->> 'bonusDeclaredUnitCost', '')::numeric,
          'goods_receipt', new_id, receipt_number, 'Bonificación del proveedor', actor
        );
      end if;
    end if;

    -- Las unidades DAÑADAS no entran a disponibilidad vendible: llegaron, se
    -- registran y quedan en la discrepancia, pero nunca fueron inventario.
  end loop;

  update public.goods_receipts
  set status = 'confirmed', confirmed_at = now(), goods_total_pen = goods_total
  where id = new_id;

  -- A crédito nace la obligación; al contado se asume liquidada al pagar.
  if p_terms = 'credit' and goods_total > 0 then
    insert into public.supplier_obligations (
      supplier_id, goods_receipt_id, currency, amount_due, due_date
    )
    select
      p_supplier_id, new_id, p_currency,
      round(goods_total / rate, 4),
      current_date + coalesce((select payment_terms_days from public.suppliers where id = p_supplier_id), 0);
  end if;

  -- Estado de la orden: parcial mientras falte algo.
  if p_purchase_order_id is not null then
    select coalesce(sum(ordered_units), 0) into ordered_total
    from public.purchase_order_lines where purchase_order_id = p_purchase_order_id;

    select coalesce(sum(rl.received_units + rl.bonus_units), 0) into received_total
    from public.goods_receipt_lines rl
    join public.goods_receipts r on r.id = rl.goods_receipt_id
    where r.purchase_order_id = p_purchase_order_id and r.status = 'confirmed';

    -- Con search_path = '' los literales sin calificar no resuelven al enum:
    -- el cast es obligatorio, no cosmético.
    update public.purchase_orders
    set status = case
      when received_total >= ordered_total then 'received'::public.purchase_order_status
      else 'partially_received'::public.purchase_order_status
    end
    where id = p_purchase_order_id;
  end if;

  return public.goods_receipt_detail(new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Pagar a un proveedor
-- ---------------------------------------------------------------------------
-- El pago NO altera el costo histórico ya incorporado al inventario.

create or replace function public.register_supplier_payment(
  p_supplier_id uuid,
  p_branch_id uuid,
  p_method public.payment_method,
  p_amount numeric,
  p_client_operation_id uuid,
  p_currency char(3) default 'PEN',
  p_allocations jsonb default '[]'::jsonb,
  p_reference text default null,
  p_evidence_path text default null,
  p_paid_at timestamptz default null,
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
  existing public.supplier_payments%rowtype;
  new_id uuid := gen_random_uuid();
  entry jsonb;
  assigned numeric(14, 4) := 0;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede pagar a proveedores.';
  end if;

  select * into existing from public.supplier_payments
  where branch_id = p_branch_id and client_operation_id = p_client_operation_id;

  if existing.id is not null then
    return public.supplier_payment_detail(existing.id);
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_name
  from public.admin_profiles where id = actor;

  insert into public.supplier_payments (
    id, supplier_id, branch_id, method, amount, currency, reference,
    evidence_path, paid_at, notes, created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_supplier_id, p_branch_id, p_method, p_amount, p_currency, p_reference,
    p_evidence_path, coalesce(p_paid_at, now()), p_notes, actor, actor_name, p_client_operation_id
  );

  for entry in select value from jsonb_array_elements(coalesce(p_allocations, '[]'::jsonb)) loop
    insert into public.supplier_payment_allocations (
      supplier_payment_id, supplier_obligation_id, amount
    ) values (
      new_id, (entry ->> 'obligationId')::uuid, (entry ->> 'amount')::numeric
    );

    assigned := assigned + (entry ->> 'amount')::numeric;
  end loop;

  if assigned > p_amount then
    raise exception using errcode = '23514',
      message = format('Las asignaciones (%s) superan el importe pagado (%s).', assigned, p_amount);
  end if;

  return public.supplier_payment_detail(new_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Lecturas
-- ---------------------------------------------------------------------------

create or replace function public.purchase_order_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id, 'orderNumber', o.order_number, 'status', o.status,
    'supplierId', o.supplier_id, 'supplierName', s.trade_name,
    'branchId', o.branch_id, 'terms', o.terms, 'currency', o.currency,
    'expectedAt', o.expected_at,
    'grossTotal', o.gross_total, 'discountTotal', o.discount_total, 'total', o.total,
    'createdAt', o.created_at,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'variantId', l.variant_id, 'sku', l.sku,
        'productName', l.product_name, 'variantName', l.variant_name,
        'supplierSku', l.supplier_sku, 'purchaseUnitLabel', l.purchase_unit_label,
        'packUnits', l.pack_units, 'orderedUnits', l.ordered_units,
        'unitCost', l.unit_cost, 'discountAmount', l.discount_amount, 'subtotal', l.subtotal,
        'receivedUnits', coalesce((
          select sum(rl.received_units + rl.bonus_units)
          from public.goods_receipt_lines rl
          join public.goods_receipts r on r.id = rl.goods_receipt_id and r.status = 'confirmed'
          where rl.purchase_order_line_id = l.id
        ), 0)
      ) order by l.created_at)
      from public.purchase_order_lines l where l.purchase_order_id = o.id
    ), '[]'::jsonb)
  )
  from public.purchase_orders o
  join public.suppliers s on s.id = o.supplier_id
  where o.id = p_id;
$$;

create or replace function public.goods_receipt_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id, 'receiptNumber', r.receipt_number, 'status', r.status,
    'supplierId', r.supplier_id, 'supplierName', s.trade_name,
    'branchId', r.branch_id, 'purchaseOrderId', r.purchase_order_id,
    'currency', r.currency, 'exchangeRate', r.exchange_rate,
    'receivedAt', r.received_at, 'goodsTotalPen', r.goods_total_pen,
    'discrepancyNote', r.discrepancy_note,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'variantId', l.variant_id, 'sku', l.sku,
        'productName', l.product_name, 'variantName', l.variant_name,
        'expectedUnits', l.expected_units, 'receivedUnits', l.received_units,
        'bonusUnits', l.bonus_units, 'bonusValuation', l.bonus_valuation,
        'damagedUnits', l.damaged_units,
        'missingUnits', case when l.expected_units is null then null
                        else greatest(l.expected_units - l.received_units, 0) end,
        'surplusUnits', case when l.expected_units is null then null
                        else greatest(l.received_units - l.expected_units, 0) end,
        'unitCost', l.unit_cost, 'unitCostPen', l.unit_cost_pen
      ) order by l.created_at)
      from public.goods_receipt_lines l where l.goods_receipt_id = r.id
    ), '[]'::jsonb)
  )
  from public.goods_receipts r
  join public.suppliers s on s.id = r.supplier_id
  where r.id = p_id;
$$;

create or replace function public.supplier_payment_detail(p_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p.id, 'supplierId', p.supplier_id, 'supplierName', s.trade_name,
    'branchId', p.branch_id, 'method', p.method, 'amount', p.amount,
    'currency', p.currency, 'paidAt', p.paid_at, 'reference', p.reference,
    'allocated', coalesce((select sum(a.amount) from public.supplier_payment_allocations a
                           where a.supplier_payment_id = p.id), 0),
    'unallocated', p.amount - coalesce((select sum(a.amount) from public.supplier_payment_allocations a
                                        where a.supplier_payment_id = p.id), 0),
    'allocations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'obligationId', a.supplier_obligation_id, 'amount', a.amount,
        'dueDate', o.due_date
      ))
      from public.supplier_payment_allocations a
      join public.supplier_obligations o on o.id = a.supplier_obligation_id
      where a.supplier_payment_id = p.id
    ), '[]'::jsonb)
  )
  from public.supplier_payments p
  join public.suppliers s on s.id = p.supplier_id
  where p.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 9. RLS
-- ---------------------------------------------------------------------------
-- Todo el abastecimiento es dominio administrativo: la vendedora obtiene CERO
-- filas de compras, recepciones, obligaciones y pagos.

alter table public.purchase_orders enable row level security;
alter table public.purchase_order_lines enable row level security;
alter table public.supplier_documents enable row level security;
alter table public.goods_receipts enable row level security;
alter table public.goods_receipt_lines enable row level security;
alter table public.supplier_obligations enable row level security;
alter table public.supplier_payments enable row level security;
alter table public.supplier_payment_allocations enable row level security;

create policy "admins manage purchase orders"
on public.purchase_orders for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage purchase order lines"
on public.purchase_order_lines for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage supplier documents"
on public.supplier_documents for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage goods receipts"
on public.goods_receipts for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage goods receipt lines"
on public.goods_receipt_lines for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage supplier obligations"
on public.supplier_obligations for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Sin políticas de update ni delete sobre el dinero: toda corrección se hace
-- por reversión registrada.
create policy "admins read supplier payments"
on public.supplier_payments for select to authenticated
using (public.is_admin());

create policy "admins register supplier payments"
on public.supplier_payments for insert to authenticated
with check (public.is_admin());

create policy "admins read payment allocations"
on public.supplier_payment_allocations for select to authenticated
using (public.is_admin());

create policy "admins register payment allocations"
on public.supplier_payment_allocations for insert to authenticated
with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 10. Privilegios
-- ---------------------------------------------------------------------------

grant select, insert, update on public.purchase_orders to authenticated, service_role;
grant select, insert, update on public.purchase_order_lines to authenticated, service_role;
grant select, insert, update on public.supplier_documents to authenticated, service_role;
grant select, insert, update on public.goods_receipts to authenticated, service_role;
grant select, insert on public.goods_receipt_lines to authenticated, service_role;
grant select, insert, update on public.supplier_obligations to authenticated, service_role;
grant select, insert on public.supplier_payments to authenticated, service_role;
grant select, insert on public.supplier_payment_allocations to authenticated, service_role;
grant select on public.supplier_balances to authenticated;
grant select on public.supplier_unallocated_payments to authenticated;

revoke truncate on public.purchase_orders, public.purchase_order_lines,
  public.supplier_documents, public.goods_receipts, public.goods_receipt_lines,
  public.supplier_obligations, public.supplier_payments,
  public.supplier_payment_allocations
from anon, authenticated, service_role;

-- Se revoca también a anon: el `revoke … from public` no retira nada del ACL por
-- defecto de Supabase, que concede EXECUTE a anon sobre toda función nueva del
-- esquema public. La guarda `is_admin()` ya lo frenaría, pero un contrato de
-- compras no tiene por qué ser siquiera invocable desde el catálogo público.
revoke all on function public.issue_purchase_order(uuid, uuid, jsonb, uuid, char, public.purchase_terms, integer, date, text) from public, anon;
revoke all on function public.register_goods_receipt(uuid, uuid, jsonb, uuid, uuid, char, numeric, jsonb, public.purchase_terms, text) from public, anon;
revoke all on function public.register_supplier_payment(uuid, uuid, public.payment_method, numeric, uuid, char, jsonb, text, text, timestamptz, text) from public, anon;
revoke all on function public.purchase_order_detail(uuid) from public, anon;
revoke all on function public.goods_receipt_detail(uuid) from public, anon;
revoke all on function public.supplier_payment_detail(uuid) from public, anon;

grant execute on function public.issue_purchase_order(uuid, uuid, jsonb, uuid, char, public.purchase_terms, integer, date, text) to authenticated, service_role;
grant execute on function public.register_goods_receipt(uuid, uuid, jsonb, uuid, uuid, char, numeric, jsonb, public.purchase_terms, text) to authenticated, service_role;
grant execute on function public.register_supplier_payment(uuid, uuid, public.payment_method, numeric, uuid, char, jsonb, text, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.purchase_order_detail(uuid) to authenticated, service_role;
grant execute on function public.goods_receipt_detail(uuid) to authenticated, service_role;
grant execute on function public.supplier_payment_detail(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 11. Auditoría
-- ---------------------------------------------------------------------------

select public.attach_audit('public.purchase_orders');
select public.attach_audit('public.purchase_order_lines');
select public.attach_audit('public.supplier_documents');
select public.attach_audit('public.goods_receipts');
select public.attach_audit('public.goods_receipt_lines');
select public.attach_audit('public.supplier_obligations');
select public.attach_audit('public.supplier_payments');
select public.attach_audit('public.supplier_payment_allocations');

commit;
