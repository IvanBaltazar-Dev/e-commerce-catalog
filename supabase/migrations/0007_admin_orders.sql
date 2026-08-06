begin;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number bigint generated always as identity unique,
  status text not null default 'registered',
  customer_name text not null,
  customer_phone text,
  delivery_method text not null default 'pickup',
  delivery_address text,
  customer_note text,
  total_units integer not null,
  subtotal numeric(12, 2),
  unresolved_lines integer not null default 0,
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint orders_status_check check (status in ('registered', 'confirmed', 'completed', 'cancelled')),
  constraint orders_customer_name_not_blank check (length(trim(customer_name)) > 0),
  constraint orders_delivery_method_check check (delivery_method in ('shipping', 'pickup')),
  constraint orders_total_units_positive check (total_units > 0),
  constraint orders_unresolved_lines_valid check (unresolved_lines between 0 and total_units),
  constraint orders_subtotal_non_negative check (subtotal is null or subtotal >= 0)
);

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  product_id uuid references public.products(id) on delete set null,
  variant_id uuid references public.product_variants(id) on delete set null,
  sku text not null,
  product_name text not null,
  variant_name text not null,
  brand_name text not null,
  quantity integer not null,
  unit_price numeric(12, 2),
  subtotal numeric(12, 2),
  purchase_mode text not null,
  availability public.product_availability not null,
  created_at timestamptz not null default now(),
  constraint order_items_quantity_positive check (quantity > 0),
  constraint order_items_prices_non_negative check (
    (unit_price is null or unit_price >= 0) and (subtotal is null or subtotal >= 0)
  ),
  constraint order_items_purchase_mode_check check (purchase_mode in ('retail', 'wholesale', 'consult'))
);

create index orders_created_at_idx on public.orders(created_at desc);
create index orders_status_created_at_idx on public.orders(status, created_at desc);
create index order_items_order_id_idx on public.order_items(order_id);
create index order_items_variant_id_idx on public.order_items(variant_id);

create trigger orders_set_updated_at
before update on public.orders
for each row execute function public.set_updated_at();

alter table public.orders enable row level security;
alter table public.order_items enable row level security;

create policy "admins manage orders"
on public.orders
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "admins manage order items"
on public.order_items
for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

grant select, insert, update, delete on public.orders to authenticated, service_role;
grant select, insert, update, delete on public.order_items to authenticated, service_role;
grant usage, select on sequence public.orders_order_number_seq to authenticated, service_role;

create or replace function public.create_admin_order(
  p_customer_name text,
  p_customer_phone text,
  p_delivery_method text,
  p_delivery_address text,
  p_customer_note text,
  p_lines jsonb
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  evaluation jsonb;
  order_record public.orders%rowtype;
  line jsonb;
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo un administrador puede registrar pedidos.';
  end if;

  if nullif(trim(p_customer_name), '') is null then
    raise exception using errcode = '22023', message = 'Ingresa el nombre del cliente.';
  end if;

  if p_delivery_method not in ('shipping', 'pickup') then
    raise exception using errcode = '22023', message = 'Selecciona una modalidad de entrega válida.';
  end if;

  evaluation := public.evaluate_cart_v2(p_lines);

  if exists (
    select 1
    from jsonb_array_elements(evaluation -> 'lines') evaluated_line
    where evaluated_line ->> 'availability' = 'sold_out'
  ) then
    raise exception using errcode = '22023', message = 'El pedido contiene una presentación agotada.';
  end if;

  insert into public.orders (
    customer_name,
    customer_phone,
    delivery_method,
    delivery_address,
    customer_note,
    total_units,
    subtotal,
    unresolved_lines
  ) values (
    trim(p_customer_name),
    nullif(trim(coalesce(p_customer_phone, '')), ''),
    p_delivery_method,
    nullif(trim(coalesce(p_delivery_address, '')), ''),
    nullif(trim(coalesce(p_customer_note, '')), ''),
    (evaluation ->> 'totalUnits')::integer,
    (evaluation ->> 'subtotal')::numeric,
    (evaluation ->> 'unresolvedLines')::integer
  )
  returning * into order_record;

  for line in select value from jsonb_array_elements(evaluation -> 'lines')
  loop
    insert into public.order_items (
      order_id,
      product_id,
      variant_id,
      sku,
      product_name,
      variant_name,
      brand_name,
      quantity,
      unit_price,
      subtotal,
      purchase_mode,
      availability
    ) values (
      order_record.id,
      (line ->> 'productId')::uuid,
      (line ->> 'variantId')::uuid,
      line ->> 'sku',
      line ->> 'productName',
      line ->> 'variantName',
      line ->> 'brandName',
      (line ->> 'quantity')::integer,
      (line ->> 'unitPrice')::numeric,
      (line ->> 'subtotal')::numeric,
      line ->> 'purchaseMode',
      (line ->> 'availability')::public.product_availability
    );
  end loop;

  return jsonb_build_object(
    'id', order_record.id,
    'orderNumber', order_record.order_number,
    'status', order_record.status,
    'customerName', order_record.customer_name,
    'customerPhone', order_record.customer_phone,
    'deliveryMethod', order_record.delivery_method,
    'deliveryAddress', order_record.delivery_address,
    'customerNote', order_record.customer_note,
    'totalUnits', order_record.total_units,
    'subtotal', order_record.subtotal,
    'unresolvedLines', order_record.unresolved_lines,
    'createdAt', order_record.created_at,
    'lines', evaluation -> 'lines'
  );
end;
$$;

revoke execute on function public.create_admin_order(text, text, text, text, text, jsonb) from public;
grant execute on function public.create_admin_order(text, text, text, text, text, jsonb)
to authenticated, service_role;

commit;
