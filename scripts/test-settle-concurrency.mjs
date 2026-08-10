// Concurrencia del cobro contra entrega. No puede expresarse en pgTAP: necesita
// DOS sesiones reales de PostgreSQL cobrando el mismo saldo a la vez.
//
// Uso: node scripts/test-settle-concurrency.mjs
//
// POR QUÉ ESTA PRUEBA EXISTE. «No se puede cobrar dos veces» probado en
// secuencia no demuestra nada sobre dos celulares pulsando a la vez: cada uno
// manda su propio identificador de operación, así que la idempotencia por
// identificador NO los frena —son operaciones distintas—, y los dos pueden leer
// un saldo de 15 antes de que ninguno escriba.
//
// Lo que los frena es que el candado consultivo sea de la VENTA. Hasta 0064 se
// calculaba con la venta Y el identificador, de modo que dos identificadores
// distintos tomaban candados distintos y ninguno esperaba al otro.
//
// Escenarios:
//   1. Dos sesiones cobran el saldo completo a la vez → una cobra, la otra
//      recibe un error de dominio, y la venta queda cobrada UNA vez.
//   2. Reintento del MISMO botón (mismo identificador de operación) → devuelve
//      lo ya cobrado sin volver a cobrarlo.
//
// Se ejecuta contra el contenedor local de Supabase mediante docker exec, así
// que no necesita cliente de PostgreSQL instalado ni credenciales en disco.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const CONTAINER = "supabase_db_e-commerce-catalog";
const BRANCH_CODE = "SETTLECONC";
const ACTOR = "c0000000-0000-4000-8000-000000000031";

function psql(sql) {
  return new Promise((resolve) => {
    const child = spawn(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-A", "-t"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(sql);
  });
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

const asActor = `set local role authenticated;
  set local request.jwt.claims = '{"sub":"${ACTOR}","role":"authenticated"}';`;

/** Una sesión que cobra el saldo, con una pausa para solapar deliberadamente. */
function settleSql({ saleId, operationId, amount, sleepSeconds = 0 }) {
  return `
    begin;
    ${asActor}
    ${sleepSeconds ? `select pg_sleep(${sleepSeconds});` : ""}
    select public.settle_sale_balance(
      '${saleId}'::uuid,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', ${amount})),
      '${operationId}'::uuid
    );
    commit;
  `;
}

async function setup() {
  const { code, err } = await psql(`
    delete from public.admin_profiles where id = '${ACTOR}';
    delete from auth.users where id = '${ACTOR}';

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000','${ACTOR}',
      'authenticated','authenticated','settle-conc@example.invalid','',now(),'{}','{}',
      now(),now(),'','','',''
    );
    insert into public.admin_profiles(id, role, full_name)
    values ('${ACTOR}','seller','Vendedora de concurrencia del saldo');

    insert into public.branches (company_id, code, name, district, is_default, sort_order)
    select c.id, '${BRANCH_CODE}', 'Sede de concurrencia del saldo', 'Lima', false, 961
    from public.companies c limit 1;

    insert into public.staff_branches (staff_id, branch_id, is_primary)
    select '${ACTOR}', id, true from public.branches where code = '${BRANCH_CODE}';
  `);
  if (code !== 0) throw new Error(`Preparación fallida: ${err}`);
}

/** Un envío a provincia despachado con adelanto de 10 sobre 50: saldo de 40. */
async function nuevaVentaConSaldo() {
  const id = randomUUID();
  // Una sola transacción: las restricciones diferidas de la venta —que los
  // pagos cuadren, que la entrega esté declarada, que el bruto sea la suma de
  // las líneas— se evalúan al cerrar, y sueltas fallarían por el orden en que
  // se escriben las filas, no por lo que se está probando.
  const { code, err } = await psql(`
    begin;
    insert into public.sales (
      id, branch_id, sale_number, fulfillment_method, client_operation_id,
      gross_subtotal, discount_total, total, payment_terms, fulfillment_status,
      customer_name, customer_phone, customer_document, delivery_address
    )
    select '${id}', b.id, 'NV-SC-' || left('${id}', 6), 'shipping', gen_random_uuid(),
           50, 0, 50, 'on_delivery', 'dispatched',
           'Rosa Díaz', '900000641', '45678912', 'Av. El Sol 890, Cusco'
    from public.branches b where b.code = '${BRANCH_CODE}';

    insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name,
                                   quantity, unit_price, discount_amount, subtotal,
                                   purchase_mode, line_order)
    select '${id}', v.id, 'SC-1', 'Producto de prueba', 'Único', 1, 50, 0, 50, 'retail', 0
    from public.product_variants v where v.is_active order by v.created_at limit 1;

    insert into public.sale_parties (sale_id, role, is_buyer)
    values ('${id}', 'recipient', true);

    insert into public.sale_payments (sale_id, method, amount, reference)
    values ('${id}', 'yape', 10, '00887766');
    commit;
  `);
  if (code !== 0) throw new Error(`No se pudo preparar la venta con saldo: ${err}`);
  return id;
}

async function saldoDe(saleId) {
  const { out } = await psql(
    `select (public.sale_detail('${saleId}'::uuid) ->> 'balance')::numeric;`
  );
  return Number(out);
}

async function pagosDe(saleId) {
  const { out } = await psql(
    `select count(*) from public.sale_payments where sale_id = '${saleId}'::uuid;`
  );
  return Number(out);
}

async function teardown() {
  await psql(`
    delete from public.sales where branch_id in (select id from public.branches where code = '${BRANCH_CODE}');
    delete from public.staff_branches where branch_id in (select id from public.branches where code = '${BRANCH_CODE}');
    delete from public.branches where code = '${BRANCH_CODE}';
    delete from public.admin_profiles where id = '${ACTOR}';
    delete from auth.users where id = '${ACTOR}';
  `);
}

async function main() {
  await setup();

  // -------------------------------------------------------------------------
  console.log("\n1. Dos dispositivos cobran el mismo saldo a la vez");
  // -------------------------------------------------------------------------
  // Las dos sesiones esperan LO MISMO dentro de su transacción antes de cobrar.
  // Con retardos distintos la segunda llegaba cuando la primera ya había
  // cerrado, no había carrera que ganar y la prueba pasaba incluso con el
  // candado defectuoso —comprobado—. Durmiendo igual entran a la vez.
  //
  // Y se repite: una carrera que se gana una vez puede perderse a la siguiente.
  const RONDAS = 5;
  let unaSolaGanadora = true;
  let siempreErrorDeDominio = true;
  let siempreDosPagos = true;
  let detalle = "";

  for (let ronda = 1; ronda <= RONDAS; ronda += 1) {
    const venta = await nuevaVentaConSaldo();

    // Identificadores DISTINTOS a propósito: son dos peticiones legítimamente
    // distintas, no un reintento. La idempotencia por identificador no las frena.
    const [a, b] = await Promise.all([
      psql(settleSql({ saleId: venta, operationId: randomUUID(), amount: 40, sleepSeconds: 0.4 })),
      psql(settleSql({ saleId: venta, operationId: randomUUID(), amount: 40, sleepSeconds: 0.4 }))
    ]);

    if ([a, b].filter((r) => r.code === 0).length !== 1) {
      unaSolaGanadora = false;
      detalle = `ronda ${ronda}: a=${a.code} b=${b.code} · ${a.err || ""} ${b.err || ""}`.trim();
    }

    const perdedora = [a, b].find((r) => r.code !== 0);
    // El mensaje importa: si la perdedora muere por «los pagos suman más que el
    // total», quien la frenó fue la restricción diferida y no el candado. Con el
    // candado bien puesto, la segunda mira DESPUÉS y ve que no queda nada.
    if (!perdedora || !/ya está cobrada por completo/i.test(perdedora.err)) {
      siempreErrorDeDominio = false;
      detalle = detalle || `ronda ${ronda}: ${perdedora?.err ?? "nadie perdió"}`;
    }

    const pagos = await pagosDe(venta);
    if (pagos !== 2 || (await saldoDe(venta)) !== 0) {
      siempreDosPagos = false;
      detalle = detalle || `ronda ${ronda}: pagos=${pagos}`;
    }
  }

  check(`una sola sesión cobra el saldo, en ${RONDAS} rondas`, unaSolaGanadora, detalle);
  check("la que pierde lo hace por el candado, no por la restricción diferida",
    siempreErrorDeDominio, detalle);
  check("la venta queda con saldo cero y un solo cobro del saldo", siempreDosPagos, detalle);

  // -------------------------------------------------------------------------
  console.log("\n2. El mismo botón pulsado dos veces");
  // -------------------------------------------------------------------------
  const venta2 = await nuevaVentaConSaldo();
  const mismaOperacion = randomUUID();

  const [c, d] = await Promise.all([
    psql(settleSql({ saleId: venta2, operationId: mismaOperacion, amount: 40 })),
    psql(settleSql({ saleId: venta2, operationId: mismaOperacion, amount: 40, sleepSeconds: 0.2 }))
  ]);

  check("las dos peticiones responden bien: la segunda devuelve lo ya cobrado",
    c.code === 0 && d.code === 0, `c=${c.code} d=${d.code} · ${c.err || ""} ${d.err || ""}`.trim());
  check("y el saldo se cobró una sola vez", (await pagosDe(venta2)) === 2,
    `pagos=${await pagosDe(venta2)}`);

  await teardown();

  console.log(
    failures === 0
      ? "\nPASS · el saldo no se puede cobrar dos veces, ni en paralelo ni por reintento"
      : `\nFALLO · ${failures} comprobación(es)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await teardown();
  process.exit(1);
});
