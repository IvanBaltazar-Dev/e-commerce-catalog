-- Vertical 2 · Proveedores y catálogo de abastecimiento.
--
-- NUMERACIÓN: el hueco 0026 dejó de estar libre. Lo ocupa
-- 0026_audit_log_survives_deletions.sql, ya aplicado (verificado en
-- supabase_migrations.schema_migrations), que corrige las claves foráneas
-- `on delete set null` de la bitácora. Esta migración es la 0027.
--
-- Antes de esta migración el dominio no existía: cero ocurrencias de
-- supplier/proveedor en las 26 migraciones. Cierra la pregunta 9 de
-- la auditoría inicial: un producto no podía relacionarse con varios
-- proveedores. La decisión vigente está en docs/arquitectura.md.
--
-- Trazabilidad con las nueve viñetas del plan (Bloque 1, sección Proveedores):
--   Proveedores          -> public.suppliers
--   Contactos            -> public.supplier_contacts
--   Producto-proveedor   -> public.product_suppliers
--   Costos por proveedor -> public.supplier_cost_agreements
--   Escalas por cantidad -> public.supplier_cost_tiers
--   Pedidos mínimos      -> suppliers.minimum_order_amount (por pedido)
--                           supplier_branch_terms.minimum_order_amount (por sede)
--                           product_suppliers.minimum_order_quantity (por ítem)
--   Bonificaciones       -> public.supplier_bonuses
--   Tiempo de entrega    -> suppliers.default_lead_time_days
--                           supplier_branch_terms.lead_time_days
--                           product_suppliers.lead_time_days
--   Historial de costos  -> sucesión de vigencias de supplier_cost_agreements,
--                           mantenida por public.set_supplier_cost_agreement()
--                           y consultable con public.supplier_cost_history()
--
-- Fuera del plan pero exigido por el modelo:
--   public.supplier_branch_terms   HECHO 4: branch_id en toda tabla de operación
--   public.exchange_rates          el negocio compra en soles y en dólares
--
-- Compras, órdenes de compra, recepciones y costo puesto en almacén son
-- Bloque 2. Aquí solo se modela el catálogo de abastecimiento y sus costos.

begin;

-- btree_gist y pg_trgm ya están instaladas en el esquema public desde 0005;
-- las exclusiones sobre uuid, char(3) e int4range dependen de la primera.
create extension if not exists btree_gist;
create extension if not exists pg_trgm;

-- ---------------------------------------------------------------------------
-- 0. Tipos controlados
-- ---------------------------------------------------------------------------
-- Etiquetas en inglés, como los catorce enums que ya existen en el esquema.
-- Mezclar idiomas obligaría a recordar de qué lado del dominio está cada
-- consulta y cada tipo de contracts.ts.

create type public.supplier_kind as enum (
  'importer',
  'local_distributor',
  'manufacturer',
  'wholesaler',
  'retailer'
);

-- Un booleano no distingue «suspendido por deuda este mes» de «dado de baja».
-- El primero excluye al proveedor de la resolución sin obligar a reasignar
-- ningún vínculo preferido; el segundo es definitivo.
create type public.supplier_status as enum ('active', 'on_hold', 'blocked', 'inactive');

create type public.supplier_contact_role as enum (
  'sales',
  'logistics',
  'billing',
  'management',
  'support',
  'other'
);

create type public.supplier_scope_type as enum ('product', 'variant');

-- Qué comprobante emite el proveedor. Decide si el IGV que se le paga se
-- recupera o es costo.
create type public.tax_document_kind as enum (
  'invoice',
  'sales_receipt',
  'sales_note',
  'import_declaration',
  'none'
);

create type public.supplier_cost_source as enum (
  'quote',
  'invoice',
  'price_list',
  'whatsapp',
  'estimate'
);

-- El orden de declaración es el orden de preferencia ante dos tasas de la
-- misma fecha: manda la de SUNAT.
create type public.exchange_rate_source as enum ('sunat', 'bank', 'manual');

-- ---------------------------------------------------------------------------
-- 1. Tipo de cambio
-- ---------------------------------------------------------------------------
-- Sin esta tabla no hay forma de decidir entre un importador que cotiza en
-- dólares y un distribuidor que cotiza en soles: ordenar por el importe
-- nominal pondría 2.85 USD por debajo de 10.50 PEN. No es una operación de
-- compra, es una tabla de referencia, así que no invade el Bloque 2.

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency char(3) not null,
  quote_currency char(3) not null,
  buy_rate numeric(12, 6) not null,
  sell_rate numeric(12, 6) not null,
  source public.exchange_rate_source not null default 'sunat',
  created_at timestamptz not null default now(),
  constraint exchange_rates_base_format check (base_currency ~ '^[A-Z]{3}$'),
  constraint exchange_rates_quote_format check (quote_currency ~ '^[A-Z]{3}$'),
  constraint exchange_rates_distinct_pair check (base_currency <> quote_currency),
  constraint exchange_rates_positive check (buy_rate > 0 and sell_rate > 0),
  -- La venta nunca puede ser menor que la compra: sería un arbitraje imposible
  -- y casi siempre un error de captura invertido.
  constraint exchange_rates_spread check (sell_rate >= buy_rate),
  constraint exchange_rates_unique unique (rate_date, base_currency, quote_currency, source)
);

comment on table public.exchange_rates is
  'Tipo de cambio compra y venta por fecha. Para costear una compra se usa la venta: '
  'es el precio al que se adquieren los dólares con los que se paga al proveedor.';

create index exchange_rates_lookup_idx
on public.exchange_rates(base_currency, quote_currency, rate_date desc);

-- No es security definer: así respeta la política de su propia tabla en vez de
-- ser una puerta lateral que la esquiva.
create or replace function public.exchange_rate(
  p_from char(3),
  p_to char(3),
  p_on date default current_date,
  p_side text default 'sell',
  p_max_age_days integer default 30
)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
    when p_from is null or p_to is null then null
    when p_from = p_to then 1::numeric
    else coalesce(
      (
        select case when p_side = 'buy' then r.buy_rate else r.sell_rate end
        from public.exchange_rates r
        where r.base_currency = p_from
          and r.quote_currency = p_to
          and r.rate_date <= p_on
          and r.rate_date >= p_on - p_max_age_days
        order by r.rate_date desc, r.source
        limit 1
      ),
      -- Si solo se cargó el par opuesto, se invierte usando el lado contrario:
      -- comprar dólares con soles es vender soles por dólares.
      (
        select 1 / nullif(case when p_side = 'buy' then r.sell_rate else r.buy_rate end, 0)
        from public.exchange_rates r
        where r.base_currency = p_to
          and r.quote_currency = p_from
          and r.rate_date <= p_on
          and r.rate_date >= p_on - p_max_age_days
        order by r.rate_date desc, r.source
        limit 1
      )
    )
  end;
$$;

comment on function public.exchange_rate(char, char, date, text, integer) is
  'Devuelve null si no hay tasa dentro de p_max_age_days. Se prefiere un null '
  'visible —que la resolución reporta como bloqueo— a una tasa de hace tres años '
  'aplicada en silencio.';

revoke all on function public.exchange_rate(char, char, date, text, integer) from public;
grant execute on function public.exchange_rate(char, char, date, text, integer)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Proveedores
-- ---------------------------------------------------------------------------
-- El proveedor es dato maestro de la empresa, no de una sede: el costo se
-- negocia una sola vez para todo el negocio. Lo que sí cambia por sede —dónde
-- entrega, en cuánto tiempo y con qué mínimo— vive en supplier_branch_terms.

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null,
  legal_name text not null,
  trade_name text not null,
  kind public.supplier_kind not null default 'local_distributor',
  status public.supplier_status not null default 'active',
  country_code char(2) not null default 'PE',
  tax_id text,
  tax_document_kind public.tax_document_kind not null default 'invoice',
  -- ¿Su comprobante da crédito fiscal? Si no lo da, el IGV que se le paga ES
  -- costo. Sin esta distinción un informal a S/ 110 sin comprobante gana
  -- siempre a un formal a S/ 118 con factura, que en realidad cuesta S/ 100.
  tax_credit_eligible boolean not null default true,
  -- ¿Sus importes vienen con IGV incluido? Es el valor por omisión de cada
  -- acuerdo de costo.
  prices_include_tax boolean not null default true,
  default_currency char(3) not null default 'PEN',
  default_lead_time_days integer,
  minimum_order_amount numeric(12, 2),
  minimum_order_currency char(3),
  payment_terms_days integer not null default 0,
  incoterm text,
  phone text,
  whatsapp_number text,
  email text,
  website text,
  address text,
  district text,
  province text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint suppliers_code_format check (code ~ '^[A-Z0-9]+(-[A-Z0-9]+)*$'),
  constraint suppliers_legal_name_not_blank check (length(trim(legal_name)) > 0),
  constraint suppliers_trade_name_not_blank check (length(trim(trade_name)) > 0),
  constraint suppliers_country_format check (country_code ~ '^[A-Z]{2}$'),
  -- El RUC de once dígitos solo se exige a proveedores peruanos: la tienda
  -- importa, y un proveedor coreano no tiene RUC. Copiar companies_tax_id_format
  -- tal cual dejaría fuera a la mitad del padrón real.
  constraint suppliers_tax_id_format check (
    tax_id is null or country_code <> 'PE' or tax_id ~ '^[0-9]{11}$'
  ),
  constraint suppliers_email_format check (
    email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  constraint suppliers_currency_format check (default_currency ~ '^[A-Z]{3}$'),
  -- Un importe mínimo sin moneda no significa nada.
  constraint suppliers_minimum_order_paired check (
    (minimum_order_amount is null) = (minimum_order_currency is null)
    and (minimum_order_currency is null or minimum_order_currency ~ '^[A-Z]{3}$')
    and (minimum_order_amount is null or minimum_order_amount >= 0)
  ),
  constraint suppliers_lead_time_non_negative check (
    default_lead_time_days is null or default_lead_time_days >= 0
  ),
  constraint suppliers_payment_terms_non_negative check (payment_terms_days >= 0),
  -- Solo una factura o una DUA otorgan crédito fiscal. Declarar lo contrario
  -- haría que la comparación descuente un IGV que nunca se recupera.
  constraint suppliers_tax_credit_consistent check (
    not tax_credit_eligible or tax_document_kind in ('invoice', 'import_declaration')
  ),
  constraint suppliers_company_code_unique unique (company_id, code)
);

comment on table public.suppliers is
  'Viñeta «Proveedores». Dato maestro por empresa; distingue importación de distribución local.';
comment on column public.suppliers.tax_credit_eligible is
  'Si es falso, el IGV pagado a este proveedor no se recupera y forma parte del costo.';
comment on column public.suppliers.minimum_order_amount is
  'Viñeta «pedidos mínimos», nivel pedido. No se evalúa contra una sola línea: '
  'la resolución por variante lo devuelve como dato, no como bloqueo.';

-- La unicidad va por país: dos jurisdicciones pueden emitir identificadores
-- que colisionen entre sí sin ser el mismo contribuyente.
create unique index suppliers_tax_id_unique_idx
on public.suppliers(country_code, tax_id)
where tax_id is not null;

create index suppliers_company_status_idx
on public.suppliers(company_id, status, trade_name);

create index suppliers_name_trgm_idx
on public.suppliers using gin (trade_name gin_trgm_ops);

create trigger suppliers_set_updated_at
before update on public.suppliers
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. Contactos
-- ---------------------------------------------------------------------------
-- En el rubro el canal efectivo es WhatsApp, no el correo, y quien cotiza casi
-- nunca es quien cobra.

create table public.supplier_contacts (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  full_name text not null,
  contact_role public.supplier_contact_role not null default 'sales',
  job_title text,
  phone text,
  whatsapp_number text,
  email text,
  notes text,
  is_primary boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_contacts_name_not_blank check (length(trim(full_name)) > 0),
  constraint supplier_contacts_email_format check (
    email is null or email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  ),
  -- Un contacto sin ninguna vía de contacto no sirve para nada.
  constraint supplier_contacts_reachable check (
    num_nonnulls(phone, whatsapp_number, email) >= 1
  ),
  -- Un contacto inactivo no puede seguir siendo el principal. Mismo criterio
  -- que branches_default_must_be_active.
  constraint supplier_contacts_primary_must_be_active check (not is_primary or is_active)
);

comment on table public.supplier_contacts is
  'Viñeta «Contactos». Información de negociación: es la única tabla del dominio '
  'que ni siquiera la vendedora puede leer.';

-- Como máximo un contacto principal activo, mismo índice parcial que
-- staff_branches_one_primary.
create unique index supplier_contacts_one_primary_idx
on public.supplier_contacts(supplier_id)
where is_primary and is_active;

create index supplier_contacts_supplier_idx
on public.supplier_contacts(supplier_id, is_active);

create trigger supplier_contacts_set_updated_at
before update on public.supplier_contacts
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Condiciones por sede
-- ---------------------------------------------------------------------------
-- HECHO 4 / regla 5 del Bloque 1: la mercadería se recibe en una sede. El mismo
-- proveedor entrega en dos días en una y en cinco en otra, o directamente no
-- entrega y hay que ir a recoger. Crear la dimensión ahora evita migrar tablas
-- transaccionales y rehacer sus RLS cuando lleguen las órdenes de compra.

create table public.supplier_branch_terms (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete cascade,
  branch_id uuid not null references public.branches(id) on delete restrict,
  delivers boolean not null default true,
  lead_time_days integer,
  minimum_order_amount numeric(12, 2),
  minimum_order_currency char(3),
  freight_cost numeric(12, 2),
  freight_currency char(3),
  free_freight_from_amount numeric(12, 2),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_branch_terms_lead_time_non_negative check (
    lead_time_days is null or lead_time_days >= 0
  ),
  constraint supplier_branch_terms_minimum_paired check (
    (minimum_order_amount is null) = (minimum_order_currency is null)
    and (minimum_order_currency is null or minimum_order_currency ~ '^[A-Z]{3}$')
    and (minimum_order_amount is null or minimum_order_amount >= 0)
  ),
  constraint supplier_branch_terms_freight_paired check (
    (freight_cost is null) = (freight_currency is null)
    and (freight_currency is null or freight_currency ~ '^[A-Z]{3}$')
    and (freight_cost is null or freight_cost >= 0)
  ),
  constraint supplier_branch_terms_free_freight_non_negative check (
    free_freight_from_amount is null or free_freight_from_amount >= 0
  ),
  constraint supplier_branch_terms_unique unique (supplier_id, branch_id)
);

comment on table public.supplier_branch_terms is
  'Dónde entrega el proveedor, en cuánto tiempo y con qué mínimo. Única tabla del '
  'dominio con branch_id, porque es lo único que realmente cambia por sede.';

create index supplier_branch_terms_branch_idx
on public.supplier_branch_terms(branch_id, is_active);

create trigger supplier_branch_terms_set_updated_at
before update on public.supplier_branch_terms
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. Producto-proveedor: aquí se responde la pregunta 9 de la auditoría
-- ---------------------------------------------------------------------------
-- El alcance es excluyente producto|variante, exactamente el par de constraints
-- de public.wholesale_rules. El vínculo de producto declara cobertura de línea
-- («este distribuidor trae toda la marca Admiss»); el de variante es la OFERTA,
-- y solo la oferta puede llevar costo, porque solo ella tiene presentación de
-- compra declarada.
--
-- pack_units es la clave del asunto: el proveedor no vende en nuestra unidad
-- vendible, vende cajas de 12, displays de 24 y unidades sueltas a precios que
-- no son proporcionales entre sí. Sin pack_units en la identidad de la oferta,
-- comparar dos proveedores es comparar números que no significan lo mismo.
--
-- CONVENIO DE UNIDADES, fijado aquí de una vez y usado por todo el dominio:
--   pack_units                  unidades vendibles que trae una unidad de compra
--   minimum_order_quantity      en UNIDADES DE COMPRA
--   supplier_cost_tiers.quantity_range   en UNIDADES DE COMPRA
--   supplier_cost_tiers.unit_cost        por UNIDAD DE COMPRA
--   supplier_bonuses.buy_quantity/free_quantity  en UNIDADES DE COMPRA

create table public.product_suppliers (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  scope_type public.supplier_scope_type not null,
  -- Cascade, no restrict: scripts/cleanup-v2-test-data.mjs borra productos en
  -- bloque y el catálogo ya baja en cascada de products a product_variants.
  -- Cambiar ese contrato desde el dominio de proveedores rompería la limpieza
  -- de pruebas. El rastro de lo borrado queda en public.audit_log.
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  supplier_sku text,
  supplier_item_name text,
  purchase_unit_label text not null default 'unidad',
  pack_units integer not null default 1,
  minimum_order_quantity integer not null default 1,
  lead_time_days integer,
  is_preferred boolean not null default false,
  priority integer not null default 0,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_suppliers_exactly_one_scope check (
    num_nonnulls(product_id, variant_id) = 1
  ),
  constraint product_suppliers_scope_consistent check (
    (scope_type = 'product' and product_id is not null)
    or (scope_type = 'variant' and variant_id is not null)
  ),
  -- Un vínculo de línea no tiene presentación de compra propia: no se le puede
  -- pactar un empaque porque no se sabe de qué variante.
  constraint product_suppliers_product_scope_has_no_pack check (
    scope_type = 'variant' or pack_units = 1
  ),
  constraint product_suppliers_pack_units_positive check (pack_units > 0),
  constraint product_suppliers_minimum_positive check (minimum_order_quantity > 0),
  constraint product_suppliers_unit_label_not_blank check (
    length(trim(purchase_unit_label)) > 0
  ),
  constraint product_suppliers_sku_not_blank check (
    supplier_sku is null or length(trim(supplier_sku)) > 0
  ),
  constraint product_suppliers_lead_time_non_negative check (
    lead_time_days is null or lead_time_days >= 0
  ),
  constraint product_suppliers_preferred_must_be_active check (not is_preferred or is_active),
  -- Sostiene las claves foráneas compuestas de costos y bonificaciones, que es
  -- lo que impide declarativamente colgar un importe de un vínculo de línea.
  constraint product_suppliers_id_scope_unique unique (id, scope_type)
);

comment on table public.product_suppliers is
  'Viñeta «Producto-proveedor» y respuesta a la pregunta 9: un producto o una '
  'variante admite tantos proveedores como la realidad tenga. Solo los vínculos '
  'de alcance variante (las ofertas) pueden llevar costo.';
comment on column public.product_suppliers.pack_units is
  'Unidades vendibles por unidad de compra. La misma variante suelta y en caja '
  'son dos ofertas distintas del mismo proveedor, con precios no proporcionales.';
comment on column public.product_suppliers.minimum_order_quantity is
  'Viñeta «pedidos mínimos», nivel ítem, en unidades de compra. No se exige que '
  'sea múltiplo de pack_units: «mínimo un empaque» es el caso corriente y ya '
  'queda expresado con el valor 1.';

-- La misma variante en dos presentaciones distintas del mismo proveedor son dos
-- ofertas; el mismo proveedor no puede repetir la misma presentación.
create unique index product_suppliers_variant_offer_unique_idx
on public.product_suppliers(supplier_id, variant_id, pack_units)
where variant_id is not null;

create unique index product_suppliers_product_link_unique_idx
on public.product_suppliers(supplier_id, product_id)
where product_id is not null;

-- Como máximo un preferido activo por alcance: mismo índice parcial que
-- product_variants_one_active_default_idx.
create unique index product_suppliers_one_preferred_variant_idx
on public.product_suppliers(variant_id)
where variant_id is not null and is_preferred and is_active;

create unique index product_suppliers_one_preferred_product_idx
on public.product_suppliers(product_id)
where product_id is not null and is_preferred and is_active;

-- El código del proveedor es como él nombra el artículo en su lista de precios.
create unique index product_suppliers_supplier_sku_idx
on public.product_suppliers(supplier_id, lower(supplier_sku))
where supplier_sku is not null;

create index product_suppliers_supplier_idx
on public.product_suppliers(supplier_id, is_active, priority desc);

create index product_suppliers_variant_idx
on public.product_suppliers(variant_id, is_active)
where variant_id is not null;

create index product_suppliers_product_idx
on public.product_suppliers(product_id, is_active)
where product_id is not null;

create index product_suppliers_item_name_trgm_idx
on public.product_suppliers using gin (lower(supplier_item_name) gin_trgm_ops);

create trigger product_suppliers_set_updated_at
before update on public.product_suppliers
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 6. Costos por proveedor: el acuerdo
-- ---------------------------------------------------------------------------
-- La cabecera declara UNA sola vez lo que no cambia dentro del acuerdo: moneda,
-- régimen de IGV, vigencia y respaldo documental. La exclusión NO incluye la
-- moneda a propósito: en un instante dado debe haber un solo acuerdo vigente
-- por oferta, sea en soles o en dólares. Meter la moneda —o un cost_kind— en la
-- clave permitiría dos costos vigentes simultáneos y el costo quedaría
-- indeterminado, que es precisamente lo que el modelo no puede permitirse.
--
-- El historial de costos NO es otra tabla: es la sucesión de estas vigencias,
-- igual que variant_prices (ver docs/arquitectura.md, Proveedores y compras).

create table public.supplier_cost_agreements (
  id uuid primary key default gen_random_uuid(),
  product_supplier_id uuid not null,
  -- Redundante por diseño: es la mitad de la clave foránea compuesta que impide
  -- colgar un costo de un vínculo de línea.
  scope_type public.supplier_scope_type not null default 'variant',
  currency char(3) not null default 'PEN',
  includes_tax boolean not null default true,
  tax_rate numeric(6, 4) not null default 0.18,
  validity tstzrange not null default tstzrange(now(), null, '[)'),
  source public.supplier_cost_source not null default 'quote',
  source_reference text,
  -- Tipo de cambio pactado al cerrar el acuerdo. Se conserva por valor
  -- histórico; la conversión para comparar usa public.exchange_rate().
  reference_exchange_rate numeric(12, 6),
  notes text,
  is_active boolean not null default true,
  -- Sin clave foránea a auth.users, por la misma razón que 0026 se la quitó a
  -- la bitácora: un registro histórico debe sobrevivir a la desaparición de
  -- quien lo creó, y un «on delete set null» borraría la autoría.
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_cost_agreements_scope_is_variant check (scope_type = 'variant'),
  constraint supplier_cost_agreements_currency_format check (currency ~ '^[A-Z]{3}$'),
  constraint supplier_cost_agreements_tax_rate_range check (tax_rate >= 0 and tax_rate < 1),
  constraint supplier_cost_agreements_rate_positive check (
    reference_exchange_rate is null or reference_exchange_rate > 0
  ),
  -- Un tipo de cambio sobre un costo ya expresado en soles no significa nada.
  constraint supplier_cost_agreements_rate_requires_foreign check (
    reference_exchange_rate is null or currency <> 'PEN'
  ),
  -- Mismo criterio que variant_prices_validity_nonempty.
  constraint supplier_cost_agreements_validity_nonempty check (
    not isempty(validity) and lower(validity) is not null
  ),
  constraint supplier_cost_agreements_offer_fk
    foreign key (product_supplier_id, scope_type)
    references public.product_suppliers(id, scope_type) on delete cascade,
  constraint supplier_cost_agreements_no_active_overlap exclude using gist (
    product_supplier_id with =,
    validity with &&
  ) where (is_active)
);

comment on table public.supplier_cost_agreements is
  'Viñeta «Costos por proveedor». Cabecera del acuerdo: moneda, régimen de IGV y '
  'vigencia. El importe vive en supplier_cost_tiers. La sucesión de vigencias ES '
  'el historial de costos: nada se edita, se cierra el rango y se abre otro.';
comment on column public.supplier_cost_agreements.currency is
  'Fuera de la clave de exclusión a propósito: en un instante dado hay un solo '
  'acuerdo vigente por oferta, así que no hay dos costos simultáneos que comparar.';

create index supplier_cost_agreements_lookup_idx
on public.supplier_cost_agreements(product_supplier_id, is_active);

create index supplier_cost_agreements_history_idx
on public.supplier_cost_agreements(product_supplier_id, lower(validity) desc);

create index supplier_cost_agreements_validity_idx
on public.supplier_cost_agreements using gist (validity)
where is_active;

create trigger supplier_cost_agreements_set_updated_at
before update on public.supplier_cost_agreements
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 7. Escalas por cantidad
-- ---------------------------------------------------------------------------

create table public.supplier_cost_tiers (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null
    references public.supplier_cost_agreements(id) on delete cascade,
  -- Semiabierto: [12,48) es «de 12 a 47 unidades de compra».
  quantity_range int4range not null default int4range(1, null, '[)'),
  unit_cost numeric(14, 4) not null,
  -- Descuento que el proveedor declara. Solo informativo: el importe que manda
  -- es unit_cost.
  discount_percentage numeric(5, 2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_cost_tiers_unit_cost_non_negative check (unit_cost >= 0),
  constraint supplier_cost_tiers_range_valid check (
    not isempty(quantity_range)
    and not lower_inf(quantity_range)
    and lower(quantity_range) >= 1
  ),
  constraint supplier_cost_tiers_discount_range check (
    discount_percentage is null
    or (discount_percentage >= 0 and discount_percentage < 100)
  ),
  -- Dos escalas que se pisan dejarían el costo de una cantidad sin respuesta
  -- única. La exclusión impide el solape; los huecos los impide el guardián
  -- diferido de continuidad, más abajo: una cosa no implica la otra.
  constraint supplier_cost_tiers_no_overlap exclude using gist (
    agreement_id with =,
    quantity_range with &&
  )
);

comment on table public.supplier_cost_tiers is
  'Viñeta «Escalas por cantidad», en unidades de compra. numeric(14,4) y no (12,2): '
  'un costo importado se pacta con cuatro decimales y redondearlo deforma el margen '
  'al multiplicarlo por el volumen.';

create index supplier_cost_tiers_agreement_idx
on public.supplier_cost_tiers(agreement_id, quantity_range);

create trigger supplier_cost_tiers_set_updated_at
before update on public.supplier_cost_tiers
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 8. La escalera debe cubrir toda cantidad, sin huecos
-- ---------------------------------------------------------------------------
-- La exclusión GiST impide solapes, NO huecos: [1,12) y [24,∞) conviven sin
-- error y una cantidad de 15 se queda sin costo. La oferta desaparecería
-- entonces de la comparación con un «sin escala» que nadie pidió. Diferido por
-- la misma razón que products_require_default_variant: la cabecera y sus
-- tramos son sentencias distintas de la misma transacción.

create or replace function public.assert_supplier_cost_ladder_is_complete()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_agreement_id uuid;
  ladder_is_complete boolean;
begin
  if tg_table_name = 'supplier_cost_agreements' then
    target_agreement_id := coalesce(new.id, old.id);
  else
    target_agreement_id := coalesce(new.agreement_id, old.agreement_id);
  end if;

  -- Si el acuerdo desapareció o dejó de estar activo, no hay escalera que
  -- validar: un acuerdo cerrado conserva la escalera con la que se pactó.
  if not exists (
    select 1
    from public.supplier_cost_agreements a
    where a.id = target_agreement_id and a.is_active
  ) then
    return null;
  end if;

  with ordered as (
    select
      t.quantity_range,
      lag(upper(t.quantity_range)) over (order by lower(t.quantity_range)) as previous_upper,
      row_number() over (order by lower(t.quantity_range)) as position,
      count(*) over () as total
    from public.supplier_cost_tiers t
    where t.agreement_id = target_agreement_id
  )
  select coalesce(bool_and(
    case
      when ordered.position = 1 then lower(ordered.quantity_range) = 1
      else lower(ordered.quantity_range) = ordered.previous_upper
    end
    and (ordered.position < ordered.total or upper_inf(ordered.quantity_range))
  ), false)
  into ladder_is_complete
  from ordered;

  if not ladder_is_complete then
    raise exception using
      errcode = '23514',
      message = format(
        'La escalera de costos del acuerdo %s debe empezar en 1 unidad de compra y cubrir toda cantidad sin huecos, terminando en un tramo abierto.',
        target_agreement_id
      );
  end if;

  return null;
end;
$$;

revoke all on function public.assert_supplier_cost_ladder_is_complete() from public;

create constraint trigger supplier_cost_agreements_require_full_ladder
after insert or update on public.supplier_cost_agreements
deferrable initially deferred
for each row execute function public.assert_supplier_cost_ladder_is_complete();

create constraint trigger supplier_cost_tiers_require_full_ladder
after insert or update or delete on public.supplier_cost_tiers
deferrable initially deferred
for each row execute function public.assert_supplier_cost_ladder_is_complete();

-- ---------------------------------------------------------------------------
-- 9. Un costo ya vigente no se reescribe
-- ---------------------------------------------------------------------------
-- HECHO 5. Sin esto, un UPDATE sobre unit_cost cambiaría retroactivamente el
-- margen de un periodo ya transcurrido y la pregunta «¿a cuánto compramos en
-- marzo?» tendría dos respuestas. El borrado sí se permite: es un acto
-- destructivo explícito, queda en la bitácora, y prohibirlo rompería el borrado
-- en cascada de productos del que dependen los scripts de limpieza.

create or replace function public.reject_effective_cost_rewrite()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  agreement public.supplier_cost_agreements%rowtype;
begin
  if tg_table_name = 'supplier_cost_tiers' then
    select * into agreement
    from public.supplier_cost_agreements a
    where a.id = new.agreement_id;

    if found
       and lower(agreement.validity) <= now()
       and (
         new.unit_cost is distinct from old.unit_cost
         or new.quantity_range is distinct from old.quantity_range
         or new.agreement_id is distinct from old.agreement_id
       )
    then
      raise exception using
        errcode = '42501',
        message = 'Un costo ya vigente no se reescribe. Registra un acuerdo nuevo con public.set_supplier_cost_agreement().';
    end if;
  else
    if lower(old.validity) <= now()
       and (
         new.currency is distinct from old.currency
         or new.includes_tax is distinct from old.includes_tax
         or new.tax_rate is distinct from old.tax_rate
         or lower(new.validity) is distinct from lower(old.validity)
         or new.product_supplier_id is distinct from old.product_supplier_id
       )
    then
      raise exception using
        errcode = '42501',
        message = 'Un acuerdo de costo ya vigente solo admite cerrar su vigencia o desactivarse. Registra uno nuevo con public.set_supplier_cost_agreement().';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.reject_effective_cost_rewrite() from public;

create trigger supplier_cost_agreements_no_rewrite
before update on public.supplier_cost_agreements
for each row execute function public.reject_effective_cost_rewrite();

create trigger supplier_cost_tiers_no_rewrite
before update on public.supplier_cost_tiers
for each row execute function public.reject_effective_cost_rewrite();

-- La presentación de compra tampoco: cambiar de 12 a 10 unidades por caja
-- reescribiría en silencio el significado de todo el historial de la oferta.
create or replace function public.reject_pack_units_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.pack_units is distinct from old.pack_units
     and exists (
       select 1 from public.supplier_cost_agreements a
       where a.product_supplier_id = old.id
     )
  then
    raise exception using
      errcode = '42501',
      message = 'No se puede cambiar la presentación de compra de una oferta que ya tiene costos. Registra una oferta nueva y desactiva la anterior.';
  end if;

  return new;
end;
$$;

revoke all on function public.reject_pack_units_change() from public;

create trigger product_suppliers_pack_units_immutable
before update on public.product_suppliers
for each row execute function public.reject_pack_units_change();

-- ---------------------------------------------------------------------------
-- 10. Bonificaciones
-- ---------------------------------------------------------------------------
-- «Lleva 12, paga 10» no es un descuento: son unidades físicas que el
-- inventario del Bloque 2 tendrá que recibir. El descuento por volumen ya tiene
-- su propia tabla (las escalas), y mezclarlos dejaría al resolvedor eligiendo
-- entre dos fuentes para el mismo importe.

create table public.supplier_bonuses (
  id uuid primary key default gen_random_uuid(),
  product_supplier_id uuid not null,
  scope_type public.supplier_scope_type not null default 'variant',
  buy_quantity integer not null,
  free_quantity integer not null,
  -- Nulo: más unidades de la misma oferta, y entonces baja el costo unitario
  -- efectivo. No nulo: el regalo es otro artículo, y NO baja el costo de este
  -- —imputarlo falsearía el costo de las dos variantes a la vez—, así que la
  -- resolución lo ignora en el cálculo y lo reporta aparte.
  bonus_variant_id uuid references public.product_variants(id) on delete cascade,
  is_repeatable boolean not null default true,
  max_free_quantity integer,
  label text,
  validity tstzrange not null default tstzrange(now(), null, '[)'),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_bonuses_scope_is_variant check (scope_type = 'variant'),
  constraint supplier_bonuses_buy_positive check (buy_quantity > 0),
  constraint supplier_bonuses_free_positive check (free_quantity > 0),
  constraint supplier_bonuses_max_free_consistent check (
    max_free_quantity is null or max_free_quantity >= free_quantity
  ),
  constraint supplier_bonuses_validity_nonempty check (
    not isempty(validity) and lower(validity) is not null
  ),
  constraint supplier_bonuses_offer_fk
    foreign key (product_supplier_id, scope_type)
    references public.product_suppliers(id, scope_type) on delete cascade,
  -- 12→2 y 24→5 conviven porque son umbrales distintos; lo que no puede haber
  -- son dos bonificaciones vigentes para el mismo umbral y el mismo regalo. El
  -- coalesce es necesario porque en una exclusión dos nulos nunca chocan, y
  -- «más de lo mismo» es justamente el caso más común.
  constraint supplier_bonuses_no_active_overlap exclude using gist (
    product_supplier_id with =,
    buy_quantity with =,
    (coalesce(bonus_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) with =,
    validity with &&
  ) where (is_active)
);

comment on table public.supplier_bonuses is
  'Viñeta «Bonificaciones». buy_quantity y free_quantity van ambos en unidades de '
  'compra de esta oferta. Solo las bonificaciones de la misma presentación bajan '
  'el costo unitario efectivo.';

create index supplier_bonuses_lookup_idx
on public.supplier_bonuses(product_supplier_id, buy_quantity desc)
where is_active;

create trigger supplier_bonuses_set_updated_at
before update on public.supplier_bonuses
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 11. Todo alcance con vínculos activos debe tener uno preferido
-- ---------------------------------------------------------------------------
-- El índice parcial da «como máximo uno»; este guardián da «al menos uno». Sin
-- él, una variante con tres proveedores y ninguno designado es una variante que
-- el sistema no sabe comprar.
--
-- A DIFERENCIA del diseño del que parte esta migración, NO se exige que el
-- preferido tenga costo vigente. «Este distribuidor lo tiene, falta cotizar» es
-- el estado más común al cargar 1.500 SKU, y encadenar ambas exigencias hacía
-- imposible registrar el primer proveedor de una variante sin cotizarlo en la
-- misma transacción. La ausencia de costo la reporta la resolución como
-- bloqueo, que es donde se ve y no donde bloquea la ingesta.

create or replace function public.assert_supply_has_preferred_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Un update puede mover el vínculo de alcance, así que se revisan los dos
  -- extremos de la fila: coalesce(new, old) ignoraría el alcance que se abandona.
  affected_variants uuid[] := array_remove(array[
    case when tg_op <> 'INSERT' then old.variant_id end,
    case when tg_op <> 'DELETE' then new.variant_id end
  ], null);
  affected_products uuid[] := array_remove(array[
    case when tg_op <> 'INSERT' then old.product_id end,
    case when tg_op <> 'DELETE' then new.product_id end
  ], null);
  candidate uuid;
begin
  foreach candidate in array affected_variants
  loop
    if exists (
      select 1 from public.product_suppliers ps
      where ps.variant_id = candidate and ps.is_active
    ) and not exists (
      select 1 from public.product_suppliers ps
      where ps.variant_id = candidate and ps.is_active and ps.is_preferred
    ) then
      raise exception using
        errcode = '23514',
        message = format(
          'La variante %s tiene proveedores activos y ninguno marcado como preferido.',
          candidate
        );
    end if;
  end loop;

  foreach candidate in array affected_products
  loop
    if exists (
      select 1 from public.product_suppliers ps
      where ps.product_id = candidate and ps.is_active
    ) and not exists (
      select 1 from public.product_suppliers ps
      where ps.product_id = candidate and ps.is_active and ps.is_preferred
    ) then
      raise exception using
        errcode = '23514',
        message = format(
          'El producto %s tiene proveedores activos y ninguno marcado como preferido.',
          candidate
        );
    end if;
  end loop;

  return null;
end;
$$;

revoke all on function public.assert_supply_has_preferred_source() from public;

create constraint trigger product_suppliers_require_preferred
after insert or update or delete on public.product_suppliers
deferrable initially deferred
for each row execute function public.assert_supply_has_preferred_source();

-- Cambiar de preferido sin pelearse con el índice único: desmarca y marca en la
-- misma sentencia, para que la interfaz no tenga que traducir un 23505 crudo.
create or replace function public.set_preferred_supplier(p_product_supplier_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  link public.product_suppliers%rowtype;
begin
  if not public.is_admin() then
    raise exception using
      errcode = '42501',
      message = 'Solo administración puede designar el proveedor preferido.';
  end if;

  select * into link from public.product_suppliers ps where ps.id = p_product_supplier_id;

  if not found then
    raise exception using errcode = '23503', message = 'El vínculo de proveedor no existe.';
  end if;

  if not link.is_active then
    raise exception using
      errcode = '23514',
      message = 'Un vínculo desactivado no puede ser el proveedor preferido.';
  end if;

  update public.product_suppliers ps
  set is_preferred = (ps.id = p_product_supplier_id)
  where ps.is_active
    and (
      (link.variant_id is not null and ps.variant_id = link.variant_id)
      or (link.product_id is not null and ps.product_id = link.product_id)
    )
    and ps.is_preferred is distinct from (ps.id = p_product_supplier_id);
end;
$$;

revoke all on function public.set_preferred_supplier(uuid) from public;
grant execute on function public.set_preferred_supplier(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Registrar un costo conservando el historial
-- ---------------------------------------------------------------------------
-- Si se deja a la aplicación, tarde o temprano alguien hará UPDATE y perderá el
-- historial. Y si se cierra tramo a tramo, un rango nuevo que solape solo en
-- parte al anterior deja cantidades sin cobertura en silencio. Por eso la
-- unidad de reemplazo es la ESCALERA COMPLETA: se cierra el acuerdo vigente y
-- se abre otro con todos sus tramos, que el guardián de continuidad verifica.

create or replace function public.set_supplier_cost_agreement(
  p_product_supplier_id uuid,
  p_tiers jsonb,
  p_currency char(3) default null,
  p_includes_tax boolean default null,
  p_tax_rate numeric default 0.18,
  p_source public.supplier_cost_source default 'quote',
  p_source_reference text default null,
  p_reference_exchange_rate numeric default null,
  p_effective_from timestamptz default now()
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  link public.product_suppliers%rowtype;
  supplier public.suppliers%rowtype;
  new_agreement_id uuid;
  tier jsonb;
  tier_count integer;
  actor uuid := auth.uid();
  actor_name text;
begin
  if not public.is_admin() then
    raise exception using
      errcode = '42501',
      message = 'Solo administración puede registrar costos de proveedor.';
  end if;

  select * into link from public.product_suppliers ps where ps.id = p_product_supplier_id;

  if not found then
    raise exception using errcode = '23503', message = 'La oferta de proveedor no existe.';
  end if;

  if link.scope_type <> 'variant' then
    raise exception using
      errcode = '23514',
      message = 'Un vínculo de línea no admite costo: registra la oferta por variante, que es la unidad comprable.';
  end if;

  select * into supplier from public.suppliers s where s.id = link.supplier_id;

  tier_count := jsonb_array_length(coalesce(p_tiers, '[]'::jsonb));

  if tier_count = 0 then
    raise exception using
      errcode = '22023',
      message = 'Un acuerdo de costo necesita al menos una escala que empiece en 1 unidad de compra.';
  end if;

  -- Cierra el acuerdo que estaba corriendo. El rango es semiabierto, así que
  -- cerrar en p_effective_from y abrir el nuevo en el mismo instante no solapa.
  update public.supplier_cost_agreements a
  set validity = tstzrange(lower(a.validity), p_effective_from, '[)')
  where a.product_supplier_id = p_product_supplier_id
    and a.is_active
    and lower(a.validity) < p_effective_from
    and (upper_inf(a.validity) or upper(a.validity) > p_effective_from);

  -- Lo que aún no había empezado se descarta: nunca llegó a regir.
  update public.supplier_cost_agreements a
  set is_active = false
  where a.product_supplier_id = p_product_supplier_id
    and a.is_active
    and lower(a.validity) >= p_effective_from;

  select nullif(trim(coalesce(p.full_name, '')), '') into actor_name
  from public.admin_profiles p where p.id = actor;

  insert into public.supplier_cost_agreements (
    product_supplier_id, scope_type, currency, includes_tax, tax_rate,
    validity, source, source_reference, reference_exchange_rate,
    created_by, created_by_label
  ) values (
    p_product_supplier_id,
    'variant',
    coalesce(p_currency, supplier.default_currency),
    coalesce(p_includes_tax, supplier.prices_include_tax),
    coalesce(p_tax_rate, 0.18),
    tstzrange(p_effective_from, null, '[)'),
    p_source,
    p_source_reference,
    p_reference_exchange_rate,
    actor,
    actor_name
  )
  returning id into new_agreement_id;

  for tier in select value from jsonb_array_elements(p_tiers)
  loop
    insert into public.supplier_cost_tiers (
      agreement_id, quantity_range, unit_cost, discount_percentage
    ) values (
      new_agreement_id,
      int4range(
        coalesce((tier ->> 'from')::integer, 1),
        (tier ->> 'to')::integer,
        '[)'
      ),
      (tier ->> 'unitCost')::numeric,
      (tier ->> 'discountPercentage')::numeric
    );
  end loop;

  return new_agreement_id;
end;
$$;

comment on function public.set_supplier_cost_agreement(
  uuid, jsonb, char, boolean, numeric, public.supplier_cost_source, text, numeric, timestamptz
) is
  'Reemplaza la escalera completa de una oferta: cierra la vigencia anterior y abre '
  'una nueva. p_tiers es [{"from":1,"to":12,"unitCost":12.5},{"from":12,"unitCost":10.5}].';

revoke all on function public.set_supplier_cost_agreement(
  uuid, jsonb, char, boolean, numeric, public.supplier_cost_source, text, numeric, timestamptz
) from public;
grant execute on function public.set_supplier_cost_agreement(
  uuid, jsonb, char, boolean, numeric, public.supplier_cost_source, text, numeric, timestamptz
) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 13. Historial de costos: la viñeta 9, como consulta de negocio
-- ---------------------------------------------------------------------------
-- «¿A cuánto comprábamos este esmalte en marzo?» con un SELECT, no
-- reconstruyendo jsonb de la bitácora.

create or replace function public.supplier_cost_history(
  p_variant_id uuid,
  p_supplier_id uuid default null
)
returns table (
  supplier_id uuid,
  supplier_name text,
  product_supplier_id uuid,
  purchase_unit_label text,
  pack_units integer,
  currency char(3),
  quantity_from integer,
  quantity_to integer,
  unit_cost numeric,
  includes_tax boolean,
  effective_from timestamptz,
  effective_to timestamptz,
  source public.supplier_cost_source,
  source_reference text,
  recorded_by_label text
)
language sql
stable
set search_path = ''
as $$
  select
    ps.supplier_id,
    s.trade_name,
    ps.id,
    ps.purchase_unit_label,
    ps.pack_units,
    a.currency,
    lower(t.quantity_range),
    upper(t.quantity_range),
    t.unit_cost,
    a.includes_tax,
    lower(a.validity),
    upper(a.validity),
    a.source,
    a.source_reference,
    a.created_by_label
  from public.product_suppliers ps
  join public.suppliers s on s.id = ps.supplier_id
  join public.supplier_cost_agreements a on a.product_supplier_id = ps.id
  join public.supplier_cost_tiers t on t.agreement_id = a.id
  where ps.variant_id = p_variant_id
    and (p_supplier_id is null or ps.supplier_id = p_supplier_id)
  order by lower(a.validity) desc, ps.supplier_id, lower(t.quantity_range);
$$;

revoke all on function public.supplier_cost_history(uuid, uuid) from public;
grant execute on function public.supplier_cost_history(uuid, uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 14. El código del proveedor no es el nuestro
-- ---------------------------------------------------------------------------
-- pg_trgm vive en el esquema public, así que con `search_path = ''` hay que
-- calificar similarity() y el operador %: sin calificar, la función ni siquiera
-- se puede crear.

create or replace function public.find_variant_by_supplier_code(
  p_supplier_id uuid,
  p_code text
)
returns table (
  variant_id uuid,
  product_supplier_id uuid,
  product_name text,
  variant_name text,
  internal_sku text,
  match_score numeric
)
language sql
stable
set search_path = ''
as $$
  select
    ps.variant_id,
    ps.id,
    pr.name,
    pv.name,
    pv.sku,
    (case
      when lower(ps.supplier_sku) = lower(trim(p_code)) then 1.0
      else public.similarity(lower(coalesce(ps.supplier_item_name, '')), lower(trim(p_code)))
    end)::numeric
  from public.product_suppliers ps
  join public.product_variants pv on pv.id = ps.variant_id
  join public.products pr on pr.id = pv.product_id
  where ps.supplier_id = p_supplier_id
    and (
      lower(ps.supplier_sku) = lower(trim(p_code))
      or lower(coalesce(ps.supplier_item_name, '')) operator(public.%) lower(trim(p_code))
    )
  order by 6 desc
  limit 10;
$$;

revoke all on function public.find_variant_by_supplier_code(uuid, text) from public;
grant execute on function public.find_variant_by_supplier_code(uuid, text)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 15. ¿A quién le conviene comprarle esto hoy?
-- ---------------------------------------------------------------------------
-- No existe «el mejor proveedor» en abstracto: existe el mejor para esta
-- cantidad, en esta sede y hoy. Por eso es una función y no una vista.
--
-- NO es security definer, y esa es la decisión que hace real la protección del
-- costo: al ejecutarse con los privilegios de quien llama, la RLS de
-- supplier_cost_agreements se aplica dentro de la función. La vendedora recibe
-- proveedor, plazo y mínimos con el costo en null; la propietaria lo recibe
-- todo. Una sola función para los dos roles, sin permisos por columna.
--
-- Las opciones no viables NO se filtran: se devuelven con su motivo. «El
-- proveedor más barato no aparece» destruye la confianza en un comparador, y el
-- motivo es justamente con lo que se negocia.

create or replace function public.resolve_variant_supply(
  p_variant_id uuid,
  p_quantity integer default 1,
  p_branch_id uuid default null,
  p_at timestamptz default now()
)
returns table (
  product_supplier_id uuid,
  supply_scope public.supplier_scope_type,
  supplier_id uuid,
  supplier_name text,
  supplier_status public.supplier_status,
  supplier_sku text,
  preferred boolean,
  purchase_unit_label text,
  pack_units integer,
  purchase_units integer,
  billed_units integer,
  bonus_units integer,
  effective_units integer,
  quoted_currency char(3),
  quoted_unit_cost numeric,
  net_unit_cost_pen numeric,
  total_cost_pen numeric,
  minimum_purchase_units integer,
  supplier_minimum_order_amount numeric,
  supplier_minimum_order_currency char(3),
  effective_lead_time_days integer,
  delivers_to_branch boolean,
  cost_recorded_at timestamptz,
  cost_age_days integer,
  viable boolean,
  blockers text[]
)
language plpgsql
stable
set search_path = ''
as $$
declare
  resolved_branch_id uuid := coalesce(p_branch_id, public.default_branch_id());
  target_product_id uuid;
  caller_reads_cost boolean := public.is_admin();
begin
  if p_quantity is null or p_quantity < 1 then
    raise exception using
      errcode = '22023',
      message = 'Indica una cantidad de al menos una unidad vendible.';
  end if;

  select pv.product_id into target_product_id
  from public.product_variants pv
  where pv.id = p_variant_id;

  if target_product_id is null then
    raise exception using errcode = '23503', message = 'La variante indicada no existe.';
  end if;

  return query
  with offer as (
    select
      ps.id                        as link_id,
      ps.scope_type                as link_scope,
      ps.supplier_id               as sup_id,
      ps.supplier_sku              as sup_sku,
      ps.purchase_unit_label       as unit_label,
      ps.pack_units                as pack,
      ps.minimum_order_quantity    as min_units,
      ps.lead_time_days            as item_lead,
      ps.is_preferred              as preferred_flag,
      ps.is_active                 as link_active,
      s.trade_name                 as sup_name,
      s.status                     as sup_status,
      s.tax_credit_eligible        as credit_ok,
      s.minimum_order_amount       as sup_min_amount,
      s.minimum_order_currency     as sup_min_currency,
      s.default_lead_time_days     as sup_lead,
      sbt.delivers                 as branch_delivers,
      sbt.lead_time_days           as branch_lead
    from public.product_suppliers ps
    join public.suppliers s on s.id = ps.supplier_id
    left join public.supplier_branch_terms sbt
      on sbt.supplier_id = ps.supplier_id
     and sbt.branch_id = resolved_branch_id
     and sbt.is_active
    where ps.variant_id = p_variant_id
       or ps.product_id = target_product_id
  ),
  sized as (
    select
      o.*,
      -- El pedido se hace en unidades de compra: 24 esmaltes con empaque de 12
      -- son 2 cajas. Redondeo hacia arriba, porque no se compra media caja.
      ceil(p_quantity::numeric / o.pack)::integer as buy_units
    from offer o
  ),
  priced as (
    select
      z.*,
      a.id          as agreement_id,
      a.currency    as cost_currency,
      a.includes_tax as cost_includes_tax,
      a.tax_rate    as cost_tax_rate,
      a.created_at  as cost_at,
      t.unit_cost   as cost_amount
    from sized z
    left join lateral (
      select ag.id, ag.currency, ag.includes_tax, ag.tax_rate, ag.created_at
      from public.supplier_cost_agreements ag
      where ag.product_supplier_id = z.link_id
        and ag.is_active
        and ag.validity @> p_at
      limit 1
    ) a on true
    left join lateral (
      select tt.unit_cost
      from public.supplier_cost_tiers tt
      where tt.agreement_id = a.id
        and tt.quantity_range @> z.buy_units
      limit 1
    ) t on true
  ),
  bonused as (
    select p.*, coalesce(b.free_units, 0)::integer as free_units
    from priced p
    left join lateral (
      select least(
               coalesce(sb.max_free_quantity, 2147483647),
               case
                 when sb.is_repeatable
                   then (p.buy_units / sb.buy_quantity) * sb.free_quantity
                 else sb.free_quantity
               end
             ) as free_units
      from public.supplier_bonuses sb
      where sb.product_supplier_id = p.link_id
        and sb.is_active
        and sb.validity @> p_at
        and sb.buy_quantity <= p.buy_units
        -- Solo la bonificación de la misma presentación baja el denominador.
        and sb.bonus_variant_id is null
      order by sb.buy_quantity desc
      limit 1
    ) b on true
  ),
  converted as (
    select
      x.*,
      -- Un IGV que se recupera no es costo; uno que no se recupera, sí.
      case
        when x.cost_includes_tax and x.credit_ok
          then x.cost_amount / (1 + x.cost_tax_rate)
        else x.cost_amount
      end as net_purchase_unit_cost,
      public.exchange_rate(x.cost_currency, 'PEN'::char(3), p_at::date, 'sell') as fx
    from bonused x
  ),
  computed as (
    select
      c.*,
      (c.buy_units * c.pack)::integer                        as billed,
      (c.free_units * c.pack)::integer                       as bonus_sellable,
      (c.buy_units * c.pack + c.free_units * c.pack)::integer as effective,
      round(c.net_purchase_unit_cost * c.buy_units * c.fx, 2) as total_pen,
      coalesce(c.item_lead, c.branch_lead, c.sup_lead)        as lead_days
    from converted c
  ),
  flagged as (
    select
      f.*,
      round(f.total_pen / nullif(f.effective, 0), 4) as landed_unit_pen,
      array_remove(array[
        case when f.sup_status <> 'active'
          then 'proveedor no habilitado' end,
        case when not f.link_active
          then 'oferta desactivada' end,
        case when f.link_scope = 'product'
          then 'cobertura de línea: registra la oferta por variante para poder costearla' end,
        case when caller_reads_cost and f.link_scope = 'variant' and f.agreement_id is null
          then 'sin costo vigente' end,
        case when caller_reads_cost and f.agreement_id is not null and f.cost_amount is null
          then 'sin escala de costo para esa cantidad' end,
        case when caller_reads_cost and f.cost_amount is not null and f.fx is null
          then 'sin tipo de cambio vigente para ' || f.cost_currency end,
        case when f.buy_units < f.min_units
          then 'no alcanza el pedido mínimo: ' || f.min_units || ' ' || f.unit_label end,
        case when f.branch_delivers is false
          then 'no entrega en esta sede' end,
        case when f.lead_days is null
          then 'sin plazo de entrega registrado' end
      ], null) as blocker_list
    from computed f
  )
  select
    g.link_id,
    g.link_scope,
    g.sup_id,
    g.sup_name,
    g.sup_status,
    g.sup_sku,
    g.preferred_flag,
    g.unit_label,
    g.pack,
    g.buy_units,
    g.billed,
    g.bonus_sellable,
    g.effective,
    g.cost_currency,
    g.cost_amount,
    g.landed_unit_pen,
    g.total_pen,
    g.min_units,
    g.sup_min_amount,
    g.sup_min_currency,
    g.lead_days,
    coalesce(g.branch_delivers, true),
    g.cost_at,
    (current_date - g.cost_at::date)::integer,
    (cardinality(g.blocker_list) = 0),
    g.blocker_list
  from flagged g
  order by
    (cardinality(g.blocker_list) = 0) desc,
    -- El costo manda sobre la designación: la pregunta es a quién conviene
    -- comprarle, no quién es el proveedor de siempre.
    g.landed_unit_pen asc nulls last,
    g.preferred_flag desc,
    g.lead_days asc nulls last;
end;
$$;

comment on function public.resolve_variant_supply(uuid, integer, uuid, timestamptz) is
  'Opciones de compra de una variante para una cantidad, una sede y un momento. '
  'Devuelve también las no viables, con su motivo en blockers. p_quantity va en '
  'unidades vendibles; purchase_units es lo que hay que pedirle al proveedor.';

revoke all on function public.resolve_variant_supply(uuid, integer, uuid, timestamptz) from public;
grant execute on function public.resolve_variant_supply(uuid, integer, uuid, timestamptz)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 16. La pregunta 9, al nivel en que está escrita
-- ---------------------------------------------------------------------------
-- «¿Puede un PRODUCTO relacionarse con varios proveedores?». La vista lo
-- responde sin parámetros ni función, y con security_invoker hereda la RLS de
-- las tablas base: misma convención que public.category_paths.

create or replace view public.product_supplier_options
with (security_invoker = true)
as
select
  coalesce(pv.product_id, ps.product_id) as product_id,
  ps.variant_id,
  ps.id                                  as product_supplier_id,
  ps.scope_type,
  ps.supplier_id,
  s.trade_name                           as supplier_name,
  s.kind                                 as supplier_kind,
  s.status                               as supplier_status,
  ps.supplier_sku,
  ps.purchase_unit_label,
  ps.pack_units,
  ps.minimum_order_quantity,
  ps.is_preferred,
  ps.is_active,
  coalesce(ps.lead_time_days, s.default_lead_time_days) as lead_time_days,
  a.currency,
  a.includes_tax,
  base_tier.unit_cost                    as base_unit_cost,
  lower(a.validity)                      as cost_effective_from,
  (
    select count(*)
    from public.supplier_cost_tiers t
    where t.agreement_id = a.id
  )                                      as cost_tier_count,
  (
    select count(*)
    from public.supplier_bonuses b
    where b.product_supplier_id = ps.id and b.is_active and b.validity @> now()
  )                                      as active_bonus_count
from public.product_suppliers ps
join public.suppliers s on s.id = ps.supplier_id
left join public.product_variants pv on pv.id = ps.variant_id
left join lateral (
  select ag.id, ag.currency, ag.includes_tax, ag.validity
  from public.supplier_cost_agreements ag
  where ag.product_supplier_id = ps.id
    and ag.is_active
    and ag.validity @> now()
  limit 1
) a on true
left join lateral (
  select t.unit_cost
  from public.supplier_cost_tiers t
  where t.agreement_id = a.id
    and t.quantity_range @> 1
  limit 1
) base_tier on true;

comment on view public.product_supplier_options is
  'Pantalla de comparación de proveedores por producto y variante. Un proveedor '
  'con dos presentaciones produce dos filas: es exactamente lo que hay que comparar.';

-- ---------------------------------------------------------------------------
-- 17. RLS
-- ---------------------------------------------------------------------------
-- El costo de compra es el margen del negocio. Separarlo en tablas propias es
-- lo que permite que la RLS por tabla baste: la vendedora lee quién provee y en
-- cuántos días llega —lo que necesita para contestar «¿cuándo lo tienes?»— y
-- obtiene cero filas de costos, sin permisos por columna, que este repositorio
-- no usa en ningún sitio.

alter table public.exchange_rates enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_contacts enable row level security;
alter table public.supplier_branch_terms enable row level security;
alter table public.product_suppliers enable row level security;
alter table public.supplier_cost_agreements enable row level security;
alter table public.supplier_cost_tiers enable row level security;
alter table public.supplier_bonuses enable row level security;

create policy "staff read exchange rates"
on public.exchange_rates for select to authenticated
using (public.is_staff());

create policy "admins manage exchange rates"
on public.exchange_rates for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "staff read suppliers"
on public.suppliers for select to authenticated
using (public.is_staff());

create policy "admins manage suppliers"
on public.suppliers for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Los contactos son información de negociación: administración y nadie más.
create policy "admins manage supplier contacts"
on public.supplier_contacts for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- Único punto del dominio donde staff_branch_ids() filtra filas: el mismo
-- predicado que usará toda la operación del Bloque 2.
create policy "staff read supply terms of their branches"
on public.supplier_branch_terms for select to authenticated
using (branch_id in (select public.staff_branch_ids()));

create policy "admins manage supplier branch terms"
on public.supplier_branch_terms for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "staff read active product suppliers"
on public.product_suppliers for select to authenticated
using (is_active and public.is_staff());

create policy "admins manage product suppliers"
on public.product_suppliers for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage supplier cost agreements"
on public.supplier_cost_agreements for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage supplier cost tiers"
on public.supplier_cost_tiers for all to authenticated
using (public.is_admin()) with check (public.is_admin());

create policy "admins manage supplier bonuses"
on public.supplier_bonuses for all to authenticated
using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- 18. Privilegios
-- ---------------------------------------------------------------------------
-- Supabase concede privilegios por omisión a anon en el esquema public: este
-- revoke no es decorativo. El catálogo de abastecimiento no es público bajo
-- ninguna circunstancia.

grant select, insert, update, delete on
  public.exchange_rates,
  public.suppliers,
  public.supplier_contacts,
  public.supplier_branch_terms,
  public.product_suppliers,
  public.supplier_cost_agreements,
  public.supplier_cost_tiers,
  public.supplier_bonuses
to authenticated, service_role;

revoke all on
  public.exchange_rates,
  public.suppliers,
  public.supplier_contacts,
  public.supplier_branch_terms,
  public.product_suppliers,
  public.supplier_cost_agreements,
  public.supplier_cost_tiers,
  public.supplier_bonuses,
  public.product_supplier_options
from anon;

grant select on public.product_supplier_options to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 19. Bitácora
-- ---------------------------------------------------------------------------
-- El abastecimiento cambia por operación diaria —una cotización nueva, un
-- proveedor que sube el costo— y es el dato más sensible del negocio, así que
-- entra entero por el mismo bucle de 0025. exchange_rates queda fuera: es una
-- carga diaria de referencia y solo produciría ruido.
--
-- Deliberadamente NO se engancha touch_catalog_metadata: cambiar un costo de
-- proveedor no cambia el catálogo público ni debe invalidar su caché.

do $$
declare
  audited text;
begin
  foreach audited in array array[
    'suppliers',
    'supplier_contacts',
    'supplier_branch_terms',
    'product_suppliers',
    'supplier_cost_agreements',
    'supplier_cost_tiers',
    'supplier_bonuses'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
       for each row execute function public.record_audit()',
      'audit_' || audited,
      audited
    );
  end loop;
end
$$;

commit;
