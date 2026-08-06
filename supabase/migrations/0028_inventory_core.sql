-- Bloque 2 · Migración 1 de 5 — Inventario, valoración y disponibilidad efectiva.
--
-- Es la pieza que comparten los dos frentes del Bloque 2 y la única sin
-- precedente: hasta ahora no existía ninguna cantidad de existencias en las 46
-- tablas del esquema. Ver docs/bloque-2-modelo.md §3 y su anexo §12.
--
-- Va sola porque toca el catálogo público —la disponibilidad efectiva— y ese es
-- un riesgo propio que conviene poder revertir sin arrastrar la caja.
--
-- CONVENIO DE UNIDADES: todo en este archivo son unidades VENDIBLES. La unidad
-- de compra y su empaque viven en product_suppliers (0027) y solo se traducen a
-- vendibles al recibir mercadería (0031).

begin;

-- ---------------------------------------------------------------------------
-- 0. Tipos
-- ---------------------------------------------------------------------------

create type public.inventory_movement_type as enum (
  'initial_load',
  'sale',
  'sale_cancelled',
  'return_restock',
  'receipt',
  'adjustment',
  'transfer_in',
  'transfer_out'
);

-- Base del costo de una salida. Existe para que 0029 pueda registrar en
-- sale_line_costs si el margen es calculable, y NUNCA convertir un costo
-- desconocido en un costo cero (que produciría un margen del 100 % ficticio).
--   weighted_average  toda la salida se valoró al promedio vigente
--   unknown           toda la salida vino de unidades sin costo conocido
--   mixed             parte de cada fondo
create type public.inventory_cost_basis as enum ('weighted_average', 'unknown', 'mixed');

-- ---------------------------------------------------------------------------
-- 1. tracks_inventory
-- ---------------------------------------------------------------------------
-- NACE EN false PARA TODAS LAS VARIANTES EXISTENTES. Es lo único que impide que
-- aplicar esta migración convierta el catálogo actual en agotado. Se activa
-- exclusivamente al cargar y validar la existencia inicial de cada variante.

alter table public.product_variants
  add column tracks_inventory boolean not null default false;

comment on column public.product_variants.tracks_inventory is
  'Si es true, la disponibilidad pública se resuelve contra las existencias. '
  'Nace en false y solo lo activa load_initial_inventory para las variantes cargadas.';

create index product_variants_tracks_inventory_idx
on public.product_variants(id) where tracks_inventory;

-- ---------------------------------------------------------------------------
-- 2. Saldo de existencias
-- ---------------------------------------------------------------------------

create table public.inventory_stock (
  variant_id uuid not null references public.product_variants(id),
  branch_id uuid not null references public.branches(id),
  on_hand integer not null default 0,
  reserved integer not null default 0,
  available_quantity integer generated always as (on_hand - reserved) stored,
  updated_at timestamptz not null default now(),
  primary key (variant_id, branch_id),
  constraint inventory_stock_on_hand_non_negative check (on_hand >= 0),
  constraint inventory_stock_reserved_non_negative check (reserved >= 0),
  -- Una reserva compromete existencia que debe existir. Sin esto, liberar una
  -- reserva dejaría un disponible mayor que la existencia real.
  constraint inventory_stock_reserved_within_on_hand check (reserved <= on_hand)
);

comment on table public.inventory_stock is
  'Saldo por variante y sede. Es también el punto de serialización del Bloque 2: '
  'toda operación que toque existencias garantiza primero la fila con un upsert '
  'y después bloquea con for update ordenado por (variant_id, branch_id).';

create index inventory_stock_branch_idx on public.inventory_stock(branch_id);
create index inventory_stock_available_idx
on public.inventory_stock(variant_id) where available_quantity > 0;

create trigger inventory_stock_set_updated_at
before update on public.inventory_stock
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Kardex
-- ---------------------------------------------------------------------------
-- De solo adición y VALORIZADO: sin las columnas monetarias no podría
-- reconstruirse el promedio ni auditarse la valoración contra el dinero
-- realmente desembolsado.

create table public.inventory_movements (
  id bigint generated always as identity primary key,
  -- Integridad referencial SÍ, porque variantes y sedes se desactivan, no se
  -- borran. Ver docs/bloque-2-modelo.md §3: la regla de 0026 no generaliza.
  variant_id uuid not null references public.product_variants(id),
  branch_id uuid not null references public.branches(id),
  -- Fotografía legible: la operación debe seguir entendiéndose aunque cambien
  -- el nombre o el SKU de la variante.
  variant_sku text,
  variant_label text,
  branch_label text,
  movement_type public.inventory_movement_type not null,
  quantity integer not null,
  balance_after integer not null,
  -- Cara monetaria. Permite un kardex valorizado y hace de total_value un dato
  -- reconstruible en lugar de un acumulador ciego.
  unit_cost numeric(16, 6),
  value_delta numeric(16, 6) not null default 0,
  value_after numeric(16, 6) not null default 0,
  cost_basis public.inventory_cost_basis,
  -- Desglose de la salida entre los dos fondos. Sin él no puede auditarse por
  -- qué una venta quedó con costo desconocido.
  valued_units integer not null default 0,
  unvalued_units integer not null default 0,
  -- Origen polimórfico: sin FK por construcción, con etiqueta legible.
  source_type text,
  source_id uuid,
  source_label text,
  -- El actor sí se borra: identificador suelto más etiqueta.
  actor_id uuid,
  actor_label text,
  reason text,
  -- clock_timestamp() y no now(): con el candado retenido durante todo el RPC,
  -- now() da el mismo instante a todos los asientos y el kardex leído en orden
  -- cronológico muestra saldos fuera de secuencia. El orden autoritativo es `id`.
  occurred_at timestamptz not null default clock_timestamp(),
  constraint inventory_movements_quantity_not_zero check (quantity <> 0),
  constraint inventory_movements_balance_non_negative check (balance_after >= 0),
  constraint inventory_movements_unit_cost_non_negative check (unit_cost is null or unit_cost >= 0),
  constraint inventory_movements_value_after_non_negative check (value_after >= 0)
);

comment on table public.inventory_movements is
  'Kardex valorizado, de solo adición. El orden autoritativo es id, no occurred_at.';

create index inventory_movements_ledger_idx
on public.inventory_movements(variant_id, branch_id, id);
create index inventory_movements_branch_idx
on public.inventory_movements(branch_id, id desc);
create index inventory_movements_source_idx
on public.inventory_movements(source_type, source_id) where source_id is not null;

-- Solo adición: se rechaza el UPDATE. El DELETE se permite, siguiendo el
-- precedente de supplier_cost_agreements (0027): reescribir un importe es
-- silencioso y corrompe la historia; borrar es explícito y queda en la bitácora.
-- Además es lo que mantiene limpiable el entorno de prueba.
create trigger inventory_movements_no_update
before update on public.inventory_movements
for each row execute function public.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- 4. Valoración
-- ---------------------------------------------------------------------------
-- Promedio ponderado por variante y sede. El VALOR TOTAL es la fuente de verdad
-- y el promedio una columna generada: acumular sobre el promedio ya redondeado
-- produce una deriva sin cota (S/ 0,48 en 200 ciclos; más de S/ 3.000 a escala
-- de 2 decimales en 4.000 movimientos).
--
-- quantity_valued cuenta SOLO las unidades con costo conocido, y puede ser menor
-- que inventory_stock.on_hand. La diferencia son unidades sin valorar: una carga
-- inicial sin costo no inventa un promedio.

create table public.inventory_valuation (
  variant_id uuid not null references public.product_variants(id),
  branch_id uuid not null references public.branches(id),
  quantity_valued integer not null default 0,
  total_value numeric(16, 6) not null default 0,
  average_unit_cost numeric(16, 6) generated always as (
    case when quantity_valued > 0 then total_value / quantity_valued end
  ) stored,
  currency char(3) not null default 'PEN',
  updated_at timestamptz not null default now(),
  primary key (variant_id, branch_id),
  constraint inventory_valuation_quantity_non_negative check (quantity_valued >= 0),
  constraint inventory_valuation_value_non_negative check (total_value >= 0),
  constraint inventory_valuation_currency_format check (currency ~ '^[A-Z]{3}$'),
  -- Si la existencia valorada llega a cero, el valor debe llegar a cero exacto.
  -- Un residuo de redondeo contaminaría el promedio de la siguiente recepción y
  -- se propagaría indefinidamente.
  constraint inventory_valuation_zero_is_total check (
    (quantity_valued = 0) = (total_value = 0)
  )
);

comment on table public.inventory_valuation is
  'Costo de la mercadería por variante y sede. Administrativa: la vendedora '
  'obtiene cero filas. total_value es autoritativo; average_unit_cost es derivado.';

create trigger inventory_valuation_set_updated_at
before update on public.inventory_valuation
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Auditoría: mecanismo reutilizable y tolerante
-- ---------------------------------------------------------------------------
-- El "bucle de 0025" era un do $$ de una sola ejecución sobre un arreglo
-- literal, no un event trigger: cada migración debe colgar sus propios triggers.
-- attach_audit lo vuelve idempotente y una prueba pgTAP comprueba la cobertura.

alter table public.audit_log
  add column if not exists record_key text,
  add column if not exists branch_label text;

comment on column public.audit_log.record_key is
  'Identidad del registro cuando la tabla no tiene una columna id uuid '
  '(clave compuesta o identity bigint). Complementa a record_id, no lo sustituye.';

-- record_audit castea el id a uuid. Con una tabla de clave compuesta o de
-- identity bigint eso aborta con 22P02 y haría fallar TODO insert de la tabla
-- auditada. Se vuelve tolerante y se toma la sede de la propia fila cuando
-- existe, en vez de deducirla siempre del actor.
create or replace function public.record_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_app_role public.app_role;
  actor_name text;
  actor_branch_id uuid;
  affected_record_id uuid;
  affected_record_key text;
  old_json jsonb;
  new_json jsonb;
  changed text[];
  row_json jsonb;
begin
  select p.role, nullif(trim(coalesce(p.full_name, '')), '')
    into actor_app_role, actor_name
  from public.admin_profiles p
  where p.id = actor;

  if actor is not null and actor_name is null then
    select u.email into actor_name from auth.users u where u.id = actor;
  end if;

  if tg_op = 'DELETE' then
    old_json := to_jsonb(old) - 'search_document';
  elsif tg_op = 'INSERT' then
    new_json := to_jsonb(new) - 'search_document';
  else
    old_json := to_jsonb(old) - 'search_document';
    new_json := to_jsonb(new) - 'search_document';

    select array_agg(entry.key order by entry.key) into changed
    from jsonb_each(new_json) entry
    where entry.value is distinct from (old_json -> entry.key)
      and entry.key <> 'updated_at';

    -- Un updated_at que se mueve solo no es un cambio que auditar.
    if changed is null then
      return null;
    end if;
  end if;

  row_json := coalesce(new_json, old_json);

  -- Tolerante: solo castea cuando el valor es realmente un uuid.
  affected_record_id := case
    when (row_json ->> 'id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (row_json ->> 'id')::uuid
  end;

  affected_record_key := coalesce(
    row_json ->> 'id',
    nullif(concat_ws('|', row_json ->> 'variant_id', row_json ->> 'branch_id'), '')
  );

  -- La sede de la fila manda sobre la del actor: una operación multi-sede no
  -- puede atribuirse entera a la sede principal de quien la ejecuta.
  actor_branch_id := coalesce(
    case when (row_json ->> 'branch_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (row_json ->> 'branch_id')::uuid end,
    public.default_branch_id(actor)
  );

  insert into public.audit_log (
    actor_id, actor_role, actor_label, branch_id, branch_label,
    table_name, record_id, record_key,
    action, changed_fields, old_values, new_values
  ) values (
    actor, actor_app_role, actor_name, actor_branch_id,
    (select b.name from public.branches b where b.id = actor_branch_id),
    tg_table_name, affected_record_id, affected_record_key,
    lower(tg_op), changed, old_json, new_json
  );

  return null;
end;
$$;

revoke all on function public.record_audit() from public;

create or replace function public.attach_audit(p_table regclass)
returns void
language plpgsql
set search_path = ''
as $$
declare
  trigger_name text := 'audit_' || (
    select c.relname from pg_class c where c.oid = p_table
  );
begin
  if not exists (
    select 1 from pg_trigger t
    where t.tgrelid = p_table and t.tgname = trigger_name and not t.tgisinternal
  ) then
    execute format(
      'create trigger %I after insert or update or delete on %s
       for each row execute function public.record_audit()',
      trigger_name, p_table::text
    );
  end if;
end;
$$;

comment on function public.attach_audit(regclass) is
  'Cuelga el trigger de auditoría de forma idempotente. Cada migración invoca '
  'esta función para sus tablas de dinero y decisiones.';

revoke all on function public.attach_audit(regclass) from public;

-- inventory_valuation es dinero y se audita.
-- inventory_stock queda FUERA: es saldo derivado cuyo histórico es el kardex, y
-- auditarlo alargaría la sección crítica del candado más contendido del sistema.
-- inventory_movements queda FUERA: ya es un libro de solo adición por diseño.
select public.attach_audit('public.inventory_valuation');

-- Hueco heredado de 0027: una tasa cambia la deuda reportada y no dejaba rastro.
select public.attach_audit('public.exchange_rates');

-- ---------------------------------------------------------------------------
-- 6. Disponibilidad efectiva
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER obligatorio: catalog_list_v2, catalog_product_detail_v2 y
-- evaluate_cart_v2 son SECURITY INVOKER y las invoca anon, que leería cero filas
-- de inventory_stock. Es el patrón de is_public_catalog_variant.
--
-- Devuelve ÚNICAMENTE el enum, nunca la cantidad: al público no se le muestra
-- cuántas unidades quedan.

create or replace function public.variant_effective_availability(
  p_variant_id uuid,
  p_branch_id uuid default null
)
returns public.product_availability
language sql
stable
security definer
set search_path = ''
as $$
  select case
    -- 1. Consultar manda siempre, sin mirar el inventario.
    when v.availability_status = 'consult' then 'consult'::public.product_availability
    -- 2. El agotado editorial manda aunque haya existencias.
    when v.availability_status = 'sold_out' then 'sold_out'::public.product_availability
    -- 3. Con seguimiento activo y sin disponible, agotado automático.
    when v.availability_status = 'available'
     and v.tracks_inventory
     and coalesce((
       select sum(s.available_quantity)
       from public.inventory_stock s
       join public.branches b on b.id = s.branch_id and b.is_active
       where s.variant_id = v.id
         and (p_branch_id is null or s.branch_id = p_branch_id)
     ), 0) <= 0
      then 'sold_out'::public.product_availability
    -- 4. Cierre: cualquier otro caso conserva el estado editorial.
    else v.availability_status
  end
  from public.product_variants v
  where v.id = p_variant_id;
$$;

comment on function public.variant_effective_availability(uuid, uuid) is
  'Disponibilidad publicable de una variante. Sin sede agrega sobre las sedes '
  'activas y el par ausente cuenta como cero. Nunca devuelve cantidades.';

revoke all on function public.variant_effective_availability(uuid, uuid) from public;
grant execute on function public.variant_effective_availability(uuid, uuid)
to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Punto único de escritura
-- ---------------------------------------------------------------------------

create or replace function public.apply_inventory_movement(
  p_variant_id uuid,
  p_branch_id uuid,
  p_movement_type public.inventory_movement_type,
  p_quantity integer,
  p_unit_cost numeric default null,
  p_source_type text default null,
  p_source_id uuid default null,
  p_source_label text default null,
  p_reason text default null,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  stock public.inventory_stock%rowtype;
  valuation public.inventory_valuation%rowtype;
  actor uuid := coalesce(p_actor_id, auth.uid());
  actor_name text;
  new_balance integer;
  value_change numeric(16, 6) := 0;
  applied_unit_cost numeric(16, 6);
  movement_id bigint;
  units_out integer := 0;
  current_valued integer := 0;
  unvalued_pool integer := 0;
  from_valued integer := 0;
  from_unvalued integer := 0;
  valued_delta integer := 0;
  basis public.inventory_cost_basis;
begin
  if p_quantity = 0 then
    raise exception using errcode = '22023', message = 'Un movimiento de inventario no puede ser de cero unidades.';
  end if;

  -- Primer contacto: UPSERT, no FOR UPDATE. Un for update sobre un par
  -- (variante, sede) inexistente bloquea cero filas y no serializa nada, de modo
  -- que dos ventas simultáneas de la primera unidad se pisarían.
  insert into public.inventory_stock as s (variant_id, branch_id, on_hand, reserved)
  values (p_variant_id, p_branch_id, 0, 0)
  on conflict (variant_id, branch_id)
    do update set updated_at = s.updated_at
  returning * into stock;

  -- A partir de aquí la fila existe y el candado es real.
  select * into stock
  from public.inventory_stock
  where variant_id = p_variant_id and branch_id = p_branch_id
  for update;

  new_balance := stock.on_hand + p_quantity;

  if new_balance < 0 then
    raise exception using
      errcode = '23514',
      message = format('No hay existencias suficientes: hay %s y se intentan retirar %s.',
                       stock.on_hand, abs(p_quantity));
  end if;

  if new_balance < stock.reserved then
    raise exception using
      errcode = '23514',
      message = format('No se puede dejar la existencia en %s: hay %s unidades reservadas.',
                       new_balance, stock.reserved);
  end if;

  -- Valoración. Se toma el candado de la fila de existencias antes de tocarla,
  -- de modo que una imputación de gasto y una recepción concurrentes no pierdan
  -- una de las dos actualizaciones del promedio bajo READ COMMITTED.
  select * into valuation
  from public.inventory_valuation
  where variant_id = p_variant_id and branch_id = p_branch_id
  for update;

  current_valued := coalesce(valuation.quantity_valued, 0);

  if p_quantity > 0 then
    -- ENTRADA. Sin costo conocido las unidades entran SIN VALORAR: no se inventa
    -- un promedio ni se finge que costaron cero.
    if p_unit_cost is not null then
      applied_unit_cost := p_unit_cost;
      value_change := p_quantity * p_unit_cost;
      valued_delta := p_quantity;
      from_valued := p_quantity;
      basis := 'weighted_average';
    else
      from_unvalued := p_quantity;
      basis := 'unknown';
    end if;
  else
    -- SALIDA. Regla determinista del bloque: se consumen PRIMERO las unidades
    -- sin valorar. Vienen de la toma física inicial, es decir de mercadería
    -- anterior al sistema, así que agotarlas primero es lo cronológicamente
    -- honesto y conserva intacto el fondo valorado el mayor tiempo posible.
    -- La alternativa dejaría una cola permanente de unidades sin costo
    -- produciendo márgenes no calculables para siempre.
    units_out := abs(p_quantity);
    unvalued_pool := greatest(stock.on_hand - current_valued, 0);
    from_unvalued := least(units_out, unvalued_pool);
    from_valued := units_out - from_unvalued;

    if from_valued > 0 and current_valued > 0 then
      applied_unit_cost := valuation.total_value / current_valued;
      valued_delta := -1 * from_valued;

      if from_valued >= current_valued then
        -- La salida se lleva el fondo valorado entero: el valor sale EXACTO.
        -- Calcularlo como cantidad × promedio dejaría un residuo de redondeo
        -- —comprobado: 0.000140 sobre un fondo que debía quedar en cero— que el
        -- check (quantity_valued = 0) = (total_value = 0) rechaza, y que si se
        -- colara contaminaría el promedio de la siguiente entrada para siempre.
        value_change := -1 * valuation.total_value;
      else
        value_change := -1 * from_valued * applied_unit_cost;
      end if;
    end if;

    basis := case
      when from_valued = 0 then 'unknown'::public.inventory_cost_basis
      when from_unvalued = 0 then 'weighted_average'::public.inventory_cost_basis
      else 'mixed'::public.inventory_cost_basis
    end;
  end if;

  if valued_delta <> 0 then
    insert into public.inventory_valuation as v (
      variant_id, branch_id, quantity_valued, total_value
    ) values (
      p_variant_id, p_branch_id,
      greatest(valued_delta, 0),
      greatest(value_change, 0)
    )
    on conflict (variant_id, branch_id) do update set
      quantity_valued = v.quantity_valued + valued_delta,
      total_value = v.total_value + value_change,
      updated_at = now()
    returning * into valuation;

    -- Si la existencia valorada llegó a cero, el valor se fuerza a cero exacto.
    -- Un residuo de redondeo contaminaría el promedio de la siguiente entrada y
    -- se propagaría indefinidamente.
    if valuation.quantity_valued = 0 and valuation.total_value <> 0 then
      update public.inventory_valuation
      set total_value = 0
      where variant_id = p_variant_id and branch_id = p_branch_id
      returning * into valuation;
    end if;
  end if;

  update public.inventory_stock
  set on_hand = new_balance
  where variant_id = p_variant_id and branch_id = p_branch_id;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  insert into public.inventory_movements (
    variant_id, branch_id, variant_sku, variant_label, branch_label,
    movement_type, quantity, balance_after,
    unit_cost, value_delta, value_after,
    cost_basis, valued_units, unvalued_units,
    source_type, source_id, source_label,
    actor_id, actor_label, reason
  )
  select
    p_variant_id, p_branch_id, v.sku, v.name, b.name,
    p_movement_type, p_quantity, new_balance,
    applied_unit_cost, value_change, coalesce(valuation.total_value, 0),
    basis, from_valued, from_unvalued,
    p_source_type, p_source_id, p_source_label,
    actor, actor_name, p_reason
  from public.product_variants v
  cross join public.branches b
  where v.id = p_variant_id and b.id = p_branch_id
  returning id into movement_id;

  -- Devuelve la base del costo para que 0029 la registre en sale_line_costs sin
  -- volver a consultar la valoración —que además no podría leer si el RPC
  -- llamador corre como vendedora—.
  return jsonb_build_object(
    'movementId', movement_id,
    'balanceAfter', new_balance,
    'unitCost', applied_unit_cost,
    'valueDelta', value_change,
    'valueAfter', coalesce(valuation.total_value, 0),
    'costBasis', basis,
    'valuedUnits', from_valued,
    'unvaluedUnits', from_unvalued
  );
end;
$$;

revoke all on function public.apply_inventory_movement(
  uuid, uuid, public.inventory_movement_type, integer, numeric, text, uuid, text, text, uuid
) from public;

-- ---------------------------------------------------------------------------
-- 8. Ajuste con motivo obligatorio
-- ---------------------------------------------------------------------------

create or replace function public.adjust_inventory(
  p_variant_id uuid,
  p_branch_id uuid,
  p_quantity integer,
  p_reason text,
  p_unit_cost numeric default null
)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede ajustar existencias.';
  end if;

  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'Un ajuste de inventario exige un motivo.';
  end if;

  return public.apply_inventory_movement(
    p_variant_id, p_branch_id, 'adjustment', p_quantity, p_unit_cost,
    'adjustment', null, 'Ajuste manual', p_reason
  );
end;
$$;

revoke all on function public.adjust_inventory(uuid, uuid, integer, text, numeric) from public;
grant execute on function public.adjust_inventory(uuid, uuid, integer, text, numeric)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 9. Carga inicial
-- ---------------------------------------------------------------------------
-- Toma física masiva, no simulación de recepciones. Modo previsualización y
-- confirmación atómica. Activa tracks_inventory SOLO para lo cargado.

create or replace function public.load_initial_inventory(
  p_rows jsonb,
  p_mode text default 'preview',
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
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
  if not public.is_admin() then
    raise exception using errcode = '42501', message = 'Solo administración puede cargar la existencia inicial.';
  end if;

  if p_mode not in ('preview', 'commit') then
    raise exception using errcode = '22023', message = 'El modo debe ser preview o commit.';
  end if;

  -- La carga inicial suele ejecutarse desde un script con service_role, donde
  -- auth.uid() es nulo. Sin actor explícito el kardex quedaría sin responsable.
  if actor is null then
    raise exception using errcode = '22023',
      message = 'La carga inicial exige un actor explícito cuando no hay sesión.';
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

      update public.product_variants
      set tracks_inventory = true
      where id = (entry ->> 'variantId')::uuid;
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

revoke all on function public.load_initial_inventory(jsonb, text, uuid) from public;
grant execute on function public.load_initial_inventory(jsonb, text, uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 10. El borrado de una variante con historia falla legiblemente
-- ---------------------------------------------------------------------------
-- Sin esto, las rutas de borrado revientan con un 23503 crudo que nombra
-- product_variants y no dice cuál ni por qué.

create or replace function public.reject_variant_delete_with_history()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if exists (select 1 from public.inventory_movements where variant_id = old.id) then
    raise exception using
      errcode = '23503',
      message = format(
        'La presentación %s tiene movimientos de inventario y no puede eliminarse. Desactívala.',
        coalesce(old.sku, old.name, old.id::text)
      );
  end if;

  return old;
end;
$$;

revoke all on function public.reject_variant_delete_with_history() from public;

create trigger product_variants_block_delete_with_history
before delete on public.product_variants
for each row execute function public.reject_variant_delete_with_history();

-- ---------------------------------------------------------------------------
-- 11. Vista de posición
-- ---------------------------------------------------------------------------
-- security_invoker obligatorio: sin él la vista corre como su propietario y
-- publicaría la valoración entera a cualquier authenticated.

create or replace view public.inventory_position
with (security_invoker = true)
as
select
  s.variant_id,
  s.branch_id,
  s.on_hand,
  s.reserved,
  s.available_quantity,
  v.quantity_valued,
  s.on_hand - coalesce(v.quantity_valued, 0) as unvalued_quantity,
  v.total_value,
  v.average_unit_cost,
  v.currency
from public.inventory_stock s
left join public.inventory_valuation v
  on v.variant_id = s.variant_id and v.branch_id = s.branch_id;

comment on view public.inventory_position is
  'Existencias con su valoración. security_invoker: la vendedora ve las '
  'cantidades y recibe nulos en las columnas de valor por la RLS de la tabla base.';

-- Reemplazo directo de `from product_variants` para todo consumidor que
-- necesite la disponibilidad publicable de una variante. Existe porque el
-- generador de PDF leía availability_status crudo y habría listado como
-- disponible una variante que el catálogo público ya daba por agotada.
create or replace view public.variant_public_availability
with (security_invoker = true)
as
select
  v.id,
  v.product_id,
  v.sku,
  v.name,
  v.sort_order,
  v.is_active,
  v.tracks_inventory,
  public.variant_effective_availability(v.id) as availability
from public.product_variants v;

comment on view public.variant_public_availability is
  'Variantes con su disponibilidad efectiva. Sustituye a la lectura directa de '
  'availability_status en cualquier salida comercial.';

-- ---------------------------------------------------------------------------
-- 12. RLS
-- ---------------------------------------------------------------------------

alter table public.inventory_stock enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.inventory_valuation enable row level security;

-- Existencias: el personal ve las de sus sedes; administración, todas.
create policy "staff read stock of their branches"
on public.inventory_stock for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "admins manage stock"
on public.inventory_stock for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "staff read movements of their branches"
on public.inventory_movements for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "admins manage movements"
on public.inventory_movements for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Valoración: es costo. Solo administración, sin excepciones.
create policy "admins manage valuation"
on public.inventory_valuation for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- El público nunca lee existencias: su disponibilidad sale del objeto DEFINER.
grant select on public.inventory_stock to authenticated;
grant select on public.inventory_movements to authenticated;
grant select, insert, update, delete on public.inventory_stock to authenticated, service_role;
grant select, insert, delete on public.inventory_movements to authenticated, service_role;
grant select, insert, update, delete on public.inventory_valuation to authenticated, service_role;
grant select on public.inventory_position to authenticated;
grant select on public.variant_public_availability to anon, authenticated, service_role;

-- Defensa en profundidad: el ACL por defecto de Supabase concede TRUNCATE.
revoke truncate on public.inventory_stock from anon, authenticated, service_role;
revoke truncate on public.inventory_movements from anon, authenticated, service_role;
revoke truncate on public.inventory_valuation from anon, authenticated, service_role;
revoke truncate on public.audit_log from anon, authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 13. El catálogo consume la disponibilidad efectiva
-- ---------------------------------------------------------------------------
-- Sin esta sección variant_effective_availability existiría sin que nadie la
-- use: el catálogo seguiría leyendo el estado editorial crudo y una variante
-- con seguimiento y cero unidades se anunciaría como disponible.
--
-- Las tres funciones se recrean desde 0006 con la sustitución aplicada. En
-- evaluate_cart_v2 basta sustituir en el ORIGEN del CTE: las referencias
-- posteriores a line.availability_status heredan el valor efectivo, de modo que
-- el precio firme, el estado de consulta y el rechazo de agotado quedan
-- alineados con lo que ve el catálogo público.
--
-- Puntos sustituidos: 5 en catalog_list_v2 (filtro de p_availability,
-- las tres cuentas de availabilitySummary y featuredVariant), 1 en
-- catalog_product_detail_v2 y 1 en evaluate_cart_v2.

create or replace function public.catalog_list_v2(
  p_page integer default 1,
  p_page_size integer default 24,
  p_search text default null,
  p_brand_slug text default null,
  p_category_path text default null,
  p_availability public.product_availability default null,
  p_attribute_filters jsonb default '{}'::jsonb,
  p_sort text default 'featured'
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  safe_page integer := greatest(coalesce(p_page, 1), 1);
  safe_page_size integer := least(greatest(coalesce(p_page_size, 24), 1), 100);
  safe_filters jsonb := coalesce(p_attribute_filters, '{}'::jsonb);
  result jsonb;
begin
  if jsonb_typeof(safe_filters) <> 'object' then
    raise exception using errcode = '22023', message = 'attribute_filters debe ser un objeto JSON.';
  end if;

  if coalesce(p_sort, 'featured') not in ('featured', 'name_asc', 'name_desc', 'price_asc', 'price_desc') then
    raise exception using errcode = '22023', message = 'Orden de catálogo no permitido.';
  end if;

  with recursive
  selected_category as (
    select path.id
    from public.category_paths path
    where p_category_path is not null
      and (path.canonical_path = p_category_path or path.slug = p_category_path)
    order by (path.canonical_path = p_category_path) desc
    limit 1
  ),
  category_scope as (
    select id from selected_category
    union all
    select child.id
    from public.categories child
    join category_scope parent on child.parent_id = parent.id
    where child.is_active
  ),
  filtered_products as materialized (
    select product.id
    from public.products product
    join public.brands brand on brand.id = product.brand_id
    where product.is_active
      and product.editorial_status = 'published'
      and (p_brand_slug is null or brand.slug = p_brand_slug)
      and (
        p_category_path is null
        or product.category_id in (select id from category_scope)
      )
      and (
        p_availability is null
        or exists (
          select 1
          from public.product_variants variant
          where variant.product_id = product.id
            and variant.is_active
            and public.variant_effective_availability(variant.id) = p_availability
        )
      )
      and (
        nullif(trim(coalesce(p_search, '')), '') is null
        or product.search_document @@ websearch_to_tsquery('simple', trim(p_search))
        or product.name operator(public.%) trim(p_search)
        or exists (
          select 1
          from public.product_variants variant
          where variant.product_id = product.id
            and variant.is_active
            and (
              variant.sku ilike '%' || trim(p_search) || '%'
              or variant.name ilike '%' || trim(p_search) || '%'
            )
        )
      )
      and not exists (
        select 1
        from jsonb_each(safe_filters) requested(code, values_json)
        join public.attribute_definitions definition
          on definition.code = requested.code
         and definition.is_active
         and definition.is_filterable
        where jsonb_typeof(requested.values_json) <> 'array'
           or not exists (
             select 1
             from public.product_attribute_values product_value
             join public.attribute_options option
               on option.id = product_value.option_id
             where product_value.product_id = product.id
               and product_value.attribute_definition_id = definition.id
               and option.value in (
                 select jsonb_array_elements_text(requested.values_json)
               )
             union all
             select 1
             from public.product_variants variant
             join public.variant_attribute_values variant_value
               on variant_value.variant_id = variant.id
             join public.attribute_options option
               on option.id = variant_value.option_id
             where variant.product_id = product.id
               and variant.is_active
               and variant_value.attribute_definition_id = definition.id
               and option.value in (
                 select jsonb_array_elements_text(requested.values_json)
               )
           )
      )
  ),
  card_rows as materialized (
    select
      product.id as product_id,
      product.slug,
      product.name,
      product.is_featured,
      product.sort_order,
      jsonb_build_object(
        'id', brand.id,
        'name', brand.name,
        'slug', brand.slug
      ) as brand,
      jsonb_build_object(
        'id', category.id,
        'name', category.name,
        'slug', category.slug,
        'path', category_path.canonical_path
      ) as category,
      product_image.storage_path as main_image,
      pricing.starting_price,
      jsonb_build_object(
        'min', pricing.starting_price,
        'max', pricing.maximum_price,
        'currency', 'PEN'
      ) as price_range,
      availability.summary as availability_summary,
      variants.variant_count > 1 as has_multiple_variants,
      featured.variant as featured_variant
    from filtered_products filtered
    join public.products product on product.id = filtered.id
    join public.brands brand on brand.id = product.brand_id
    join public.categories category on category.id = product.category_id
    left join public.category_paths category_path on category_path.id = category.id
    left join lateral (
      select media.storage_path
      from public.product_media association
      join public.media_assets media on media.id = association.media_asset_id
      where association.product_id = product.id
        and association.media_role = 'main'
      order by association.is_primary desc, association.sort_order, association.id
      limit 1
    ) product_image on true
    cross join lateral (
      select count(*)::integer as variant_count
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ) variants
    cross join lateral (
      select min(price.amount) as starting_price, max(price.amount) as maximum_price
      from public.product_variants variant
      join public.variant_prices price on price.variant_id = variant.id
      join public.price_lists price_list on price_list.id = price.price_list_id
      where variant.product_id = product.id
        and variant.is_active
        and price.is_active
        and price.validity @> now()
        and price_list.is_active
        and price_list.is_public
        and price_list.price_type = 'retail'
    ) pricing
    cross join lateral (
      select jsonb_build_object(
        'available', count(*) filter (where public.variant_effective_availability(variant.id) = 'available'),
        'soldOut', count(*) filter (where public.variant_effective_availability(variant.id) = 'sold_out'),
        'consult', count(*) filter (where public.variant_effective_availability(variant.id) = 'consult')
      ) as summary
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ) availability
    left join lateral (
      select jsonb_build_object(
        'id', variant.id,
        'sku', variant.sku,
        'name', variant.name,
        'availability', public.variant_effective_availability(variant.id),
        'price', (
          select price.amount
          from public.variant_prices price
          join public.price_lists price_list on price_list.id = price.price_list_id
          where price.variant_id = variant.id
            and price.is_active
            and price.validity @> now()
            and price_list.is_active
            and price_list.is_public
            and price_list.price_type = 'retail'
          order by price_list.priority desc, price.amount
          limit 1
        ),
        'image', coalesce(
          (
            select media.storage_path
            from public.product_media association
            join public.media_assets media on media.id = association.media_asset_id
            where association.variant_id = variant.id
            order by association.is_primary desc, association.sort_order, association.id
            limit 1
          ),
          product_image.storage_path
        )
      ) as variant
      from public.product_variants variant
      where variant.product_id = product.id
        and variant.is_active
      order by variant.is_default desc, variant.sort_order, variant.id
      limit 1
    ) featured on true
  ),
  ordered_cards as materialized (
    select *
    from card_rows card
    order by
      case when p_sort = 'featured' then card.is_featured end desc,
      case when p_sort = 'featured' then card.sort_order end asc,
      case when p_sort = 'name_asc' then lower(card.name) end asc,
      case when p_sort = 'name_desc' then lower(card.name) end desc,
      case when p_sort = 'price_asc' then card.starting_price end asc nulls last,
      case when p_sort = 'price_desc' then card.starting_price end desc nulls last,
      lower(card.name),
      card.product_id
  ),
  paged_cards as (
    select *
    from ordered_cards
    offset (safe_page - 1) * safe_page_size
    limit safe_page_size
  ),
  available_filter_rows as (
    select distinct
      definition.id,
      definition.code,
      definition.name,
      definition.data_type,
      definition.sort_order
    from public.attribute_definitions definition
    where definition.is_active
      and definition.is_filterable
      and exists (
        select 1
        from public.product_attribute_values value
        join filtered_products filtered on filtered.id = value.product_id
        where value.attribute_definition_id = definition.id
        union all
        select 1
        from public.variant_attribute_values value
        join public.product_variants variant on variant.id = value.variant_id and variant.is_active
        join filtered_products filtered on filtered.id = variant.product_id
        where value.attribute_definition_id = definition.id
      )
  )
  select jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'productId', card.product_id,
          'slug', card.slug,
          'name', card.name,
          'brand', card.brand,
          'category', card.category,
          'mainImage', card.main_image,
          'startingPrice', card.starting_price,
          'priceRange', card.price_range,
          'availabilitySummary', card.availability_summary,
          'hasMultipleVariants', card.has_multiple_variants,
          'featuredVariant', card.featured_variant
        ) order by card.is_featured desc, card.sort_order, lower(card.name), card.product_id
      )
      from paged_cards card
    ), '[]'::jsonb),
    'page', safe_page,
    'pageSize', safe_page_size,
    'totalItems', (select count(*) from filtered_products),
    'totalPages', ceil((select count(*) from filtered_products)::numeric / safe_page_size)::integer,
    'availableFilters', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', filter.code,
          'name', filter.name,
          'dataType', filter.data_type,
          'options', coalesce((
            select jsonb_agg(
              jsonb_build_object('value', option.value, 'label', option.label)
              order by option.sort_order, option.label
            )
            from public.attribute_options option
            where option.attribute_definition_id = filter.id
              and option.is_active
              and (
                exists (
                  select 1
                  from public.product_attribute_values value
                  join filtered_products filtered on filtered.id = value.product_id
                  where value.option_id = option.id
                )
                or exists (
                  select 1
                  from public.variant_attribute_values value
                  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
                  join filtered_products filtered on filtered.id = variant.product_id
                  where value.option_id = option.id
                )
              )
          ), '[]'::jsonb)
        ) order by filter.sort_order, filter.name
      )
      from available_filter_rows filter
    ), '[]'::jsonb)
  ) into result;

  return result;
end;
$$;

create or replace function public.catalog_product_detail_v2(p_slug text)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'productId', product.id,
    'code', product.code,
    'slug', product.slug,
    'name', product.name,
    'shortDescription', product.short_description,
    'description', product.description,
    'brand', jsonb_build_object(
      'id', brand.id,
      'name', brand.name,
      'slug', brand.slug
    ),
    'category', jsonb_build_object(
      'id', category.id,
      'name', category.name,
      'slug', category.slug,
      'path', category_path.canonical_path
    ),
    'template', jsonb_build_object(
      'id', template.id,
      'code', template.code,
      'name', template.name
    ),
    'attributes', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'code', definition.code,
          'name', definition.name,
          'dataType', definition.data_type,
          'unit', definition.unit,
          'value', coalesce(
            to_jsonb(option.label),
            to_jsonb(value.value_text),
            to_jsonb(value.value_number),
            to_jsonb(value.value_boolean),
            to_jsonb(value.value_date),
            value.value_json
          )
        ) order by definition.sort_order, definition.name
      )
      from public.product_attribute_values value
      join public.attribute_definitions definition on definition.id = value.attribute_definition_id
      left join public.attribute_options option on option.id = value.option_id
      where value.product_id = product.id
    ), '[]'::jsonb),
    'media', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', media.id,
          'role', association.media_role,
          'path', media.storage_path,
          'mimeType', media.mime_type,
          'altText', media.alt_text,
          'isPrimary', association.is_primary
        ) order by association.media_role, association.is_primary desc, association.sort_order
      )
      from public.product_media association
      join public.media_assets media on media.id = association.media_asset_id
      where association.product_id = product.id
    ), '[]'::jsonb),
    'variants', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', variant.id,
          'sku', variant.sku,
          'name', variant.name,
          'variantKey', variant.variant_key,
          'availability', public.variant_effective_availability(variant.id),
          'isDefault', variant.is_default,
          'attributes', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'code', definition.code,
                'name', definition.name,
                'dataType', definition.data_type,
                'unit', definition.unit,
                'value', coalesce(
                  to_jsonb(option.label),
                  to_jsonb(value.value_text),
                  to_jsonb(value.value_number),
                  to_jsonb(value.value_boolean),
                  to_jsonb(value.value_date),
                  value.value_json
                ),
                'optionValue', option.value
              ) order by definition.sort_order, definition.name
            )
            from public.variant_attribute_values value
            join public.attribute_definitions definition on definition.id = value.attribute_definition_id
            left join public.attribute_options option on option.id = value.option_id
            where value.variant_id = variant.id
          ), '[]'::jsonb),
          'prices', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'priceListCode', price_list.code,
                'type', price_list.price_type,
                'amount', price.amount,
                'minimumQuantity', price.minimum_quantity,
                'currency', price_list.currency
              ) order by price_list.priority desc, price.minimum_quantity
            )
            from public.variant_prices price
            join public.price_lists price_list on price_list.id = price.price_list_id
            where price.variant_id = variant.id
              and price.is_active
              and price.validity @> now()
              and price_list.is_active
              and price_list.is_public
          ), '[]'::jsonb),
          'media', coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'id', media.id,
                'role', association.media_role,
                'path', media.storage_path,
                'mimeType', media.mime_type,
                'altText', media.alt_text,
                'isPrimary', association.is_primary
              ) order by association.is_primary desc, association.sort_order
            )
            from public.product_media association
            join public.media_assets media on media.id = association.media_asset_id
            where association.variant_id = variant.id
          ), '[]'::jsonb)
        ) order by variant.is_default desc, variant.sort_order, variant.name
      )
      from public.product_variants variant
      where variant.product_id = product.id and variant.is_active
    ), '[]'::jsonb),
    'wholesaleRules', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', rule.id,
          'name', rule.name,
          'scopeType', rule.scope_type,
          'minimumQuantity', rule.minimum_quantity,
          'mixingPolicy', rule.mixing_policy,
          'priceListCode', price_list.code,
          'priority', rule.priority
        ) order by rule.priority desc, rule.minimum_quantity
      )
      from public.wholesale_rules rule
      join public.price_lists price_list on price_list.id = rule.price_list_id
      where rule.is_active
        and (rule.valid_from is null or rule.valid_from <= now())
        and (rule.valid_to is null or rule.valid_to > now())
        and (
          rule.product_id = product.id
          or rule.brand_id = product.brand_id
          or rule.category_id = product.category_id
          or rule.variant_id in (
            select variant.id from public.product_variants variant
            where variant.product_id = product.id and variant.is_active
          )
        )
    ), '[]'::jsonb),
    'relations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', relation.id,
          'type', relation.relation_type,
          'compatibilityStatus', relation.compatibility_status,
          'sourceProductId', relation.source_product_id,
          'sourceVariantId', relation.source_variant_id,
          'targetProductId', relation.target_product_id,
          'targetVariantId', relation.target_variant_id,
          'notes', relation.notes
        ) order by relation.sort_order, relation.id
      )
      from public.product_relations relation
      where relation.is_active
        and (
          relation.source_product_id = product.id
          or relation.target_product_id = product.id
          or relation.source_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
          or relation.target_variant_id in (
            select variant.id from public.product_variants variant where variant.product_id = product.id
          )
        )
    ), '[]'::jsonb)
  )
  from public.products product
  join public.brands brand on brand.id = product.brand_id
  join public.categories category on category.id = product.category_id
  join public.attribute_templates template on template.id = product.template_id
  left join public.category_paths category_path on category_path.id = category.id
  where product.slug = p_slug
    and product.is_active
    and product.editorial_status = 'published';
$$;

create or replace function public.evaluate_cart_v2(p_lines jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  result jsonb;
begin
  if jsonb_typeof(p_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Las líneas del carrito deben ser un arreglo JSON.';
  end if;

  if jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 50 then
    raise exception using errcode = '22023', message = 'El carrito debe contener entre 1 y 50 líneas.';
  end if;

  with
  input_lines as (
    select
      (line ->> 'variantId')::uuid as variant_id,
      greatest(coalesce((line ->> 'quantity')::integer, 1), 1) as quantity,
      row_number() over () as input_order
    from jsonb_array_elements(p_lines) line
  ),
  enriched as materialized (
    select
      input.input_order,
      input.variant_id,
      input.quantity,
      variant.product_id,
      variant.sku,
      variant.name as variant_name,
      public.variant_effective_availability(variant.id) as availability_status,
      product.name as product_name,
      product.slug,
      product.brand_id,
      product.category_id,
      brand.name as brand_name,
      coalesce(
        (
          select media.storage_path
          from public.product_media association
          join public.media_assets media on media.id = association.media_asset_id
          where association.variant_id = variant.id
          order by association.is_primary desc, association.sort_order, association.id
          limit 1
        ),
        (
          select media.storage_path
          from public.product_media association
          join public.media_assets media on media.id = association.media_asset_id
          where association.product_id = product.id and association.media_role = 'main'
          order by association.is_primary desc, association.sort_order, association.id
          limit 1
        )
      ) as image_path
    from input_lines input
    join public.product_variants variant on variant.id = input.variant_id and variant.is_active
    join public.products product on product.id = variant.product_id
    join public.brands brand on brand.id = product.brand_id
    where product.is_active and product.editorial_status = 'published'
  ),
  totals as materialized (
    select
      line.*,
      sum(line.quantity) over (partition by line.product_id) as product_quantity,
      sum(line.quantity) over (partition by line.brand_id) as brand_quantity,
      sum(line.quantity) over (partition by line.category_id) as category_quantity
    from enriched line
  ),
  evaluated as materialized (
    select
      line.*,
      retail.amount as retail_price,
      applied.rule_id,
      applied.rule_name,
      applied.mixing_policy,
      applied.minimum_quantity,
      applied.amount as wholesale_price,
      case
        when line.availability_status = 'consult' then 'consult'
        when applied.rule_id is not null and applied.amount is not null then 'wholesale'
        else 'retail'
      end as purchase_mode,
      case
        when line.availability_status = 'consult' then null
        when applied.rule_id is not null and applied.amount is not null then applied.amount
        else retail.amount
      end as applied_price
    from totals line
    left join lateral (
      select price.amount
      from public.variant_prices price
      join public.price_lists price_list on price_list.id = price.price_list_id
      where price.variant_id = line.variant_id
        and price.is_active
        and price.validity @> now()
        and price_list.is_active
        and price_list.is_public
        and price_list.price_type = 'retail'
      order by price_list.priority desc, price.minimum_quantity desc
      limit 1
    ) retail on true
    left join lateral (
      select
        rule.id as rule_id,
        rule.name as rule_name,
        rule.mixing_policy,
        rule.minimum_quantity,
        price.amount
      from public.wholesale_rules rule
      join public.price_lists price_list on price_list.id = rule.price_list_id
      left join public.variant_prices price
        on price.variant_id = line.variant_id
       and price.price_list_id = rule.price_list_id
       and price.is_active
       and price.validity @> now()
      where rule.is_active
        and (rule.valid_from is null or rule.valid_from <= now())
        and (rule.valid_to is null or rule.valid_to > now())
        and price_list.is_active
        and price_list.is_public
        and (
          (rule.variant_id = line.variant_id and line.quantity >= rule.minimum_quantity)
          or (rule.product_id = line.product_id and line.product_quantity >= rule.minimum_quantity)
          or (rule.brand_id = line.brand_id and line.brand_quantity >= rule.minimum_quantity)
          or (rule.category_id = line.category_id and line.category_quantity >= rule.minimum_quantity)
        )
      order by
        rule.priority desc,
        case rule.scope_type
          when 'variant' then 4
          when 'product' then 3
          when 'brand' then 2
          when 'category' then 1
        end desc,
        rule.minimum_quantity desc
      limit 1
    ) applied on true
  )
  select jsonb_build_object(
    'lines', coalesce(jsonb_agg(
      jsonb_build_object(
        'productId', line.product_id,
        'variantId', line.variant_id,
        'sku', line.sku,
        'productName', line.product_name,
        'variantName', line.variant_name,
        'brandName', line.brand_name,
        'slug', line.slug,
        'imagePath', line.image_path,
        'quantity', line.quantity,
        'unitPrice', line.applied_price,
        'purchaseMode', line.purchase_mode,
        'availability', line.availability_status,
        'subtotal', case
          when line.applied_price is null then null
          else line.applied_price * line.quantity
        end,
        'wholesaleRule', case
          when line.rule_id is null then null
          else jsonb_build_object(
            'id', line.rule_id,
            'name', line.rule_name,
            'minimumQuantity', line.minimum_quantity,
            'mixingPolicy', line.mixing_policy
          )
        end,
        'productQuantity', line.product_quantity
      ) order by line.input_order
    ), '[]'::jsonb),
    'totalUnits', coalesce(sum(line.quantity), 0),
    'subtotal', sum(line.applied_price * line.quantity) filter (where line.applied_price is not null),
    'unresolvedLines', count(*) filter (
      where line.availability_status = 'consult' or line.applied_price is null
    )
  ) into result
  from evaluated line;

  if jsonb_array_length(result -> 'lines') <> jsonb_array_length(p_lines) then
    raise exception using
      errcode = '22023',
      message = 'Una o más variantes no existen, están inactivas o no son públicas.';
  end if;

  return result;
end;
$$;

commit;
