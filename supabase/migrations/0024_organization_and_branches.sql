-- Vertical 1 · Organización, sede y rol de vendedora (2 de 3).
--
-- El plan del Bloque 1 es explícito: «aunque inicialmente exista una sede, toda
-- venta, compra, reserva y disponibilidad debe guardar branch_id». Esta migración
-- crea la dimensión organizativa antes de que exista cualquier tabla de operación,
-- para no tener que migrar después todas las tablas transaccionales y sus RLS.
--
-- Contenido:
--   1. companies         empresa
--   2. branches          sedes, con una predeterminada garantizada
--   3. admin_profiles    perfil de personal: activación y teléfono
--   4. staff_branches    asignación de personal a sedes
--   5. predicados        is_staff, is_seller, staff_branch_ids, default_branch_id
--   6. orders.branch_id  primera aplicación de la regla
--   7. datos iniciales   empresa y sede principal

begin;

-- ---------------------------------------------------------------------------
-- 1. Empresa
-- ---------------------------------------------------------------------------

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  trade_name text not null,
  tax_id text,
  phone text,
  email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint companies_legal_name_not_blank check (length(trim(legal_name)) > 0),
  constraint companies_trade_name_not_blank check (length(trim(trade_name)) > 0),
  -- RUC peruano: once dígitos.
  constraint companies_tax_id_format check (tax_id is null or tax_id ~ '^[0-9]{11}$'),
  constraint companies_email_format check (email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

create unique index companies_tax_id_unique on public.companies(tax_id) where tax_id is not null;

create trigger companies_set_updated_at
before update on public.companies
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2. Sedes
-- ---------------------------------------------------------------------------

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null,
  name text not null,
  address text,
  district text,
  province text,
  phone text,
  whatsapp_number text,
  is_default boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branches_code_format check (code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
  constraint branches_name_not_blank check (length(trim(name)) > 0),
  constraint branches_company_code_unique unique (company_id, code),
  -- Una sede inactiva no puede seguir siendo la predeterminada.
  constraint branches_default_must_be_active check (not is_default or is_active)
);

create index branches_company_idx on public.branches(company_id, sort_order, name);

-- Como máximo una sede predeterminada activa por empresa.
create unique index branches_one_default_per_company
on public.branches(company_id)
where is_default and is_active;

create trigger branches_set_updated_at
before update on public.branches
for each row execute function public.set_updated_at();

-- Y al menos una: si la empresa conserva sedes activas, una debe ser la
-- predeterminada. Diferido, para permitir reordenar dentro de una transacción.
-- Mismo patrón que la variante predeterminada de producto en 0005.
create or replace function public.assert_company_has_default_branch()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  affected_company_id uuid := coalesce(new.company_id, old.company_id);
begin
  if exists (
    select 1 from public.branches
    where company_id = affected_company_id and is_active
  ) and not exists (
    select 1 from public.branches
    where company_id = affected_company_id and is_active and is_default
  ) then
    raise exception using
      errcode = '23514',
      message = 'La empresa debe conservar una sede predeterminada activa.';
  end if;

  return null;
end;
$$;

create constraint trigger branches_default_guard
after insert or update or delete on public.branches
deferrable initially deferred
for each row execute function public.assert_company_has_default_branch();

-- ---------------------------------------------------------------------------
-- 3. Perfil de personal
-- ---------------------------------------------------------------------------

alter table public.admin_profiles
  add column if not exists is_active boolean not null default true,
  add column if not exists phone text;

comment on table public.admin_profiles is
  'Personal del negocio. El nombre se conserva por compatibilidad con 61 políticas RLS; '
  'desde 0023 alberga también el rol seller (vendedora).';

-- Un perfil desactivado deja de tener acceso, sin necesidad de borrar el usuario
-- ni perder su rastro en pedidos y auditoría.
create or replace function public.is_admin(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = user_id
      and is_active
      and role in ('admin', 'developer')
  );
$$;

create or replace function public.is_developer(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = user_id
      and is_active
      and role = 'developer'
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. Asignación de personal a sedes
-- ---------------------------------------------------------------------------

create table public.staff_branches (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.admin_profiles(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  constraint staff_branches_unique unique (staff_id, branch_id)
);

create index staff_branches_branch_idx on public.staff_branches(branch_id);

-- Como máximo una sede principal por persona.
create unique index staff_branches_one_primary
on public.staff_branches(staff_id)
where is_primary;

-- ---------------------------------------------------------------------------
-- 5. Predicados de autorización y resolución de sede
-- ---------------------------------------------------------------------------

create or replace function public.is_staff(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where id = user_id and is_active
  );
$$;

create or replace function public.is_seller(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admin_profiles
    where id = user_id and is_active and role = 'seller'
  );
$$;

-- Sedes en las que la persona puede operar. Administración y perfil técnico
-- alcanzan todas las sedes activas; la vendedora, solo las asignadas.
create or replace function public.staff_branch_ids(user_id uuid default auth.uid())
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.id
  from public.branches b
  where b.is_active
    and (
      public.is_admin(user_id)
      or exists (
        select 1 from public.staff_branches sb
        where sb.staff_id = user_id and sb.branch_id = b.id
      )
    );
$$;

-- Sede a usar cuando la operación no indica una: la principal de la persona y,
-- si no tiene, la predeterminada de la empresa.
create or replace function public.default_branch_id(user_id uuid default auth.uid())
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select sb.branch_id
      from public.staff_branches sb
      join public.branches b on b.id = sb.branch_id and b.is_active
      where sb.staff_id = user_id and sb.is_primary
      limit 1
    ),
    (
      select sb.branch_id
      from public.staff_branches sb
      join public.branches b on b.id = sb.branch_id and b.is_active
      where sb.staff_id = user_id
      order by b.sort_order, b.name
      limit 1
    ),
    (
      select b.id
      from public.branches b
      where b.is_active and b.is_default
      order by b.sort_order, b.name
      limit 1
    )
  );
$$;

revoke all on function public.assert_company_has_default_branch() from public;
revoke all on function public.is_staff(uuid) from public;
revoke all on function public.is_seller(uuid) from public;
revoke all on function public.staff_branch_ids(uuid) from public;
revoke all on function public.default_branch_id(uuid) from public;

grant execute on function public.is_staff(uuid) to authenticated, service_role;
grant execute on function public.is_seller(uuid) to authenticated, service_role;
grant execute on function public.staff_branch_ids(uuid) to authenticated, service_role;
grant execute on function public.default_branch_id(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. RLS
-- ---------------------------------------------------------------------------

alter table public.companies enable row level security;
alter table public.branches enable row level security;
alter table public.staff_branches enable row level security;

-- La empresa la ve el personal activo; solo administración la modifica.
create policy "staff read company"
on public.companies for select to authenticated
using (public.is_staff());

create policy "admins manage company"
on public.companies for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- El público necesita los datos de la sede para recojo y contacto.
create policy "public read active branches"
on public.branches for select to anon, authenticated
using (is_active = true);

create policy "admins manage branches"
on public.branches for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Cada persona ve sus asignaciones; administración las gestiona todas.
create policy "staff read own branch assignments"
on public.staff_branches for select to authenticated
using (staff_id = auth.uid() or public.is_admin());

create policy "admins manage staff branches"
on public.staff_branches for all to authenticated
using (public.is_admin()) with check (public.is_admin());

grant select on public.branches to anon;
grant select on public.companies to authenticated;
grant select, insert, update, delete on public.companies to authenticated, service_role;
grant select, insert, update, delete on public.branches to authenticated, service_role;
grant select, insert, update, delete on public.staff_branches to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Datos iniciales: una empresa y su sede principal
-- ---------------------------------------------------------------------------

insert into public.companies (legal_name, trade_name)
select 'Importaciones Bellaroshé', 'Bellaroshé'
where not exists (select 1 from public.companies);

insert into public.branches (
  company_id, code, name, district, province, whatsapp_number, is_default, sort_order
)
select c.id, 'PRINCIPAL', 'Sede principal', 'Lima', 'Lima', '+51963463550', true, 10
from public.companies c
where c.trade_name = 'Bellaroshé'
on conflict (company_id, code) do nothing;

-- ---------------------------------------------------------------------------
-- 8. branch_id en pedidos: primera aplicación de la regla
-- ---------------------------------------------------------------------------

alter table public.orders
  add column branch_id uuid references public.branches(id) on delete restrict;

update public.orders
set branch_id = (
  select b.id from public.branches b
  where b.is_active and b.is_default
  order by b.sort_order, b.name
  limit 1
)
where branch_id is null;

alter table public.orders alter column branch_id set not null;

create index orders_branch_idx on public.orders(branch_id, created_at desc);

-- La firma cambia, así que hay que retirar la anterior: dejar ambas volvería
-- ambigua la llamada de seis argumentos desde PostgREST.
drop function if exists public.create_admin_order(text, text, text, text, text, jsonb);

create or replace function public.create_admin_order(
  p_customer_name text,
  p_customer_phone text,
  p_delivery_method text,
  p_delivery_address text,
  p_customer_note text,
  p_lines jsonb,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  evaluation jsonb;
  order_record public.orders%rowtype;
  line jsonb;
  resolved_branch_id uuid;
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

  resolved_branch_id := coalesce(p_branch_id, public.default_branch_id());

  if resolved_branch_id is null then
    raise exception using errcode = '22023', message = 'No hay una sede activa para registrar el pedido.';
  end if;

  -- Una vendedora solo registra en las sedes que tiene asignadas.
  if not exists (
    select 1 from public.staff_branch_ids() as allowed(id)
    where allowed.id = resolved_branch_id
  ) then
    raise exception using errcode = '42501', message = 'No tienes permiso para registrar pedidos en esa sede.';
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
    branch_id,
    customer_name,
    customer_phone,
    delivery_method,
    delivery_address,
    customer_note,
    total_units,
    subtotal,
    unresolved_lines
  ) values (
    resolved_branch_id,
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
    'branchId', order_record.branch_id,
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

revoke execute on function public.create_admin_order(text, text, text, text, text, jsonb, uuid) from public;
grant execute on function public.create_admin_order(text, text, text, text, text, jsonb, uuid)
to authenticated, service_role;

commit;
