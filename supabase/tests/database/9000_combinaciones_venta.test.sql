begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

-- ---------------------------------------------------------------------------
-- La batería de combinaciones · no pertenece a una migración
-- ---------------------------------------------------------------------------
-- El número 9000 es a propósito: no hay migración 9000. Los demás ficheros de
-- esta carpeta prueban UNA migración; este prueba el FLUJO que atraviesan
-- 0060-0065 juntas, y por eso corre al final.
--
-- Lo que cubre y ningún otro fichero cubre:
--
--   · Que los CUATRO roles de una persona en una venta convivan sin pisarse.
--     Es la afirmación que abrió todo este bloque —compradora ≠ destinataria ≠
--     quien recoge ≠ receptor fiscal— y hasta aquí estaba probada por partes:
--     los tres primeros en 0060, el cuarto en ninguna parte.
--   · `request_tax_document`, que no tenía una sola prueba. De 0029 solo se
--     comprobaba que la TABLA existiera.
--   · Una venta sin clienta con delivery, que es lo normal por WhatsApp.
--   · Reserva con y sin clienta, por el contrato de verdad.
--
-- Todo pasa por los contratos (`register_sale`, `create_reservation`,
-- `request_tax_document`), no por INSERT a mano: lo que se prueba es lo que la
-- pantalla llama, no una versión simplificada.

-- El fixture comercial se crea dentro de esta transacción. La suite ya no
-- depende de que el catálogo operativo conserve productos o stock DEMO.
insert into public.inventory_stock(variant_id, branch_id, on_hand, reserved)
select variant.id, branch.id, 30, 0
from public.product_variants variant
join public.products product on product.id=variant.product_id
cross join public.branches branch
where variant.is_active and variant.tracks_inventory
  and product.is_active and product.editorial_status='published'
  and branch.code='PRINCIPAL'
  and coalesce(product.unit_price,0)>2
order by variant.id
limit 1
on conflict (variant_id,branch_id) do update
set on_hand=greatest(public.inventory_stock.on_hand,30), reserved=0;

create temporary table fx on commit drop as
select
  b.id as branch_id,
  v.variant_id,
  v.precio
from public.branches b
cross join lateral (
  select pv.id as variant_id,
         (public.evaluate_cart_v2(jsonb_build_array(
            jsonb_build_object('variantId', pv.id, 'quantity', 1))) -> 'lines' -> 0 ->> 'unitPrice')::numeric as precio
  from public.product_variants pv
  join public.inventory_stock st on st.variant_id = pv.id and st.branch_id = b.id
  where pv.is_active and st.on_hand - st.reserved >= 6
  limit 1
) v
where b.code = 'PRINCIPAL';

-- Si el entorno no tiene existencia suficiente la prueba mentiría diciendo que
-- pasa: mejor que lo diga de frente.
select isnt((select variant_id from fx), null,
  '0 · el entorno tiene una presentación con precio y existencia para vender');

insert into public.persons (id, full_name, phone_normalized, document_number) values
  ('f9000000-0000-4000-8000-0000000000a1','Rosa Díaz','900000901','45678912');

-- ---------------------------------------------------------------------------
-- Los cuatro roles, cada uno con su documento
-- ---------------------------------------------------------------------------
-- Rosa compra, su hermana Carmen recibe, y la boleta va a nombre de la empresa
-- donde Rosa trabaja. Tres personas, tres documentos, tres sitios distintos.
create temporary table v_roles on commit drop as
select public.register_sale(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 2)),
  jsonb_build_array(jsonb_build_object('method', 'yape', 'amount', (select precio * 2 from fx), 'reference', '00900901')),
  gen_random_uuid(), 'whatsapp'::public.sale_source_channel, 'local_delivery'::public.fulfillment_method,
  jsonb_build_object('name', 'Rosa Díaz', 'phone', '900000901', 'document', '45678912'),
  0, null, null, null, 'store_quick'::public.sale_entry_mode, null,
  'f9000000-0000-4000-8000-0000000000a1'::uuid,
  jsonb_build_array(jsonb_build_object(
    'role', 'recipient', 'fullName', 'Carmen Díaz', 'phone', '999111222',
    'documentNumber', '70123456', 'address', 'Jr. Puno 456, Lince'
  ))
) as detail;

create temporary table v_roles_id on commit drop as
select (detail ->> 'id')::uuid as id from v_roles;

-- El comprobante se pide DESPUÉS y con datos propios: no hereda ninguno.
create temporary table v_fiscal on commit drop as
select public.request_tax_document(
  (select id from v_roles_id),
  'invoice'::public.tax_document_kind,
  jsonb_build_object('taxId', '20512345678', 'name', 'DISTRIBUIDORA EJEMPLO S.A.C.',
                     'address', 'Av. Industrial 100, Ate')
) as detail;

select is(
  (select detail -> 'parties' -> 0 ->> 'documentNumber' from v_fiscal),
  '70123456',
  '1 · el documento del destinatario es el suyo, no el de la compradora'
);

select is(
  (select detail ->> 'customerDocument' from v_fiscal),
  '45678912',
  '2 · y el de la compradora sigue siendo el suyo, sin que la entrega lo pise'
);

select is(
  (select detail -> 'taxDocument' ->> 'receiverTaxId' from v_fiscal),
  '20512345678',
  '3 · el receptor fiscal tiene su propio RUC: no se reutiliza ningún DNI'
);

select is(
  (select detail -> 'taxDocument' ->> 'receiverName' from v_fiscal),
  'DISTRIBUIDORA EJEMPLO S.A.C.',
  '4 · a nombre de quien corresponde, que no es ninguna de las dos personas'
);

-- La ficha de Rosa no se completó ni se tocó con los datos de su hermana.
select is(
  (select document_number from public.persons where id = 'f9000000-0000-4000-8000-0000000000a1'),
  '45678912',
  '5 · la ficha de la clienta no aprende el documento de quien recibió por ella'
);

-- Pedir el comprobante otra vez lo REEMPLAZA, no lo duplica: una venta tiene un
-- comprobante, y corregir un RUC mal tecleado no puede crear un segundo.
select public.request_tax_document(
  (select id from v_roles_id), 'sales_receipt'::public.tax_document_kind,
  jsonb_build_object('taxId', '45678912', 'name', 'Rosa Díaz')
);

select is(
  (select count(*)::int from public.tax_document_requests where sale_id = (select id from v_roles_id)),
  1,
  '6 · corregir el comprobante lo reemplaza; una venta no acumula dos'
);

-- ---------------------------------------------------------------------------
-- Venta SIN clienta y con delivery — lo normal por WhatsApp
-- ---------------------------------------------------------------------------
-- Nadie crea una ficha para mandar un pedido. Se piden los datos de la entrega
-- y ya está.
create temporary table v_sin_clienta on commit drop as
select public.register_sale(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 1)),
  jsonb_build_array(jsonb_build_object('method', 'plin', 'amount', (select precio from fx), 'reference', '00900902')),
  gen_random_uuid(), 'whatsapp'::public.sale_source_channel, 'local_delivery'::public.fulfillment_method,
  null, 0, null, null, null, 'store_quick'::public.sale_entry_mode, null, null,
  jsonb_build_array(jsonb_build_object(
    'role', 'recipient', 'fullName', 'Lucía Vega', 'phone', '988777666',
    'address', 'Calle Los Pinos 12, Surco'
  ))
) as detail;

select is(
  (select detail ->> 'customerName' from v_sin_clienta), null,
  '7 · una venta con delivery no exige clienta: se vende sin ficha y sin nombre'
);

select is(
  (select detail -> 'parties' -> 0 ->> 'fullName' from v_sin_clienta), 'Lucía Vega',
  '8 · y aun así se sabe a quién se le entrega'
);

select is(
  (select public.sale_fulfillment_gaps((detail ->> 'id')::uuid) from v_sin_clienta), '{}'::text[],
  '9 · sin nada que reclamar: el delivery está completo'
);

-- ---------------------------------------------------------------------------
-- Reserva, con y sin clienta
-- ---------------------------------------------------------------------------
create temporary table r_con on commit drop as
select public.create_reservation(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 1)),
  jsonb_build_object('name', 'Rosa Díaz', 'phone', '900000901'),
  now() + interval '2 days',
  gen_random_uuid(),
  jsonb_build_object('method', 'yape', 'amount', 5, 'reference', '00900903'),
  null,
  'f9000000-0000-4000-8000-0000000000a1'::uuid
) as detail;

select is(
  (select detail ->> 'personId' from r_con), 'f9000000-0000-4000-8000-0000000000a1',
  '10 · una reserva con clienta guarda el enlace, no solo cómo se llamaba'
);

create temporary table r_sin on commit drop as
select public.create_reservation(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 1)),
  jsonb_build_object('name', 'Señora del mercado'),
  now() + interval '2 days',
  gen_random_uuid()
) as detail;

select is(
  (select detail ->> 'personId' from r_sin), null,
  '11 · y una sin clienta se guarda igual, sin inventarle una ficha'
);

-- La venta que nace de la reserva HEREDA su clienta sin que nadie la pase.
create temporary table v_desde_reserva on commit drop as
select public.register_sale(
  (select branch_id from fx), null,
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', (select precio - 5 from fx))),
  gen_random_uuid(), 'in_store'::public.sale_source_channel, 'in_store'::public.fulfillment_method,
  null, 0, null, (select (detail ->> 'id')::uuid from r_con), null,
  'reservation'::public.sale_entry_mode, null, null, null
) as detail;

select is(
  (select detail ->> 'personId' from v_desde_reserva), 'f9000000-0000-4000-8000-0000000000a1',
  '12 · la venta hereda la clienta de su reserva sin que el llamador la pase'
);

create temporary table v_desde_reserva_sin on commit drop as
select public.register_sale(
  (select branch_id from fx), null,
  jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', (select precio from fx))),
  gen_random_uuid(), 'in_store'::public.sale_source_channel, 'in_store'::public.fulfillment_method,
  null, 0, null, (select (detail ->> 'id')::uuid from r_sin), null,
  'reservation'::public.sale_entry_mode, null, null, null
) as detail;

select is(
  (select detail ->> 'personId' from v_desde_reserva_sin), null,
  '13 · y de una reserva sin clienta no sale una clienta de la nada'
);

-- ---------------------------------------------------------------------------
-- Pagos: Yape solo y Yape acompañado
-- ---------------------------------------------------------------------------
create temporary table v_yape on commit drop as
select public.register_sale(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 1)),
  jsonb_build_array(jsonb_build_object('method', 'yape', 'amount', (select precio from fx), 'reference', '00900904')),
  gen_random_uuid()
) as detail;

select is(
  (select detail -> 'payments' -> 0 ->> 'reference' from v_yape), '00900904',
  '14 · un Yape único conserva su número de operación en la venta'
);

create temporary table v_dividido on commit drop as
select public.register_sale(
  (select branch_id from fx),
  jsonb_build_array(jsonb_build_object('variantId', (select variant_id from fx), 'quantity', 1)),
  jsonb_build_array(
    jsonb_build_object('method', 'cash', 'amount', 2, 'tenderedAmount', 2),
    jsonb_build_object('method', 'yape', 'amount', (select precio - 2 from fx), 'reference', '00900905')
  ),
  gen_random_uuid()
) as detail;

-- Cada medio con su importe y su código: es lo que hace cuadrable un pago
-- dividido, y lo que la nota imprime línea a línea.
select results_eq(
  $$ select (p ->> 'method') || ':' || (p ->> 'amount')
     from v_dividido, jsonb_array_elements(detail -> 'payments') p
     order by 1 $$,
  $$ values ('cash:2.00'), ('yape:' || (select to_char(precio - 2, 'FM999999990.00') from fx)) $$,
  '15 · en un pago dividido cada medio conserva su importe, no se funden en uno'
);

select * from finish();

rollback;
