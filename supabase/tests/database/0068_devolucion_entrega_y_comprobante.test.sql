begin;

create extension if not exists pgtap with schema extensions;

select plan(20);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Cierra los tres pendientes del checklist y el comprobante:
--
--   0066 · el saldo descuenta lo devuelto. El defecto era de dinero: una clienta
--          que rechazaba parte del pedido al recibirlo pagaba igual por ella.
--   0067 · qué pasa cuando no se pudo entregar.
--   0068 · qué exige cada comprobante, y que no herede el documento de nadie.

insert into public.branches (company_id, code, name, district, is_default, sort_order)
select c.id, 'CIERRE', 'Sede del cierre', 'Lima', false, 953
from public.companies c limit 1;

create temporary table fx on commit drop as
select (select id from public.branches where code = 'CIERRE') as branch_id,
       (select id from public.product_variants where is_active order by created_at limit 1) as variant_id;

-- Una venta con su línea, para que cuadre la aritmética que vigila 0029.
create or replace function pg_temp.venta(p_total numeric, p_terms text default 'immediate',
                                          p_metodo text default 'in_store')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into public.sales (id, branch_id, sale_number, fulfillment_method, client_operation_id,
                            gross_subtotal, discount_total, total, payment_terms,
                            customer_name, customer_phone, customer_document, delivery_address)
  select v_id, fx.branch_id, 'NV-CI-' || left(v_id::text, 6),
         p_metodo::public.fulfillment_method, gen_random_uuid(),
         p_total, 0, p_total, p_terms::public.sale_payment_terms,
         'Rosa Díaz', '900000951', '45678912', 'Jr. Puno 456, Lince'
  from fx;

  insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name,
                                 quantity, unit_price, discount_amount, subtotal, purchase_mode, line_order)
  select v_id, fx.variant_id, 'CI-1', 'Producto de prueba', 'Único',
         1, p_total, 0, p_total, 'retail', 0
  from fx;

  if p_metodo <> 'in_store' then
    insert into public.sale_parties (sale_id, role, is_buyer) values (v_id, 'recipient', true);
  end if;
  return v_id;
end;
$$;

-- Registra una devolución valorada, sin devolver dinero: es el caso del defecto.
create or replace function pg_temp.devolver(p_sale uuid, p_valor numeric)
returns void language plpgsql as $$
declare v_ret uuid := gen_random_uuid();
begin
  insert into public.returns (id, sale_id, branch_id, return_number, refund_total, client_operation_id)
  select v_ret, p_sale, s.branch_id, 'DV-CI-' || left(v_ret::text, 6), 0, gen_random_uuid()
  from public.sales s where s.id = p_sale;

  insert into public.return_lines (return_id, sale_line_id, variant_id, quantity, condition, refund_amount, restocked)
  select v_ret, l.id, l.variant_id, 1, 'resellable', p_valor, false
  from public.sale_lines l where l.sale_id = p_sale limit 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- 0066 · El saldo descuenta lo devuelto
-- ---------------------------------------------------------------------------
create temporary table v1 on commit drop as select pg_temp.venta(60, 'on_delivery', 'local_delivery') as id;
insert into public.sale_payments (sale_id, method, amount, reference) select id, 'yape', 5, '00900951' from v1;

select is(
  (select public.sale_pending_amount(id) from v1), 55::numeric,
  '1 · antes de devolver nada, debe 55 de los 60'
);

select is(
  (select public.sale_payment_problem(id) from v1), null,
  '2 · y como venta contra entrega con su adelanto, está bien registrada'
);

-- La clienta rechaza una unidad de 15 al recibir. No se le devuelve dinero:
-- nunca pagó por ella.
select pg_temp.devolver((select id from v1), 15);

select is(
  (select public.sale_returned_amount(id) from v1), 15::numeric,
  '3 · la devolución queda registrada y valorada'
);

select is(
  (select public.sale_pending_amount(id) from v1), 40::numeric,
  '4 · y el saldo baja a 40: lo devuelto no se cobra'
);

-- Este es el defecto que se corrigió: cobrar el saldo ya no cobra de más.
select throws_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',55)), gen_random_uuid()) $$,
         (select id from v1)),
  '23514',
  'El saldo pendiente es 40.00 y lo que se está cobrando suma 55.00.',
  '5 · intentar cobrar los 55 de antes se rechaza, y se dice el importe correcto'
);

select lives_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',40)), gen_random_uuid()) $$,
         (select id from v1)),
  '6 · cobrar 40 sí: es lo que de verdad debe'
);

-- Una venta al contado con devolución y su reembolso queda en cero, que es la
-- comprobación por el otro lado de la misma fórmula.
create temporary table v2 on commit drop as select pg_temp.venta(60) as id;
insert into public.sale_payments (sale_id, method, amount) select id, 'cash', 60 from v2;
select pg_temp.devolver((select id from v2), 15);

select is(
  (select public.sale_pending_amount(id) from v2), -15::numeric,
  '7 · al contado, devolver 15 deja el saldo en −15: la tienda le debe a ella'
);

-- Y por eso no se le puede «cobrar» nada.
create temporary table v3 on commit drop as select pg_temp.venta(60, 'on_delivery', 'shipping') as id;
insert into public.sale_payments (sale_id, method, amount, reference) select id, 'yape', 50, '00900952' from v3;
select pg_temp.devolver((select id from v3), 30);

select throws_ok(
  format($$ select public.settle_sale_balance(%L::uuid,
            jsonb_build_array(jsonb_build_object('method','cash','amount',10)), gen_random_uuid()) $$,
         (select id from v3)),
  '23514',
  'Esta venta no tiene saldo por cobrar: la tienda le debe 20.00 a la clienta.',
  '8 · si devolvió más de lo que debía, cobrar se rechaza y se dice cuánto se le debe'
);

-- ---------------------------------------------------------------------------
-- 0067 · Cuando no se pudo entregar
-- ---------------------------------------------------------------------------
create temporary table v4 on commit drop as select pg_temp.venta(60, 'on_delivery', 'local_delivery') as id;
insert into public.sale_payments (sale_id, method, amount, reference) select id, 'yape', 20, '00900953' from v4;

select throws_ok(
  format($$ select public.mark_sale_fulfillment(%L::uuid, 'failed') $$, (select id from v4)),
  '22023',
  'Di por qué no se pudo entregar: mañana hay que decidir si se reintenta o se anula.',
  '9 · no se marca «no se pudo entregar» sin decir por qué'
);

select is(
  (select public.mark_sale_fulfillment(id, 'failed', 'Nadie contestó el timbre') ->> 'fulfillmentStatus' from v4),
  'failed',
  '10 · con motivo, sí'
);

select ok(
  (select notes from public.sales where id = (select id from v4)) like '%Nadie contestó el timbre%',
  '11 · y el motivo queda con la venta, no se pierde'
);

select is(
  (select public.sale_pending_amount(id) from v4), 40::numeric,
  '12 · una entrega fallida NO toca el dinero: el adelanto sigue adelantado'
);

-- Se reintenta hacia adelante, y el segundo motivo se acumula sobre el primero.
select is(
  (select public.mark_sale_fulfillment(id, 'dispatched', 'Segundo intento, coordinado por WhatsApp') ->> 'fulfillmentStatus' from v4),
  'dispatched',
  '13 · desde «no se pudo entregar» se reintenta hacia adelante'
);

select ok(
  (select notes from public.sales where id = (select id from v4)) like '%Nadie contestó el timbre%Segundo intento%',
  '14 · los dos intentos quedan contados, no uno encima del otro'
);

-- ---------------------------------------------------------------------------
-- 0068 · El comprobante pide lo suyo
-- ---------------------------------------------------------------------------
select is(
  public.tax_document_problem('sales_receipt', 300, null), null,
  '15 · una boleta por menos de S/ 700 no necesita DNI: pedirlo es fricción inventada'
);

select is(
  public.tax_document_problem('sales_receipt', 800, null),
  'Falta el DNI de quien recibe el comprobante.',
  '16 · desde S/ 700 sí, y se pide por su nombre: DNI, no «RUC»'
);

select is(
  public.tax_document_problem('sales_receipt', 800, jsonb_build_object('taxId', '123')),
  'El DNI no tiene el formato correcto.',
  '17 · y con ocho dígitos, no tres'
);

select is(
  public.tax_document_problem('invoice', 50, jsonb_build_object('taxId', '20512345678')),
  'Falta el nombre o la razón social a la que va el comprobante.',
  '18 · una factura sin razón social no se puede emitir, valga lo que valga'
);

-- El documento del comprobante es SUYO. Aquí la venta es de Rosa (DNI
-- 45678912) y la factura va a la empresa: ni el contrato ni la regla la
-- rellenan con el de ella.
create temporary table v5 on commit drop as select pg_temp.venta(60) as id;
insert into public.sale_payments (sale_id, method, amount) select id, 'cash', 60 from v5;

create temporary table fiscal on commit drop as
select public.request_tax_document(
  (select id from v5), 'invoice',
  jsonb_build_object('taxId','20512345678','name','DISTRIBUIDORA EJEMPLO S.A.C.','address','Av. Industrial 100')
) as detail;

select is(
  (select detail -> 'taxDocument' ->> 'receiverTaxId' from fiscal), '20512345678',
  '19 · el comprobante lleva el RUC que se le dio, no el DNI de la compradora'
);

-- Y una venta anulada no genera comprobante.
update public.sales set status = 'cancelled' where id = (select id from v5);

select throws_ok(
  format($$ select public.request_tax_document(%L::uuid, 'sales_receipt', null) $$, (select id from v5)),
  '23514',
  'Esta venta está anulada: no se emite comprobante de algo que no se vendió.',
  '20 · sobre una venta anulada no se pide comprobante'
);

select * from finish();

rollback;
