begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- 0060 dejó la regla consultable; esto comprueba que además OBLIGA. La
-- diferencia es la que separa «la pantalla lo pide» de «no se puede registrar
-- de otra manera»: un script, el asistente o una pantalla futura no pasan por
-- la pantalla, y tienen que chocar igual.
--
-- El disparador es DIFERIDO —se evalúa al cerrar la transacción, cuando la
-- venta ya tiene sus roles escritos—, así que cada caso lo fuerza con
-- `set constraints all immediate` en lugar de esperar al commit.
--
-- Los casos que fallan borran su venta al terminar en vez de volver a un
-- savepoint: `rollback to savepoint` descartaría también las anotaciones de
-- pgTAP y el fichero acabaría diciendo que no corrió ninguna prueba.
--
-- Las ventas van sin líneas y con importes en cero: aquí no se prueba la
-- aritmética de la venta, sino a quién se le entrega.

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'OBLIGA', 'Sede de la restricción', 'Lima', false, 949
from public.companies c limit 1;

create temporary table fx on commit drop as
select (select id from public.branches where code = 'OBLIGA') as branch_id;

create or replace function pg_temp.nueva_venta(p_metodo text, p_nombre text default null,
                                               p_tel text default null, p_doc text default null)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                            gross_subtotal, discount_total, total,
                            customer_name, customer_phone, customer_document)
  select v_id, fx.branch_id, 'NV-OB-' || left(v_id::text, 6),
         p_metodo::public.fulfillment_method, gen_random_uuid(), 0, 0, 0,
         p_nombre, p_tel, p_doc
  from fx;
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Lo que NO se puede registrar
-- ---------------------------------------------------------------------------
create temporary table v1 on commit drop as select pg_temp.nueva_venta('local_delivery') as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Para entregar esta venta falta a quién se le entrega, un teléfono de contacto y la dirección.',
  '1 · un delivery sin destinatario no se puede cerrar, y se dice qué falta'
);
set constraints all deferred;
delete from public.sales where id = (select id from v1);

create temporary table v2 on commit drop as select pg_temp.nueva_venta('pickup') as id;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Para entregar esta venta falta a quién se le entrega.',
  '2 · un recojo sin decir quién viene tampoco'
);
set constraints all deferred;
delete from public.sales where id = (select id from v2);

-- El envío es el único que exige documento, y no por simetría: la agencia lo
-- pide para liberar el paquete.
create temporary table v3 on commit drop as select pg_temp.nueva_venta('shipping') as id;
insert into public.sale_parties (sale_id, role, full_name, phone, address)
select id, 'recipient', 'Carmen Díaz', '999111222', 'Av. El Sol 890, Cusco' from v3;
select throws_ok(
  'set constraints all immediate',
  '23514',
  'Para entregar esta venta falta el documento del destinatario.',
  '3 · un envío sin documento del destinatario no sale'
);
set constraints all deferred;
delete from public.sales where id = (select id from v3);

-- ---------------------------------------------------------------------------
-- Lo que SÍ, y sin pedir de más
-- ---------------------------------------------------------------------------
select pg_temp.nueva_venta('in_store');
select lives_ok(
  'set constraints all immediate',
  '4 · en el mostrador no se pide nada: se le entrega a quien está delante'
);
set constraints all deferred;

create temporary table v5 on commit drop as
select pg_temp.nueva_venta('local_delivery', 'Rosa Díaz', '987654321') as id;
insert into public.sale_parties (sale_id, role, is_buyer, address)
select id, 'recipient', true, 'Av. Los Álamos 123, Surco' from v5;
select lives_ok(
  'set constraints all immediate',
  '5 · recibe la clienta: basta marcarlo, sin copiar un solo dato suyo'
);
set constraints all deferred;

create temporary table v6 on commit drop as
select pg_temp.nueva_venta('local_delivery', 'Rosa Díaz', '987654321') as id;
insert into public.sale_parties (sale_id, role, full_name, phone, address)
select id, 'recipient', 'Carmen Díaz', '999111222', 'Jr. Puno 456, Lince' from v6;
select lives_ok(
  'set constraints all immediate',
  '6 · recibe su hermana: datos de esta entrega, sin crearle ficha a nadie'
);
set constraints all deferred;

create temporary table v7 on commit drop as
select pg_temp.nueva_venta('pickup', 'Rosa Díaz') as id;
insert into public.sale_parties (sale_id, role, full_name)
select id, 'pickup_authorized', 'Luis Ramos' from v7;
select lives_ok(
  'set constraints all immediate',
  '7 · lo recoge un tercero: con su nombre alcanza, el documento no se exige'
);
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- Y no se puede deshacer por la puerta de atrás
-- ---------------------------------------------------------------------------
-- Quitar al destinatario después de cerrar dejaría la venta igual de
-- inentregable que no haberlo puesto nunca.
create temporary table v8 on commit drop as
select pg_temp.nueva_venta('local_delivery', 'Rosa Díaz', '987654321') as id;
insert into public.sale_parties (sale_id, role, is_buyer, address)
select id, 'recipient', true, 'Av. Los Álamos 123, Surco' from v8;
-- La venta queda completa y validada...
set constraints all immediate;
-- ...y a partir de aquí el borrado choca en el acto, sin esperar al cierre.
select throws_ok(
  'delete from public.sale_parties where sale_id = (select id from v8)',
  '23514',
  'Para entregar esta venta falta a quién se le entrega, un teléfono de contacto y la dirección.',
  '8 · borrar al destinatario de una venta ya cerrada tampoco se permite'
);
set constraints all deferred;

-- ---------------------------------------------------------------------------
-- El detalle cuenta quién recibe, con los datos ya resueltos
-- ---------------------------------------------------------------------------
-- Marcando `is_buyer` y nada más, el detalle devuelve el nombre de la
-- compradora: la nota puede imprimir a quién se le entrega sin que nadie haya
-- copiado sus datos a la entrega.
select is(
  (select public.sale_detail(id) -> 'parties' -> 0 ->> 'fullName' from v5),
  'Rosa Díaz',
  '9 · el detalle resuelve los datos del rol sin haberlos duplicado'
);

select * from finish();

rollback;
