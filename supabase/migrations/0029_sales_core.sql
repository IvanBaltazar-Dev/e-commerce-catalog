-- Bloque 2 · Migración 2 de 5 — Ventas, reservas, pagos y costos históricos.
--
-- Ver docs/bloque-2-modelo.md §4 y las 14 correcciones de su anexo §12.
--
-- DESTINO DE `orders` (decisión exigida por el plan): se RETIRA. Tiene cero
-- filas, nunca llegó a producción —el despliegue actual corre el catálogo V1,
-- anterior a 0007— y conservarla dejaría dos conceptos de venta conviviendo,
-- que es justamente la segunda fuente de verdad que las reglas del bloque
-- prohíben. `sales` la sustituye por completo y con más alcance.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA Y QUE EL MODELO DEJABA ABIERTAS
-- (verificadas contra la base, no deducidas del texto):
--
-- A. CONTEXTO DE SEGURIDAD DE LOS RPC DE CAJA: SECURITY DEFINER con
--    revalidación explícita. El anexo §12/0029-9 daba por posible que
--    register_sale fuese INVOKER; comprobado contra la base local, NO lo es:
--    la primera sentencia de apply_inventory_movement es un insert sobre
--    inventory_stock, cuya única política de escritura es `admins manage stock`,
--    así que una vendedora aborta con «new row violates row-level security
--    policy for table inventory_stock» antes de tocar la venta. Las dos salidas
--    eran abrir política de escritura de existencias a toda vendedora —que le
--    permitiría alterar saldos desde PostgREST sin pasar por ningún RPC— o
--    mover la frontera de confianza al RPC. Se elige la segunda, que es la que
--    §12/0029-10 ya tenía prevista: DEFINER + revalidación de sede contra
--    staff_branch_ids() + retorno que nunca contiene costo para quien no es
--    administración.
--
-- B. LO QUE NO SE SIGUE, NO SE MUEVE. Una variante con tracks_inventory = false
--    no tiene existencia que descontar: su venta NO genera asiento de kardex y
--    su costo queda `unknown`. Sin esta regla ninguna venta sería registrable
--    hasta terminar la carga inicial, que §3 declara gradual por diseño.
--
-- C. LA CONVERSIÓN DE UNA RESERVA VENDE LOS PRECIOS CONGELADOS. §4 dice que
--    reservation_lines congela el precio al reservar; volver a evaluar el
--    carrito al convertir haría que un cambio de tarifa alterara lo pactado y
--    que las cantidades dejaran de cuadrar con lo ya comprometido en `reserved`.

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

-- Una venta nace confirmada: la regla dice que una venta normal se confirma
-- completamente pagada, así que no existe estado «pendiente».
create type public.sale_status as enum ('confirmed', 'cancelled');

-- ORIGEN de la venta. Separado de la entrega a propósito: una venta puede
-- originarse en Instagram y entregarse por delivery. El Bloque 3 añadirá
-- cuentas, conversaciones y atribución de campaña; aquí solo el origen mínimo.
create type public.sale_source_channel as enum (
  'in_store', 'web', 'whatsapp', 'facebook', 'instagram', 'tiktok', 'phone', 'other'
);

create type public.fulfillment_method as enum ('in_store', 'pickup', 'delivery');

create type public.payment_method as enum (
  'cash', 'yape', 'plin', 'transfer', 'card', 'reservation_advance', 'store_credit', 'other'
);

create type public.tax_document_status as enum (
  'requested', 'pending_issue', 'issued_externally', 'declined', 'cancelled'
);

create type public.reservation_status as enum (
  'active', 'expired', 'released', 'converted', 'cancelled'
);

create type public.sale_document_kind as enum ('sale_note', 'reservation');

-- ---------------------------------------------------------------------------
-- 1. Límite de descuento por persona
-- ---------------------------------------------------------------------------
-- Restricción automática, no flujo de aprobación. Nulo = sin límite propio,
-- que es lo que corresponde a administración.

alter table public.admin_profiles
  add column if not exists max_discount_percent numeric(5, 2),
  add column if not exists max_discount_amount numeric(12, 2);

alter table public.admin_profiles
  add constraint admin_profiles_discount_limits_valid check (
    (max_discount_percent is null or (max_discount_percent >= 0 and max_discount_percent <= 100))
    and (max_discount_amount is null or max_discount_amount >= 0)
  );

-- ---------------------------------------------------------------------------
-- 2. Corrección del contexto de seguridad heredado de 0028
-- ---------------------------------------------------------------------------
-- Ver la decisión A de la cabecera. apply_inventory_movement es el punto único
-- de escritura de existencias, kardex y valoración: pasa a SECURITY DEFINER y
-- deja de ser alcanzable directamente desde PostgREST. Solo se llega a él por
-- los RPC de dominio, que sí revalidan quién opera y sobre qué sede.

alter function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer, numeric, text, uuid, text, text, uuid
) security definer;

alter function public.adjust_inventory(uuid, uuid, integer, text, numeric) security definer;

-- El `revoke ... from public` de 0028 no retira nada a anon ni a authenticated:
-- el ACL por defecto de Supabase les concede EXECUTE sobre toda función nueva
-- del esquema public (verificado: has_function_privilege('anon', …) = true).
-- Sin este revoke, cualquier visitante anónimo del catálogo podría mover el
-- inventario llamando al RPC por su nombre.
revoke all on function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer, numeric, text, uuid, text, text, uuid
) from anon, authenticated;

revoke all on function public.adjust_inventory(uuid, uuid, integer, text, numeric) from anon;
revoke all on function public.load_initial_inventory(jsonb, text, uuid) from anon;

-- La carga inicial se ejecuta desde un script con service_role, donde auth.uid()
-- es nulo y por tanto is_admin() es falso: tal como estaba, la rama documentada
-- de «actor explícito sin sesión» era inalcanzable. Se autoriza contra el ACTOR
-- declarado, que es de quien queda el rastro en el kardex.
create or replace function public.load_initial_inventory(
  p_rows jsonb,
  p_mode text default 'preview',
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  entry jsonb;
  issues jsonb := '[]'::jsonb;
  accepted jsonb := '[]'::jsonb;
  variant public.product_variants%rowtype;
  branch public.branches%rowtype;
  quantity integer;
  unit_cost numeric;
  actor uuid := coalesce(p_actor_id, auth.uid());
  seen text[] := array[]::text[];
  pair_key text;
begin
  -- El kardex necesita un responsable con nombre: sin sesión hay que declararlo.
  if actor is null then
    raise exception using errcode = '22023',
      message = 'La carga inicial exige un actor explícito cuando no hay sesión.';
  end if;

  if not public.is_admin(actor) then
    raise exception using errcode = '42501', message = 'Solo administración puede cargar la existencia inicial.';
  end if;

  if p_mode not in ('preview', 'commit') then
    raise exception using errcode = '22023', message = 'El modo debe ser preview o commit.';
  end if;

  for entry in select value from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb))
  loop
    select * into variant from public.product_variants where sku = (entry ->> 'sku');
    select * into branch from public.branches where code = (entry ->> 'branchCode') and is_active;
    quantity := nullif(entry ->> 'quantity', '')::integer;
    unit_cost := nullif(entry ->> 'unitCost', '')::numeric;
    pair_key := coalesce(entry ->> 'sku', '') || '|' || coalesce(entry ->> 'branchCode', '');

    if variant.id is null then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'SKU inexistente');
    elsif branch.id is null then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'Sede inexistente o inactiva');
    elsif quantity is null or quantity < 0 then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'Cantidad ausente o negativa');
    elsif unit_cost is not null and unit_cost < 0 then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'Costo negativo');
    elsif pair_key = any(seen) then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'SKU duplicado para la misma sede');
    elsif variant.tracks_inventory then
      issues := issues || jsonb_build_object('sku', entry ->> 'sku', 'issue', 'La variante ya tiene seguimiento activo');
    else
      seen := seen || pair_key;
      accepted := accepted || jsonb_build_object(
        'variantId', variant.id, 'branchId', branch.id, 'sku', variant.sku,
        'quantity', quantity, 'unitCost', unit_cost
      );
    end if;
  end loop;

  -- Todo o nada: un lote con cualquier problema no se confirma.
  if p_mode = 'commit' and jsonb_array_length(issues) = 0 then
    for entry in select value from jsonb_array_elements(accepted)
    loop
      -- La invariante de §3 es la guarda de idempotencia: una segunda pasada
      -- encuentra tracks_inventory ya activo y la fila se rechaza arriba.
      update public.product_variants
      set tracks_inventory = true
      where id = (entry ->> 'variantId')::uuid and not tracks_inventory;

      if not found then
        raise exception using errcode = '23514',
          message = format('La presentación %s ya tenía seguimiento activo.', entry ->> 'sku');
      end if;

      if (entry ->> 'quantity')::integer > 0 then
        perform public.apply_inventory_movement(
          (entry ->> 'variantId')::uuid,
          (entry ->> 'branchId')::uuid,
          'initial_load',
          (entry ->> 'quantity')::integer,
          nullif(entry ->> 'unitCost', '')::numeric,
          'initial_load', null, 'Toma física inicial',
          'Carga inicial de existencias', actor
        );
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'mode', p_mode,
    'accepted', jsonb_array_length(accepted),
    'rejected', jsonb_array_length(issues),
    'committed', (p_mode = 'commit' and jsonb_array_length(issues) = 0),
    'issues', issues,
    'rows', accepted
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Guarda de sede compartida
-- ---------------------------------------------------------------------------
-- Dentro de un SECURITY DEFINER las políticas no se evalúan, pero auth.uid() y
-- staff_branch_ids() sí siguen resolviendo. Esta es la revalidación que §12
-- exige repetir en toda RPC definer, en un solo sitio para que no se olvide.
--
-- Sin sesión (service_role, tarea programada o mantenimiento por psql) no hay
-- perfil contra el que recortar: el contexto ya es de confianza y el ACL de la
-- función —revocada a anon— es lo que impide llegar aquí desde el navegador.

create or replace function public.assert_branch_access(p_branch_id uuid, p_action text)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if auth.uid() is null then
    return;
  end if;

  if not public.is_staff() then
    raise exception using errcode = '42501',
      message = format('Solo el personal activo puede %s.', p_action);
  end if;

  if not exists (
    select 1 from public.staff_branch_ids() as allowed(id) where allowed.id = p_branch_id
  ) then
    raise exception using errcode = '42501',
      message = format('No tienes permiso para %s en esa sede.', p_action);
  end if;
end;
$$;

revoke all on function public.assert_branch_access(uuid, text) from public, anon;

-- ---------------------------------------------------------------------------
-- 4. Correlativos por sede
-- ---------------------------------------------------------------------------
-- Numeración CONTIGUA por sede, que es lo que el negocio espera de una nota de
-- venta. Una identity global dejaría huecos por transacción abortada.
-- El candado se toma AL FINAL de la operación: es el registro más contendido de
-- la sede y retenerlo desde el principio serializaría toda la caja.

create table public.branch_document_counters (
  branch_id uuid not null references public.branches(id) on delete restrict,
  document_kind public.sale_document_kind not null,
  prefix text not null,
  next_number bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (branch_id, document_kind),
  constraint branch_document_counters_next_positive check (next_number > 0),
  constraint branch_document_counters_prefix_format check (prefix ~ '^[A-Z0-9-]{1,12}$')
);

comment on table public.branch_document_counters is
  'Correlativo por sede y tipo de documento. Se bloquea DESPUÉS de las filas de '
  'inventario: ese es el orden global de candados del bloque.';

create or replace function public.next_document_number(
  p_branch_id uuid,
  p_kind public.sale_document_kind
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  counter public.branch_document_counters%rowtype;
  default_prefix text := case when p_kind = 'sale_note' then 'NV' else 'RES' end;
begin
  -- Upsert primero, igual que con las existencias: un `for update` sobre una
  -- sede que todavía no tiene contador bloquea cero filas y dos ventas
  -- simultáneas obtendrían el mismo número.
  insert into public.branch_document_counters as c (branch_id, document_kind, prefix)
  values (p_branch_id, p_kind, default_prefix)
  on conflict (branch_id, document_kind) do update set updated_at = c.updated_at;

  update public.branch_document_counters
  set next_number = next_number + 1, updated_at = now()
  where branch_id = p_branch_id and document_kind = p_kind
  returning * into counter;

  return counter.prefix || '-' || lpad((counter.next_number - 1)::text, 6, '0');
end;
$$;

revoke all on function public.next_document_number(uuid, public.sale_document_kind)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Reservas
-- ---------------------------------------------------------------------------
-- Se declaran antes que las ventas porque una venta puede referenciar la
-- reserva de la que nació.

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  reservation_number text not null,
  status public.reservation_status not null default 'active',
  -- Cliente OBLIGATORIO: una reserva sin cliente no se puede entregar ni cobrar.
  customer_name text not null,
  customer_phone text,
  customer_document text,
  expires_at timestamptz not null,
  total numeric(12, 2) not null default 0,
  currency char(3) not null default 'PEN',
  notes text,
  created_by uuid,
  created_by_label text,
  client_operation_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  released_at timestamptz,
  release_reason text,
  constraint reservations_customer_not_blank check (length(trim(customer_name)) > 0),
  constraint reservations_total_non_negative check (total >= 0),
  constraint reservations_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint reservations_number_unique unique (branch_id, reservation_number),
  -- Idempotencia: un botón pulsado dos veces devuelve la reserva ya creada.
  constraint reservations_operation_unique unique (branch_id, client_operation_id)
);

create index reservations_status_idx on public.reservations(status, expires_at);
create index reservations_branch_idx on public.reservations(branch_id, created_at desc);

create trigger reservations_set_updated_at
before update on public.reservations
for each row execute function public.set_updated_at();

create table public.reservation_lines (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  -- Fotografía: la reserva debe seguir siendo legible aunque cambie el catálogo.
  sku text,
  product_name text,
  variant_name text,
  brand_name text,
  quantity integer not null,
  unit_price numeric(12, 2) not null,
  subtotal numeric(12, 2) not null,
  purchase_mode text not null default 'retail',
  -- Si la variante no lleva seguimiento no se comprometió nada: al liberar hay
  -- que saberlo con exactitud en vez de restar a ciegas contra un saldo ajeno.
  reserved_stock boolean not null default false,
  created_at timestamptz not null default now(),
  constraint reservation_lines_quantity_positive check (quantity > 0),
  constraint reservation_lines_price_non_negative check (unit_price >= 0),
  constraint reservation_lines_subtotal_non_negative check (subtotal >= 0),
  constraint reservation_lines_purchase_mode check (purchase_mode in ('retail', 'wholesale')),
  constraint reservation_lines_unique unique (reservation_id, variant_id)
);

create index reservation_lines_variant_idx on public.reservation_lines(variant_id);

create table public.reservation_payments (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  method public.payment_method not null,
  -- El dinero que ENTRÓ y el que se APLICA no son el mismo concepto.
  amount numeric(12, 2) not null,
  tendered_amount numeric(12, 2),
  currency char(3) not null default 'PEN',
  reference text,
  evidence_path text,
  received_at timestamptz not null default now(),
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  constraint reservation_payments_amount_positive check (amount > 0),
  constraint reservation_payments_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- El vuelto se deriva de lo entregado menos lo aplicado, y solo en efectivo.
  constraint reservation_payments_tendered_valid check (
    tendered_amount is null or (method = 'cash' and tendered_amount >= amount)
  )
);

create index reservation_payments_reservation_idx on public.reservation_payments(reservation_id);

-- ---------------------------------------------------------------------------
-- 6. Ventas
-- ---------------------------------------------------------------------------

create table public.sales (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  sale_number text not null,
  status public.sale_status not null default 'confirmed',
  source_channel public.sale_source_channel not null default 'in_store',
  source_reference text,
  fulfillment_method public.fulfillment_method not null default 'in_store',
  customer_name text,
  customer_phone text,
  customer_document text,
  delivery_address text,
  -- discount_total NO es un dato independiente: se valida como la suma exacta
  -- de los descuentos de línea, que son la única fuente de verdad.
  gross_subtotal numeric(12, 2) not null,
  discount_total numeric(12, 2) not null default 0,
  total numeric(12, 2) not null,
  currency char(3) not null default 'PEN',
  notes text,
  reservation_id uuid references public.reservations(id) on delete restrict,
  seller_id uuid,
  seller_label text,
  client_operation_id uuid not null,
  issued_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_amounts_non_negative check (
    gross_subtotal >= 0 and discount_total >= 0 and total >= 0
  ),
  -- Nunca un total negativo.
  constraint sales_total_consistent check (total = gross_subtotal - discount_total),
  constraint sales_currency_pen check (currency = 'PEN'),
  constraint sales_number_unique unique (branch_id, sale_number),
  constraint sales_operation_unique unique (branch_id, client_operation_id)
);

comment on table public.sales is
  'Venta confirmada. Nunca se elimina: la anulación es un registro nuevo (0030).';

-- Una reserva se convierte en UNA sola venta.
create unique index sales_reservation_unique
on public.sales(reservation_id) where reservation_id is not null;

create index sales_branch_issued_idx on public.sales(branch_id, issued_at desc);
create index sales_seller_idx on public.sales(seller_id, issued_at desc);
create index sales_channel_idx on public.sales(source_channel, issued_at desc);

create trigger sales_set_updated_at
before update on public.sales
for each row execute function public.set_updated_at();

-- Lo único que puede cambiar en una venta emitida es su estado y sus notas. Sin
-- esto, la política de UPDATE necesaria para anular en 0030 dejaría reescribir
-- el importe de una venta ya cobrada sin dejar de cuadrar ninguna suma.
create or replace function public.reject_sale_amount_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.branch_id is distinct from old.branch_id
     or new.sale_number is distinct from old.sale_number
     or new.gross_subtotal is distinct from old.gross_subtotal
     or new.discount_total is distinct from old.discount_total
     or new.total is distinct from old.total
     or new.currency is distinct from old.currency
     or new.reservation_id is distinct from old.reservation_id
     or new.issued_at is distinct from old.issued_at
     or new.client_operation_id is distinct from old.client_operation_id then
    raise exception using
      errcode = '23514',
      message = 'Una venta emitida no cambia de importe, sede ni numeración. Corrígela por anulación.';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_sale_amount_mutation() from public, anon;

create trigger sales_amounts_immutable
before update on public.sales
for each row execute function public.reject_sale_amount_mutation();

-- ON DELETE explícito en todo libro histórico, y distinguiendo las DOS clases
-- de referencia, que es lo que el modelo pedía elegir conscientemente:
--
--   · la del DOCUMENTO (sale_id) va en `cascade`, igual que order_items.order_id
--     en 0007. Lo que el modelo prohíbe es vaciar una venta dejando la cabecera
--     con total y cero líneas, y borrar la cabecera entera no produce ese
--     estado. La venta no se borra desde la aplicación —no hay política de
--     delete— así que esta rama solo existe para el mantenimiento con
--     service_role, donde la alternativa `restrict` obliga a un orden de
--     borrado que el trigger diferido de pagos vuelve imposible: al quitar los
--     pagos primero, la venta queda con total y cobranza cero.
--   · la del CATÁLOGO (variant_id) va en `restrict`, más su fotografía textual:
--     ninguna entidad referenciada por un libro histórico se elimina si su
--     eliminación rompe la historia.
create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  variant_id uuid not null references public.product_variants(id) on delete restrict,
  sku text,
  product_name text,
  variant_name text,
  brand_name text,
  quantity integer not null,
  unit_price numeric(12, 2) not null,
  discount_amount numeric(12, 2) not null default 0,
  subtotal numeric(12, 2) not null,
  purchase_mode text not null default 'retail',
  created_at timestamptz not null default now(),
  line_order integer not null default 0,
  constraint sale_lines_quantity_positive check (quantity > 0),
  constraint sale_lines_price_non_negative check (unit_price >= 0),
  constraint sale_lines_discount_non_negative check (discount_amount >= 0),
  constraint sale_lines_subtotal_consistent check (
    subtotal = (quantity * unit_price) - discount_amount and subtotal >= 0
  ),
  constraint sale_lines_purchase_mode check (purchase_mode in ('retail', 'wholesale'))
);

create index sale_lines_sale_idx on public.sale_lines(sale_id, line_order);
create index sale_lines_variant_idx on public.sale_lines(variant_id, created_at desc);

-- Tabla APARTE, y esa es toda la razón de su existencia: la RLS por tabla basta
-- para que la vendedora no vea márgenes, sin permisos por columna, que este
-- repositorio no usa en ningún sitio.
create table public.sale_line_costs (
  sale_line_id uuid primary key references public.sale_lines(id) on delete cascade,
  sale_id uuid not null references public.sales(id) on delete cascade,
  -- Nulo cuando la salida vino de unidades sin costo conocido. NUNCA cero:
  -- un cero produciría un margen del 100 % ficticio.
  unit_cost numeric(16, 6),
  total_cost numeric(16, 6),
  cost_basis public.inventory_cost_basis not null,
  valued_units integer not null default 0,
  unvalued_units integer not null default 0,
  created_at timestamptz not null default now(),
  constraint sale_line_costs_cost_non_negative check (
    (unit_cost is null or unit_cost >= 0) and (total_cost is null or total_cost >= 0)
  ),
  -- Coherencia entre la base declarada y el costo capturado.
  constraint sale_line_costs_basis_consistent check (
    (cost_basis = 'unknown' and unit_cost is null)
    or (cost_basis <> 'unknown' and unit_cost is not null)
  )
);

comment on table public.sale_line_costs is
  'Costo capturado al confirmar la venta. Administrativa: la vendedora obtiene '
  'cero filas. Siempre existe una fila por línea: el margen es NO CALCULABLE '
  'cuando cost_basis = unknown, que es distinto de un margen del 100 %.';

create index sale_line_costs_sale_idx on public.sale_line_costs(sale_id);

create table public.sale_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  method public.payment_method not null,
  -- amount es lo APLICADO a la venta. tendered_amount es lo ENTREGADO en
  -- efectivo. El vuelto es la diferencia y NO se guarda como pago negativo:
  -- contaminaría toda suma de cobranza.
  amount numeric(12, 2) not null,
  tendered_amount numeric(12, 2),
  currency char(3) not null default 'PEN',
  reference text,
  evidence_path text,
  -- received_at es cuándo ENTRÓ el dinero; applied_at cuándo se aplicó a esta
  -- venta. Para un adelanto son fechas distintas, y el arqueo suma por
  -- received_at: sin esa distinción un adelanto de enero reaparecería en el
  -- arqueo de febrero.
  received_at timestamptz not null default now(),
  applied_at timestamptz not null default now(),
  applied_from_reservation_payment_id uuid references public.reservation_payments(id) on delete restrict,
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  constraint sale_payments_amount_positive check (amount > 0),
  constraint sale_payments_currency_pen check (currency = 'PEN'),
  constraint sale_payments_tendered_valid check (
    tendered_amount is null or (method = 'cash' and tendered_amount >= amount)
  ),
  constraint sale_payments_advance_consistent check (
    (method = 'reservation_advance') = (applied_from_reservation_payment_id is not null)
  )
);

comment on column public.sale_payments.tendered_amount is
  'Efectivo entregado por el cliente. El vuelto es tendered_amount - amount.';

-- Un mismo adelanto no puede aplicarse a dos ventas.
create unique index sale_payments_advance_unique
on public.sale_payments(applied_from_reservation_payment_id)
where applied_from_reservation_payment_id is not null;

create index sale_payments_sale_idx on public.sale_payments(sale_id);
create index sale_payments_cash_idx on public.sale_payments(received_at, method);

-- Los pagos aplicados deben sumar EXACTAMENTE el total. «Cubrirlo» admitiría
-- sobrecobro invisible: S/ 100 por una venta de S/ 90 deja S/ 10 que no son
-- vuelto, ni adelanto, ni saldo a favor, y al anular se devolverían 90.
create or replace function public.assert_sale_fully_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_sale_id uuid;
  sale_total numeric(12, 2);
  paid numeric(12, 2);
begin
  -- Ramas explícitas, no un coalesce: plpgsql resuelve TODOS los operandos de
  -- una misma expresión contra el registro real, así que `coalesce(new.id,
  -- new.sale_id)` aborta con «record new has no field sale_id» en cuanto el
  -- trigger cuelga de dos tablas con formas distintas.
  if tg_table_name = 'sales' then
    affected_sale_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    affected_sale_id := case when tg_op = 'DELETE' then old.sale_id else new.sale_id end;
  end if;

  select s.total into sale_total from public.sales s where s.id = affected_sale_id;

  -- La venta ya no existe: no hay invariante que sostener.
  if sale_total is null then
    return null;
  end if;

  select coalesce(sum(p.amount), 0) into paid
  from public.sale_payments p where p.sale_id = affected_sale_id;

  if paid <> sale_total then
    raise exception using
      errcode = '23514',
      message = format('Los pagos aplicados (%s) deben sumar exactamente el total de la venta (%s).',
                       paid, sale_total);
  end if;

  return null;
end;
$$;

revoke all on function public.assert_sale_fully_paid() from public, anon;

-- Declarado también para update y delete: la inmutabilidad del dinero no puede
-- depender de que nadie descubra una ruta de escritura.
create constraint trigger sale_payments_cover_total
after insert or update or delete on public.sale_payments
deferrable initially deferred
for each row execute function public.assert_sale_fully_paid();

create constraint trigger sales_require_payment
after insert or update on public.sales
deferrable initially deferred
for each row execute function public.assert_sale_fully_paid();

-- discount_total se VALIDA como la suma de las líneas, no se declara aparte.
create or replace function public.assert_sale_discount_matches_lines()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_sale_id uuid;
  declared_discount numeric(12, 2);
  declared_gross numeric(12, 2);
  lines_discount numeric(12, 2);
  lines_gross numeric(12, 2);
begin
  if tg_table_name = 'sales' then
    affected_sale_id := case when tg_op = 'DELETE' then old.id else new.id end;
  else
    affected_sale_id := case when tg_op = 'DELETE' then old.sale_id else new.sale_id end;
  end if;

  select s.discount_total, s.gross_subtotal into declared_discount, declared_gross
  from public.sales s where s.id = affected_sale_id;

  if declared_discount is null then
    return null;
  end if;

  select coalesce(sum(l.discount_amount), 0), coalesce(sum(l.quantity * l.unit_price), 0)
    into lines_discount, lines_gross
  from public.sale_lines l where l.sale_id = affected_sale_id;

  if declared_discount <> lines_discount then
    raise exception using
      errcode = '23514',
      message = format('El descuento declarado (%s) no coincide con la suma de las líneas (%s).',
                       declared_discount, lines_discount);
  end if;

  if declared_gross <> lines_gross then
    raise exception using
      errcode = '23514',
      message = format('El importe bruto declarado (%s) no coincide con la suma de las líneas (%s).',
                       declared_gross, lines_gross);
  end if;

  return null;
end;
$$;

revoke all on function public.assert_sale_discount_matches_lines() from public, anon;

create constraint trigger sale_lines_discount_matches
after insert or update or delete on public.sale_lines
deferrable initially deferred
for each row execute function public.assert_sale_discount_matches_lines();

-- También sobre la cabecera: una venta sin ninguna línea no dispararía el
-- trigger anterior y podría declarar un bruto y un descuento inventados.
create constraint trigger sales_discount_matches_lines
after insert or update on public.sales
deferrable initially deferred
for each row execute function public.assert_sale_discount_matches_lines();

-- ---------------------------------------------------------------------------
-- 7. Nota de venta y comprobante tributario
-- ---------------------------------------------------------------------------
-- La nota de venta es la propia venta con su correlativo. El comprobante es
-- otra cosa y otro módulo: la AUSENCIA de fila significa «no solicitado», así
-- que no se crea una fila vacía por venta.

create table public.tax_document_requests (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  kind public.tax_document_kind not null,
  status public.tax_document_status not null default 'requested',
  receiver_tax_id text,
  receiver_name text,
  receiver_address text,
  external_reference text,
  notes text,
  requested_at timestamptz not null default now(),
  resolved_at timestamptz,
  requested_by uuid,
  requested_by_label text,
  constraint tax_document_requests_sale_unique unique (sale_id),
  constraint tax_document_requests_kind_allowed check (kind in ('invoice', 'sales_receipt')),
  -- Una factura exige RUC de once dígitos; una boleta no.
  constraint tax_document_requests_invoice_needs_tax_id check (
    kind <> 'invoice' or (receiver_tax_id ~ '^[0-9]{11}$' and length(trim(coalesce(receiver_name, ''))) > 0)
  )
);

comment on table public.tax_document_requests is
  'Solicitud de comprobante. Nunca bloquea la venta y puede llegar después. '
  'La ausencia de fila representa «no solicitado».';

create index tax_document_requests_status_idx on public.tax_document_requests(status, requested_at desc);

-- ---------------------------------------------------------------------------
-- 8. Prorrateo determinista del descuento
-- ---------------------------------------------------------------------------
-- El residuo de redondeo va a la línea de mayor subtotal y, a igualdad, a la
-- primera del arreglo, que los RPC entregan siempre ordenado por variant_id.
-- Así el resultado es reproducible ejecución tras ejecución.

create or replace function public.prorate_discount(
  p_lines jsonb,
  p_discount_total numeric
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  gross numeric(12, 2) := 0;
  entry jsonb;
  out_lines jsonb := '[]'::jsonb;
  assigned numeric(12, 2) := 0;
  share numeric(12, 2);
  biggest_index integer := 0;
  biggest_value numeric(12, 2) := -1;
  idx integer := 0;
  residual numeric(12, 2);
begin
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return '[]'::jsonb;
  end if;

  for entry in select value from jsonb_array_elements(p_lines) loop
    gross := gross + coalesce((entry ->> 'subtotal')::numeric, 0);
  end loop;

  if coalesce(p_discount_total, 0) <= 0 then
    -- Forma estable de salida: un arreglo de descuentos, siempre, aunque sean
    -- todos cero. Devolver p_lines obligaba a quien llama a distinguir dos
    -- formas distintas del mismo resultado.
    return (
      select coalesce(jsonb_agg(jsonb_build_object('discount', 0::numeric)), '[]'::jsonb)
      from jsonb_array_elements(p_lines)
    );
  end if;

  if gross <= 0 then
    raise exception using errcode = '22023', message = 'No se puede repartir un descuento sobre un importe cero.';
  end if;

  if p_discount_total > gross then
    raise exception using errcode = '22023', message = 'El descuento no puede superar el importe de la venta.';
  end if;

  for entry in select value from jsonb_array_elements(p_lines) loop
    share := round((coalesce((entry ->> 'subtotal')::numeric, 0) / gross) * p_discount_total, 2);
    assigned := assigned + share;

    if coalesce((entry ->> 'subtotal')::numeric, 0) > biggest_value then
      biggest_value := coalesce((entry ->> 'subtotal')::numeric, 0);
      biggest_index := idx;
    end if;

    out_lines := out_lines || jsonb_build_array(jsonb_build_object('discount', share));
    idx := idx + 1;
  end loop;

  residual := p_discount_total - assigned;

  if residual <> 0 then
    out_lines := jsonb_set(
      out_lines,
      array[biggest_index::text, 'discount'],
      to_jsonb(((out_lines -> biggest_index ->> 'discount')::numeric) + residual)
    );
  end if;

  return out_lines;
end;
$$;

revoke all on function public.prorate_discount(jsonb, numeric) from public, anon;

-- ---------------------------------------------------------------------------
-- 9. Registrar una venta
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER: ver la decisión A de la cabecera. La revalidación de sede
-- es explícita y el retorno recorta el costo para quien no es administración.
--
-- ORDEN DE CANDADOS: primero inventory_stock por (variant_id, branch_id),
-- después branch_document_counters. Nunca al revés.

create or replace function public.register_sale(
  p_branch_id uuid,
  p_lines jsonb,
  p_payments jsonb,
  p_client_operation_id uuid,
  p_source_channel public.sale_source_channel default 'in_store',
  p_fulfillment_method public.fulfillment_method default 'in_store',
  p_customer jsonb default null,
  p_discount_total numeric default 0,
  p_notes text default null,
  p_reservation_id uuid default null,
  p_source_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
  actor_max_percent numeric(5, 2);
  actor_max_amount numeric(12, 2);
  existing_id uuid;
  evaluation jsonb;
  line jsonb;
  payment jsonb;
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
    seller_id, seller_label, client_operation_id
  ) values (
    new_sale_id, p_branch_id, sale_number, p_source_channel, p_source_reference, p_fulfillment_method,
    coalesce(nullif(trim(coalesce(p_customer ->> 'name', '')), ''), reservation.customer_name),
    coalesce(nullif(trim(coalesce(p_customer ->> 'phone', '')), ''), reservation.customer_phone),
    coalesce(nullif(trim(coalesce(p_customer ->> 'document', '')), ''), reservation.customer_document),
    nullif(trim(coalesce(p_customer ->> 'address', '')), ''),
    gross, discount_sum, net_total, p_notes, reservation.id,
    actor, actor_name, p_client_operation_id
  );

  -- ------------------------------------------------------------------
  -- 3) LÍNEAS y COSTOS. El costo se captura AHORA, del propio asiento que
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
  -- 4) PAGOS. El adelanto conserva su received_at ORIGINAL para que el arqueo
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

  if paid <> net_total then
    raise exception using errcode = '23514',
      message = format('Los pagos aplicados suman %s y el total de la venta es %s.', paid, net_total);
  end if;

  return public.sale_detail(new_sale_id);
exception
  -- Un 23514 crudo imprime la fila entera en el DETAIL, incluido
  -- average_unit_cost, y src/lib/api/http.ts lo reenvía literalmente al
  -- navegador. Se reemite el mensaje sin el detalle.
  when check_violation then
    raise exception using errcode = '23514', message = sqlerrm;
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Reservas
-- ---------------------------------------------------------------------------

create or replace function public.create_reservation(
  p_branch_id uuid,
  p_lines jsonb,
  p_customer jsonb,
  p_expires_at timestamptz,
  p_client_operation_id uuid,
  p_advance jsonb default null,
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
    expires_at, total, notes, created_by, created_by_label, client_operation_id
  ) values (
    new_id, p_branch_id, reservation_number,
    trim(p_customer ->> 'name'),
    nullif(trim(coalesce(p_customer ->> 'phone', '')), ''),
    nullif(trim(coalesce(p_customer ->> 'document', '')), ''),
    p_expires_at, total, p_notes, actor, actor_name, p_client_operation_id
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
$$;

create or replace function public.release_reservation(
  p_reservation_id uuid,
  p_reason text,
  p_status public.reservation_status default 'released'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.reservations%rowtype;
  line public.reservation_lines%rowtype;
begin
  if p_status not in ('released', 'expired', 'cancelled') then
    raise exception using errcode = '22023', message = 'Estado de liberación no válido.';
  end if;

  -- El permiso se comprueba ANTES de mutar nada.
  select * into reservation from public.reservations where id = p_reservation_id;

  if reservation.id is null then
    raise exception using errcode = '22023', message = 'La reserva no existe.';
  end if;

  perform public.assert_branch_access(reservation.branch_id, 'liberar reservas');

  -- Transición condicional: si otra sesión la convirtió mientras tanto, esta
  -- no encuentra fila y aborta sin tocar inventario.
  update public.reservations
  set status = p_status, released_at = now(), release_reason = p_reason, updated_at = now()
  where id = p_reservation_id and status = 'active'
  returning * into reservation;

  if reservation.id is null then
    raise exception using errcode = '23514', message = 'La reserva ya no está activa.';
  end if;

  for line in
    select * from public.reservation_lines
    where reservation_id = p_reservation_id and reserved_stock
    order by variant_id
  loop
    update public.inventory_stock
    set reserved = greatest(reserved - line.quantity, 0)
    where variant_id = line.variant_id and branch_id = reservation.branch_id;
  end loop;

  return public.reservation_detail(p_reservation_id);
end;
$$;

create or replace function public.release_expired_reservations()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired uuid;
  released integer := 0;
begin
  -- Sin sesión es la tarea programada; con sesión, solo administración.
  if auth.uid() is not null and not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede liberar reservas vencidas.';
  end if;

  for expired in
    select id from public.reservations
    where status = 'active' and expires_at <= now()
    order by id
  loop
    perform public.release_reservation(expired, 'Vencimiento automático', 'expired');
    released := released + 1;
  end loop;

  return released;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Lecturas
-- ---------------------------------------------------------------------------
-- El bloque de costo se recorta por rol de forma EXPLÍCITA además de por RLS:
-- estas funciones se invocan desde dentro de los RPC definer, donde las
-- políticas no se evalúan, así que la RLS sola no bastaría para el retorno de
-- register_sale. Consultadas directamente, las dos guardas coinciden.

create or replace function public.sale_detail(p_sale_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id,
    'saleNumber', s.sale_number,
    'branchId', s.branch_id,
    'branchName', (select b.name from public.branches b where b.id = s.branch_id),
    'status', s.status,
    'sourceChannel', s.source_channel,
    'sourceReference', s.source_reference,
    'fulfillmentMethod', s.fulfillment_method,
    'customerName', s.customer_name,
    'customerPhone', s.customer_phone,
    'customerDocument', s.customer_document,
    'deliveryAddress', s.delivery_address,
    'grossSubtotal', s.gross_subtotal,
    'discountTotal', s.discount_total,
    'total', s.total,
    'currency', s.currency,
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
    'taxDocument', (
      select jsonb_build_object('id', t.id, 'kind', t.kind, 'status', t.status,
                                'receiverTaxId', t.receiver_tax_id, 'receiverName', t.receiver_name,
                                'requestedAt', t.requested_at)
      from public.tax_document_requests t where t.sale_id = s.id
    )
  )
  from public.sales s where s.id = p_sale_id;
$$;

create or replace function public.reservation_detail(p_reservation_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', r.id,
    'reservationNumber', r.reservation_number,
    'branchId', r.branch_id,
    'branchName', (select b.name from public.branches b where b.id = r.branch_id),
    'status', r.status,
    'customerName', r.customer_name,
    'customerPhone', r.customer_phone,
    'customerDocument', r.customer_document,
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
$$;

-- ---------------------------------------------------------------------------
-- 12. Solicitud de comprobante
-- ---------------------------------------------------------------------------

create or replace function public.request_tax_document(
  p_sale_id uuid,
  p_kind public.tax_document_kind,
  p_receiver jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  sale public.sales%rowtype;
begin
  select * into sale from public.sales where id = p_sale_id;

  if sale.id is null then
    raise exception using errcode = '22023', message = 'La venta no existe.';
  end if;

  perform public.assert_branch_access(sale.branch_id, 'solicitar comprobantes');

  insert into public.tax_document_requests (
    sale_id, kind, receiver_tax_id, receiver_name, receiver_address,
    requested_by, requested_by_label
  ) values (
    p_sale_id, p_kind,
    nullif(trim(coalesce(p_receiver ->> 'taxId', '')), ''),
    nullif(trim(coalesce(p_receiver ->> 'name', '')), ''),
    nullif(trim(coalesce(p_receiver ->> 'address', '')), ''),
    auth.uid(),
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = auth.uid())
  )
  on conflict (sale_id) do update set
    kind = excluded.kind,
    status = 'requested',
    receiver_tax_id = excluded.receiver_tax_id,
    receiver_name = excluded.receiver_name,
    receiver_address = excluded.receiver_address,
    requested_at = now(),
    resolved_at = null;

  return public.sale_detail(p_sale_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 13. RLS
-- ---------------------------------------------------------------------------
-- Toda escritura de caja pasa por los RPC. Las políticas de esta sección son
-- de LECTURA salvo donde el modelo exige lo contrario: sin política de insert
-- directo, una vendedora no puede fabricar una venta desde PostgREST saltándose
-- el correlativo, el inventario y la captura de costo.

alter table public.branch_document_counters enable row level security;
alter table public.reservations enable row level security;
alter table public.reservation_lines enable row level security;
alter table public.reservation_payments enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;
alter table public.sale_line_costs enable row level security;
alter table public.sale_payments enable row level security;
alter table public.tax_document_requests enable row level security;

create policy "staff read counters of their branches"
on public.branch_document_counters for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "staff read reservations of their branches"
on public.reservations for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "staff read reservation lines"
on public.reservation_lines for select to authenticated
using (exists (select 1 from public.reservations r
               where r.id = reservation_id and r.branch_id in (select public.staff_branch_ids())));

-- Sin políticas de update ni delete sobre el dinero: toda corrección se hace
-- por reversión registrada.
create policy "staff read reservation payments"
on public.reservation_payments for select to authenticated
using (exists (select 1 from public.reservations r
               where r.id = reservation_id and r.branch_id in (select public.staff_branch_ids())));

create policy "staff read sales of their branches"
on public.sales for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

-- La venta confirmada no se elimina y su importe es inmutable por trigger. La
-- anulación llega en 0030 y solo por su propio contrato, que es definer.
create policy "admins update sales"
on public.sales for update to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy "staff read sale lines"
on public.sale_lines for select to authenticated
using (exists (select 1 from public.sales s
               where s.id = sale_id and s.branch_id in (select public.staff_branch_ids())));

-- COSTOS: solo administración, y solo lectura. La escritura la hace el RPC
-- definer, así que la vendedora no necesita ningún permiso sobre esta tabla.
create policy "admins read sale line costs"
on public.sale_line_costs for select to authenticated
using (public.is_admin());

create policy "staff read sale payments"
on public.sale_payments for select to authenticated
using (exists (select 1 from public.sales s
               where s.id = sale_id and s.branch_id in (select public.staff_branch_ids())));

create policy "staff read tax document requests"
on public.tax_document_requests for select to authenticated
using (exists (select 1 from public.sales s
               where s.id = sale_id and s.branch_id in (select public.staff_branch_ids())));

create policy "admins resolve tax document requests"
on public.tax_document_requests for update to authenticated
using (public.is_admin())
with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 14. Privilegios
-- ---------------------------------------------------------------------------

grant select on public.branch_document_counters to authenticated;
grant select on public.reservations to authenticated;
grant select on public.reservation_lines to authenticated;
grant select on public.reservation_payments to authenticated;
grant select on public.sales to authenticated;
grant select on public.sale_lines to authenticated;
grant select on public.sale_line_costs to authenticated;
grant select on public.sale_payments to authenticated;
grant select, update on public.tax_document_requests to authenticated;

grant select, insert, update, delete on
  public.branch_document_counters, public.reservations, public.reservation_lines,
  public.reservation_payments, public.sales, public.sale_lines,
  public.sale_line_costs, public.sale_payments, public.tax_document_requests
to service_role;

revoke truncate on public.sales, public.sale_lines, public.sale_line_costs,
  public.sale_payments, public.reservations, public.reservation_lines,
  public.reservation_payments, public.branch_document_counters,
  public.tax_document_requests
from anon, authenticated, service_role;

revoke all on function public.register_sale(uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method, jsonb, numeric, text, uuid, text) from public, anon;
revoke all on function public.create_reservation(uuid, jsonb, jsonb, timestamptz, uuid, jsonb, text) from public, anon;
revoke all on function public.release_reservation(uuid, text, public.reservation_status) from public, anon;
revoke all on function public.release_expired_reservations() from public, anon;
revoke all on function public.request_tax_document(uuid, public.tax_document_kind, jsonb) from public, anon;
revoke all on function public.sale_detail(uuid) from public, anon;
revoke all on function public.reservation_detail(uuid) from public, anon;

grant execute on function public.register_sale(uuid, jsonb, jsonb, uuid, public.sale_source_channel, public.fulfillment_method, jsonb, numeric, text, uuid, text) to authenticated, service_role;
grant execute on function public.create_reservation(uuid, jsonb, jsonb, timestamptz, uuid, jsonb, text) to authenticated, service_role;
grant execute on function public.release_reservation(uuid, text, public.reservation_status) to authenticated, service_role;
grant execute on function public.release_expired_reservations() to authenticated, service_role;
grant execute on function public.request_tax_document(uuid, public.tax_document_kind, jsonb) to authenticated, service_role;
grant execute on function public.sale_detail(uuid) to authenticated, service_role;
grant execute on function public.reservation_detail(uuid) to authenticated, service_role;
grant execute on function public.assert_branch_access(uuid, text) to authenticated, service_role;
grant execute on function public.next_document_number(uuid, public.sale_document_kind) to service_role;

-- ---------------------------------------------------------------------------
-- 15. Auditoría
-- ---------------------------------------------------------------------------
-- Cada migración cuelga sus propios triggers: el «bucle de 0025» era un DO de
-- una sola ejecución sobre un arreglo literal, no un event trigger.

select public.attach_audit('public.sales');
select public.attach_audit('public.sale_lines');
select public.attach_audit('public.sale_line_costs');
select public.attach_audit('public.sale_payments');
select public.attach_audit('public.reservations');
select public.attach_audit('public.reservation_lines');
select public.attach_audit('public.reservation_payments');
select public.attach_audit('public.tax_document_requests');
select public.attach_audit('public.branch_document_counters');

-- ---------------------------------------------------------------------------
-- 16. Retiro de `orders`
-- ---------------------------------------------------------------------------
-- Cero filas, nunca desplegada, y conservarla dejaría dos conceptos de venta
-- conviviendo. `sales` la sustituye con más alcance: costos históricos, pagos
-- con recepción y aplicación separadas, reservas y comprobante tributario.

drop function if exists public.create_admin_order(text, text, text, text, text, jsonb, uuid);
drop table if exists public.order_items;
drop table if exists public.orders;

commit;
