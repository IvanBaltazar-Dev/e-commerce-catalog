begin;

create extension if not exists pgtap with schema extensions;

select plan(44);

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select has_table('public', 'exchange_rates', 'Existe el tipo de cambio');
select has_table('public', 'suppliers', 'Existen los proveedores');
select has_table('public', 'supplier_contacts', 'Existen los contactos del proveedor');
select has_table('public', 'supplier_branch_terms', 'Existen las condiciones por sede');
select has_table('public', 'product_suppliers', 'Existe el vínculo producto-proveedor');
select has_table('public', 'supplier_cost_agreements', 'Existen los acuerdos de costo');
select has_table('public', 'supplier_cost_tiers', 'Existen las escalas por cantidad');
select has_table('public', 'supplier_bonuses', 'Existen las bonificaciones');
select has_view('public', 'product_supplier_options', 'Existe la comparación por producto');
select has_function(
  'public', 'resolve_variant_supply',
  array['uuid', 'integer', 'uuid', 'timestamptz'],
  'Existe la resolución de abastecimiento'
);
select has_function(
  'public', 'set_supplier_cost_agreement',
  array['uuid', 'jsonb', 'character', 'boolean', 'numeric', 'supplier_cost_source', 'text', 'numeric', 'timestamptz'],
  'Existe el registro de costo que conserva el historial'
);
select has_function(
  'public', 'exchange_rate',
  array['character', 'character', 'date', 'text', 'integer'],
  'Existe la conversión de moneda'
);

select is(
  (
    select count(*)::integer
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relrowsecurity
      and c.relname in (
        'exchange_rates', 'suppliers', 'supplier_contacts', 'supplier_branch_terms',
        'product_suppliers', 'supplier_cost_agreements', 'supplier_cost_tiers',
        'supplier_bonuses'
      )
  ),
  8,
  'Las ocho tablas del dominio tienen RLS habilitada'
);

-- El catálogo de abastecimiento no es público bajo ninguna circunstancia.
select is(
  (
    select count(*)::integer
    from information_schema.role_table_grants
    where grantee = 'anon'
      and table_schema = 'public'
      and table_name in (
        'exchange_rates', 'suppliers', 'supplier_contacts', 'supplier_branch_terms',
        'product_suppliers', 'supplier_cost_agreements', 'supplier_cost_tiers',
        'supplier_bonuses', 'product_supplier_options'
      )
  ),
  0,
  'anon no conserva ningún privilegio sobre el dominio de abastecimiento'
);

-- ---------------------------------------------------------------------------
-- Datos maestros
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'compras-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'vendedora-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.admin_profiles(id, role, full_name, is_active)
values
  ('50000000-0000-4000-8000-000000000001', 'admin', 'Propietaria de compras', true),
  ('50000000-0000-4000-8000-000000000002', 'seller', 'Vendedora de mostrador', true);

insert into public.suppliers (
  id, company_id, code, legal_name, trade_name, kind, country_code, tax_id,
  tax_document_kind, tax_credit_eligible, prices_include_tax,
  default_currency, default_lead_time_days
)
select
  '60000000-0000-4000-8000-000000000001', c.id, 'DIST-LIMA',
  'Distribuidora Lima S.A.C.', 'Distribuidora Lima', 'local_distributor', 'PE', '20512345678',
  'invoice', true, true, 'PEN', 3
from public.companies c order by c.created_at limit 1;

-- El importador chino no tiene RUC y factura sin IGV peruano; su comprobante es
-- la DUA, que sí da crédito fiscal.
insert into public.suppliers (
  id, company_id, code, legal_name, trade_name, kind, country_code, tax_id,
  tax_document_kind, tax_credit_eligible, prices_include_tax,
  default_currency, default_lead_time_days
)
select
  '60000000-0000-4000-8000-000000000002', c.id, 'IMP-YIWU',
  'Yiwu Beauty Trading Co.', 'Yiwu Beauty', 'importer', 'CN', null,
  'import_declaration', true, false, 'USD', 45
from public.companies c order by c.created_at limit 1;

-- El informal cotiza más barato en nominal, pero su IGV no se recupera.
insert into public.suppliers (
  id, company_id, code, legal_name, trade_name, kind, country_code, tax_id,
  tax_document_kind, tax_credit_eligible, prices_include_tax,
  default_currency, default_lead_time_days
)
select
  '60000000-0000-4000-8000-000000000003', c.id, 'GALERIA-01',
  'Comercial Galería EIRL', 'Galería Central', 'wholesaler', 'PE', '20598765432',
  'sales_note', false, true, 'PEN', 1
from public.companies c order by c.created_at limit 1;

select throws_ok(
  $$
    insert into public.suppliers (company_id, code, legal_name, trade_name, country_code, tax_id)
    select c.id, 'RUC-MALO', 'Proveedor con RUC corto', 'RUC corto', 'PE', '123'
    from public.companies c limit 1;
  $$,
  '23514'::text,
  null::text,
  'Un proveedor peruano con RUC de menos de once dígitos se rechaza'
);

select lives_ok(
  $$
    insert into public.suppliers (company_id, code, legal_name, trade_name, kind, country_code, tax_id, tax_document_kind, tax_credit_eligible, default_currency)
    select c.id, 'IMP-KR', 'Seoul Nail Co.', 'Seoul Nail', 'importer', 'KR', null, 'import_declaration', true, 'USD'
    from public.companies c limit 1;
  $$,
  'Un proveedor extranjero sin RUC se registra sin problema'
);

select throws_ok(
  $$
    update public.suppliers
    set minimum_order_amount = 500
    where code = 'DIST-LIMA';
  $$,
  '23514'::text,
  null::text,
  'Un importe mínimo sin moneda no se admite'
);

select throws_ok(
  $$
    insert into public.supplier_contacts (supplier_id, full_name)
    values ('60000000-0000-4000-8000-000000000001', 'Contacto inalcanzable');
  $$,
  '23514'::text,
  null::text,
  'Un contacto sin teléfono, WhatsApp ni correo se rechaza'
);

insert into public.supplier_contacts (supplier_id, full_name, contact_role, whatsapp_number, is_primary)
values ('60000000-0000-4000-8000-000000000001', 'Rosa Quispe', 'sales', '+51999111222', true);

-- El importador no reparte: la mercadería se recoge en el almacén de aduanas.
insert into public.supplier_branch_terms (supplier_id, branch_id, delivers, lead_time_days)
select '60000000-0000-4000-8000-000000000002', b.id, false, 45
from public.branches b where b.is_default and b.is_active;

insert into public.exchange_rates (rate_date, base_currency, quote_currency, buy_rate, sell_rate, source)
values (current_date, 'USD', 'PEN', 3.750000, 3.800000, 'sunat');

-- ---------------------------------------------------------------------------
-- Producto-proveedor: la pregunta 9 de la auditoría
-- ---------------------------------------------------------------------------

insert into public.product_suppliers (
  id, supplier_id, scope_type, variant_id, supplier_sku, supplier_item_name,
  purchase_unit_label, pack_units, minimum_order_quantity, is_preferred
)
select
  '61000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
  'variant', v.id, 'DL-ESM-ROJO-CJ', 'Esmalte rojo caja x12',
  'caja', 12, 1, true
from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';

insert into public.product_suppliers (
  id, supplier_id, scope_type, variant_id, supplier_sku, supplier_item_name,
  purchase_unit_label, pack_units, minimum_order_quantity
)
select
  '61000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000002',
  'variant', v.id, 'YW-8842', 'Red gel polish 15ml',
  'unidad', 1, 100
from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';

insert into public.product_suppliers (
  id, supplier_id, scope_type, variant_id, supplier_sku, supplier_item_name,
  purchase_unit_label, pack_units, minimum_order_quantity
)
select
  '61000000-0000-4000-8000-000000000003', '60000000-0000-4000-8000-000000000003',
  'variant', v.id, 'GC-ROJO', 'Esmalte rojo docena',
  'caja', 12, 1
from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';

select is(
  (
    select count(*)::integer
    from public.product_suppliers ps
    join public.product_variants v on v.id = ps.variant_id
    where v.sku = 'DEMO-ESM-ROJO'
  ),
  3,
  'Una misma variante se relaciona con tres proveedores distintos'
);

select throws_ok(
  $$
    insert into public.product_suppliers (supplier_id, scope_type, variant_id, purchase_unit_label, pack_units)
    select '60000000-0000-4000-8000-000000000001', 'variant', v.id, 'caja', 12
    from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';
  $$,
  '23505'::text,
  null::text,
  'El mismo proveedor no repite la misma presentación de la misma variante'
);

select lives_ok(
  $$
    insert into public.product_suppliers (
      id, supplier_id, scope_type, variant_id, supplier_sku, purchase_unit_label, pack_units
    )
    select '61000000-0000-4000-8000-000000000012', '60000000-0000-4000-8000-000000000001',
           'variant', v.id, 'DL-ESM-ROJO-UN', 'unidad', 1
    from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';
  $$,
  'El mismo proveedor sí puede ofrecer la variante suelta y en caja'
);

-- «Este distribuidor lo tiene, falta cotizar» es el estado más común al cargar
-- 1.500 SKU: registrar el primer proveedor de una variante no exige su costo.
select lives_ok(
  $$
    insert into public.product_suppliers (
      id, supplier_id, scope_type, variant_id, supplier_sku, purchase_unit_label, pack_units, is_preferred
    )
    select '61000000-0000-4000-8000-000000000004', '60000000-0000-4000-8000-000000000001',
           'variant', v.id, 'DL-ESM-NUDE', 'caja', 12, true
    from public.product_variants v where v.sku = 'DEMO-ESM-NUDE';
  $$,
  'El primer proveedor de una variante se registra sin costo cotizado'
);

-- Cobertura de línea: el distribuidor trae toda la marca.
insert into public.product_suppliers (
  id, supplier_id, scope_type, product_id, supplier_sku, is_preferred
)
select
  '61000000-0000-4000-8000-000000000005', '60000000-0000-4000-8000-000000000003',
  'product', v.product_id, 'GC-LINEA-MASGLO', true
from public.product_variants v where v.sku = 'DEMO-ESM-ROJO';

-- ---------------------------------------------------------------------------
-- Costos
-- ---------------------------------------------------------------------------

insert into public.supplier_cost_agreements (
  id, product_supplier_id, currency, includes_tax, tax_rate, validity, source
) values (
  '62000000-0000-4000-8000-000000000001', '61000000-0000-4000-8000-000000000001',
  'PEN', true, 0.18, tstzrange(now() - interval '90 days', null, '[)'), 'invoice'
);

insert into public.supplier_cost_tiers (agreement_id, quantity_range, unit_cost)
values
  ('62000000-0000-4000-8000-000000000001', int4range(1, 10, '[)'), 118.0000),
  ('62000000-0000-4000-8000-000000000001', int4range(10, null, '[)'), 106.2000);

insert into public.supplier_cost_agreements (
  id, product_supplier_id, currency, includes_tax, tax_rate, source, reference_exchange_rate
) values (
  '62000000-0000-4000-8000-000000000002', '61000000-0000-4000-8000-000000000002',
  'USD', false, 0.18, 'quote', 3.790000
);

insert into public.supplier_cost_tiers (agreement_id, quantity_range, unit_cost)
values ('62000000-0000-4000-8000-000000000002', int4range(1, null, '[)'), 2.2000);

insert into public.supplier_cost_agreements (
  id, product_supplier_id, currency, includes_tax, tax_rate, source
) values (
  '62000000-0000-4000-8000-000000000003', '61000000-0000-4000-8000-000000000003',
  'PEN', true, 0.18, 'whatsapp'
);

insert into public.supplier_cost_tiers (agreement_id, quantity_range, unit_cost)
values ('62000000-0000-4000-8000-000000000003', int4range(1, null, '[)'), 110.0000);

-- «Lleva 2 cajas, te regalo 1».
insert into public.supplier_bonuses (
  product_supplier_id, buy_quantity, free_quantity, is_repeatable, label
) values (
  '61000000-0000-4000-8000-000000000001', 2, 1, true, 'Lleva 2 cajas, paga 2 y recibe 3'
);

select throws_ok(
  $$
    insert into public.supplier_cost_tiers (agreement_id, quantity_range, unit_cost)
    values ('62000000-0000-4000-8000-000000000001', int4range(5, 20, '[)'), 100.0000);
  $$,
  '23P01'::text,
  null::text,
  'Dos escalas que se pisan dejarían una cantidad sin costo único'
);

-- La moneda está fuera de la clave de exclusión a propósito: si estuviera
-- dentro, un costo en soles y otro en dólares podrían regir a la vez y el costo
-- quedaría indeterminado.
select throws_ok(
  $$
    insert into public.supplier_cost_agreements (product_supplier_id, currency, includes_tax)
    values ('61000000-0000-4000-8000-000000000001', 'USD', false);
  $$,
  '23P01'::text,
  null::text,
  'Cambiar de moneda no permite un segundo costo vigente para la misma oferta'
);

select throws_ok(
  $$
    update public.supplier_cost_tiers
    set unit_cost = 1.0000
    where agreement_id = '62000000-0000-4000-8000-000000000001'
      and lower(quantity_range) = 1;
  $$,
  '42501'::text,
  null::text,
  'Un costo ya vigente no se reescribe: el margen de marzo no cambia hoy'
);

select throws_ok(
  $$
    update public.product_suppliers
    set pack_units = 6
    where id = '61000000-0000-4000-8000-000000000001';
  $$,
  '42501'::text,
  null::text,
  'La presentación de compra es inmutable una vez que la oferta tiene costos'
);

-- Un vínculo de línea no tiene presentación de compra: no puede llevar importe.
select throws_ok(
  $$
    insert into public.supplier_cost_agreements (product_supplier_id, currency)
    values ('61000000-0000-4000-8000-000000000005', 'PEN');
  $$,
  '23503'::text,
  null::text,
  'Un vínculo de alcance producto no admite un acuerdo de costo'
);

-- ---------------------------------------------------------------------------
-- Tipo de cambio
-- ---------------------------------------------------------------------------

select is(
  public.exchange_rate('USD', 'PEN'),
  3.800000::numeric,
  'La conversión usa el tipo de cambio venta del día'
);

select is(
  public.exchange_rate('USD', 'PEN', current_date + 400, 'sell', 30),
  null::numeric,
  'Una tasa fuera de plazo devuelve null en vez de aplicarse en silencio'
);

-- ---------------------------------------------------------------------------
-- ¿A quién le conviene comprarle esto hoy?
-- ---------------------------------------------------------------------------

set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (
    select r.supplier_name
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.viable
    order by r.net_unit_cost_pen
    limit 1
  ),
  'Distribuidora Lima',
  'La primera opción viable es la más barata puesta en soles'
);

-- 2.20 USD parece mucho más barato que 118.00 PEN, y no lo es.
select cmp_ok(
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.supplier_id = '60000000-0000-4000-8000-000000000002'
  ),
  '>',
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  'El costo en dólares se compara convertido a soles, no en nominal'
);

-- S/ 118 con factura cuesta S/ 100; S/ 110 sin comprobante cuesta S/ 110.
select cmp_ok(
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  '<',
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000003'
  ),
  'El IGV recuperable no es costo: el formal gana al informal más barato en nominal'
);

-- La bonificación no es un descuento: baja el denominador.
select cmp_ok(
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 24
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  '<',
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  'Lleva 2 paga 2 y recibe 3 baja el costo por unidad recibida'
);

-- Las opciones no viables no se filtran: se devuelven con su motivo.
select ok(
  (
    select 'no alcanza el pedido mínimo: 100 unidad' = any(r.blockers)
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000002'
  ),
  'El pedido mínimo se explica en vez de ocultar la opción'
);

select ok(
  (
    select 'no entrega en esta sede' = any(r.blockers)
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000002'
  ),
  'La sede que el proveedor no atiende aparece como motivo, no como ausencia'
);

select cmp_ok(
  (
    select count(*)::integer
    from public.product_supplier_options o
    join public.product_variants v on v.id = o.variant_id
    where v.sku = 'DEMO-ESM-ROJO'
  ),
  '>=',
  3,
  'La vista responde la pregunta 9 también al nivel de producto'
);

-- ---------------------------------------------------------------------------
-- Historial de costos: la sucesión de vigencias
-- ---------------------------------------------------------------------------

select isnt(
  public.set_supplier_cost_agreement(
    '61000000-0000-4000-8000-000000000001',
    '[{"from":1,"to":10,"unitCost":124.00},{"from":10,"unitCost":112.00}]'::jsonb
  ),
  null,
  'Registrar un costo nuevo devuelve el acuerdo creado'
);

select is(
  (
    select count(*)::integer
    from public.supplier_cost_agreements a
    where a.product_supplier_id = '61000000-0000-4000-8000-000000000001'
      and a.is_active
      and not upper_inf(a.validity)
  ),
  1,
  'El acuerdo anterior queda cerrado, no borrado'
);

select cmp_ok(
  (
    select h.unit_cost
    from public.supplier_cost_history(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'),
      '60000000-0000-4000-8000-000000000001'
    ) h
    where h.effective_to is not null and h.quantity_from = 1
  ),
  '=',
  118.0000::numeric,
  'El historial conserva a cuánto se compraba antes del alza'
);

reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- La misma función, dos roles: la RLS hace el recorte
-- ---------------------------------------------------------------------------
-- resolve_variant_supply no es security definer, así que se ejecuta con los
-- privilegios de quien llama. La vendedora necesita contestar «¿cuándo lo
-- tienes?» sin conocer el margen del negocio.

set local request.jwt.claims = '{"sub":"50000000-0000-4000-8000-000000000002","role":"authenticated"}';
set local role authenticated;

select isnt(
  (
    select r.supplier_name
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  null,
  'La vendedora sí ve quién provee y en cuánto llega'
);

select is(
  (
    select r.net_unit_cost_pen
    from public.resolve_variant_supply(
      (select v.id from public.product_variants v where v.sku = 'DEMO-ESM-ROJO'), 12
    ) r
    where r.product_supplier_id = '61000000-0000-4000-8000-000000000001'
  ),
  null::numeric,
  'La vendedora no ve ningún costo, sin necesidad de permisos por columna'
);

reset role;
reset request.jwt.claims;

-- ---------------------------------------------------------------------------
-- Guardianes diferidos
-- ---------------------------------------------------------------------------
-- Escalera de prueba, todavía con las restricciones diferidas.

insert into public.supplier_cost_agreements (id, product_supplier_id, currency)
values ('62000000-0000-4000-8000-000000000004', '61000000-0000-4000-8000-000000000004', 'PEN');

insert into public.supplier_cost_tiers (agreement_id, quantity_range, unit_cost)
values
  ('62000000-0000-4000-8000-000000000004', int4range(1, 12, '[)'), 90.0000),
  ('62000000-0000-4000-8000-000000000004', int4range(12, null, '[)'), 84.0000);

-- Sin esto se evaluarían en el commit, que nunca llega porque la prueba termina
-- en rollback.
set constraints all immediate;

select throws_ok(
  $$
    update public.product_suppliers
    set is_preferred = false
    where id = '61000000-0000-4000-8000-000000000001';
  $$,
  '23514'::text,
  null::text,
  'Una variante con proveedores activos no se queda sin preferido'
);

select throws_ok(
  $$
    insert into public.supplier_cost_agreements (product_supplier_id, currency)
    values ('61000000-0000-4000-8000-000000000012', 'PEN');
  $$,
  '23514'::text,
  null::text,
  'Un acuerdo de costo sin ninguna escala no puede quedar vigente'
);

-- La exclusión GiST impide solapes pero NO huecos: quitar el último tramo deja
-- la escalera sin cierre y una cantidad grande sin costo.
select throws_ok(
  $$
    delete from public.supplier_cost_tiers
    where agreement_id = '62000000-0000-4000-8000-000000000004'
      and lower(quantity_range) = 12;
  $$,
  '23514'::text,
  null::text,
  'Una escalera con hueco o sin tramo abierto final se rechaza'
);

select * from finish();

rollback;