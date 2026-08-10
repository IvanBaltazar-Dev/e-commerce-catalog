begin;

create extension if not exists pgtap with schema extensions;

select plan(19);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- La pregunta que responde esta prueba es la de la vendedora cuando la clienta
-- dice «sí, pero mándaselo a mi hermana»: ¿qué hace falta saber para que ese
-- pedido salga, y qué NO hace falta preguntar dos veces?
--
-- Las ocho filas de abajo son los ocho casos reales del mostrador. Cada una
-- comprueba lo mismo desde un ángulo distinto: que la regla pide lo que de
-- verdad se necesita para entregar, y ni un dato más.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000','fb000000-0000-4000-8000-000000000001','authenticated','authenticated','entregas-vendedora@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
  ('00000000-0000-0000-0000-000000000000','fb000000-0000-4000-8000-000000000002','authenticated','authenticated','entregas-ajena@example.invalid','',now(),'{}','{}',now(),now(),'','','','');

insert into public.admin_profiles(id, role, full_name) values
  ('fb000000-0000-4000-8000-000000000001','seller','Vendedora de la sede'),
  ('fb000000-0000-4000-8000-000000000002','seller','Vendedora de otra sede');

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'ENTREGAS', 'Sede de entregas', 'Lima', false, 948
from public.companies c limit 1;

insert into public.staff_branches (staff_id, branch_id)
select 'fb000000-0000-4000-8000-000000000001'::uuid, b.id
from public.branches b where b.code = 'ENTREGAS';

-- La compradora con ficha: es la del caso 5, la que compra y recibe ella misma.
-- El teléfono es de un rango imposible a propósito: `persons_phone_unique` es
-- global, y un número verosímil choca contra cualquier clienta que exista en la
-- base donde se corran las pruebas.
insert into public.persons (id, full_name, phone_normalized, document_number) values
  ('fb000000-0000-4000-8000-0000000000a1','Rosa Díaz','900000601','45678912');

-- Ocho ventas, una por caso. Los datos de `customer_*` son la instantánea de la
-- COMPRADORA tal como se escribió al vender: lo que imprime la nota.
insert into public.sales (
  id, branch_id, sale_number, fulfillment_method, client_operation_id,
  gross_subtotal, total,
  customer_name, customer_phone, customer_document, delivery_address, person_id
)
select
  v.id::uuid, b.id, v.numero, v.metodo::public.fulfillment_method, gen_random_uuid(),
  50, 50, v.nombre, v.telefono, v.documento, v.direccion, v.person_id::uuid
from public.branches b,
  (values
    -- 1 · mostrador sin clienta: se entrega en la mano, no hace falta saber nada
    ('fb000000-0000-4000-8000-000000000101','NV-P01','in_store',       null,        null,          null,       null, null),
    -- 2 · recojo sin decir quién va a venir
    ('fb000000-0000-4000-8000-000000000102','NV-P02','pickup',         null,        null,          null,       null, null),
    -- 3 · delivery a ciegas
    ('fb000000-0000-4000-8000-000000000103','NV-P03','local_delivery', null,        null,          null,       null, null),
    -- 4 · envío a provincia a ciegas
    ('fb000000-0000-4000-8000-000000000104','NV-P04','shipping',       null,        null,          null,       null, null),
    -- 5 · la clienta compra y recibe ella misma: sus datos ya están en la venta
    ('fb000000-0000-4000-8000-000000000105','NV-P05','local_delivery', 'Rosa Díaz', '987 654 321', '45678912', 'Av. Los Álamos 123, Surco', 'fb000000-0000-4000-8000-0000000000a1'),
    -- 6 · recibe otra persona, sin ficha: son datos de ESTA entrega
    ('fb000000-0000-4000-8000-000000000106','NV-P06','local_delivery', 'Rosa Díaz', '987 654 321', '45678912', null, 'fb000000-0000-4000-8000-0000000000a1'),
    -- 7 · recoge un tercero
    ('fb000000-0000-4000-8000-000000000107','NV-P07','pickup',         'Rosa Díaz', '987 654 321', '45678912', null, 'fb000000-0000-4000-8000-0000000000a1'),
    -- 8 · envío completo con destinatario
    ('fb000000-0000-4000-8000-000000000108','NV-P08','shipping',       'Rosa Díaz', '987 654 321', '45678912', null, 'fb000000-0000-4000-8000-0000000000a1')
  ) as v(id, numero, metodo, nombre, telefono, documento, direccion, person_id)
where b.code = 'ENTREGAS';

-- Caso 5: «recibe la clienta». La fila NO copia ningún dato — es justamente lo
-- que `is_buyer` viene a permitir.
insert into public.sale_parties (sale_id, role, is_buyer) values
  ('fb000000-0000-4000-8000-000000000105','recipient', true);

-- Caso 6: la hermana. Datos sueltos, sin ficha, y la dirección es de la entrega.
insert into public.sale_parties (sale_id, role, full_name, phone, address) values
  ('fb000000-0000-4000-8000-000000000106','recipient','Carmen Díaz','999111222','Jr. Puno 456, Lince');

-- Caso 7: el motorizado que pasa a recogerlo.
insert into public.sale_parties (sale_id, role, full_name) values
  ('fb000000-0000-4000-8000-000000000107','pickup_authorized','Luis Ramos');

-- Caso 8: envío a provincia, con el documento que pide la agencia.
insert into public.sale_parties (sale_id, role, full_name, phone, document_number, address) values
  ('fb000000-0000-4000-8000-000000000108','recipient','Carmen Díaz','999111222','70123456','Av. El Sol 890, Cusco');

select has_table('public','sale_parties','los roles de una venta tienen dónde vivir');
select has_table('public','fulfillment_requirements','lo que exige cada método es un dato, no código');

-- ---------------------------------------------------------------------------
-- Los ocho casos del mostrador
-- ---------------------------------------------------------------------------
select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000101'), '{}'::text[],
  '1 · en el mostrador no falta nada: se le entrega a quien está delante'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000102'), array['recipient'],
  '2 · un recojo sin decir quién viene no se puede entregar'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000103'),
  array['recipient','phone','address'],
  '3 · un delivery a ciegas pide destinatario, teléfono y dirección — y NO documento'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000104'),
  array['recipient','phone','document','address'],
  '4 · un envío a provincia sí añade el documento: la agencia lo pide para liberar el paquete'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000105'), '{}'::text[],
  '5 · «recibe la clienta»: marcando is_buyer, sin copiar un solo dato, la regla queda satisfecha'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000106'), '{}'::text[],
  '6 · recibe la hermana: datos sueltos, sin obligar a crearle una ficha'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000107'), '{}'::text[],
  '7 · lo recoge un tercero: basta con su nombre'
);

select is(
  public.sale_fulfillment_gaps('fb000000-0000-4000-8000-000000000108'), '{}'::text[],
  '8 · envío completo: nada que pedir'
);

-- ---------------------------------------------------------------------------
-- Una fila tiene que identificar a alguien — y `is_buyer` identifica
-- ---------------------------------------------------------------------------
-- Esta es la contradicción que la comprobación tenía: `is_buyer` existe para
-- decir «recibe la clienta» SIN repetir sus datos, y exigir ficha o nombre
-- rechazaba precisamente esa fila. El caso 5 de arriba no era insertable.
select lives_ok(
  $$insert into public.sale_parties (sale_id, role, is_buyer)
    values ('fb000000-0000-4000-8000-000000000103','recipient', true)$$,
  'decir «es la compradora» basta para identificar a quien recibe'
);

select throws_ok(
  $$insert into public.sale_parties (sale_id, role)
    values ('fb000000-0000-4000-8000-000000000104','recipient')$$,
  '23514',
  null,
  'una fila que no dice quién es —ni ficha, ni nombre, ni la compradora— no entra'
);

-- ---------------------------------------------------------------------------
-- La regla es configuración, y dice lo que Ivan pidió que dijera
-- ---------------------------------------------------------------------------
select is(
  (select requires_document from public.fulfillment_requirements where method = 'local_delivery'),
  false,
  'el delivery NO exige documento: nadie lo necesita para tocar un timbre'
);

select is(
  (select requires_document from public.fulfillment_requirements where method = 'shipping'),
  true,
  'el envío sí, y por un motivo operativo concreto, no por simetría'
);

-- ---------------------------------------------------------------------------
-- Las dos puertas: política Y privilegio
-- ---------------------------------------------------------------------------
-- Aquí dentro hay nombre, celular, documento y dirección de gente que ni
-- siquiera compró. Merece el mismo cuidado que la caja.
select is(
  (select relrowsecurity from pg_class where oid = 'public.sale_parties'::regclass),
  true,
  'sale_parties no vive sin RLS'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.fulfillment_requirements'::regclass),
  true,
  'fulfillment_requirements tampoco'
);

set local role authenticated;
set local request.jwt.claims to '{"sub":"fb000000-0000-4000-8000-000000000001","role":"authenticated"}';

select is(
  (select count(*)::int from public.sale_parties),
  5,
  'la vendedora de la sede ve a quién se le entrega en su sede'
);

select is(
  (select count(*)::int from public.fulfillment_requirements),
  4,
  'y lee la regla: la pantalla necesita saber qué pedir antes de cobrar'
);

set local request.jwt.claims to '{"sub":"fb000000-0000-4000-8000-000000000002","role":"authenticated"}';

select is(
  (select count(*)::int from public.sale_parties),
  0,
  'quien vende en otra sede no lee a dónde se entrega en esta'
);

select * from finish();

rollback;
