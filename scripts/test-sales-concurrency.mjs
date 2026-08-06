// Concurrencia de la caja. No puede expresarse en pgTAP: necesita DOS sesiones
// reales de PostgreSQL corriendo a la vez.
//
// Uso: node scripts/test-sales-concurrency.mjs
//
// Escenarios (pruebas críticas 1, 2, 9 y 13 de docs/bloque-2-modelo.md §10):
//   1. Doble confirmación literal —el mismo client_operation_id en dos
//      sesiones simultáneas— debe dar UNA venta, UN descuento de existencia y
//      UN correlativo. El índice único solo no basta: sin el candado consultivo
//      la perdedora ya habría descontado el inventario cuando muere.
//   2. Dos vendedoras contra la última unidad: una vende, la otra recibe un
//      error de dominio y el saldo nunca queda negativo.
//   3. Numeración bajo concurrencia: N ventas simultáneas en la misma sede dan
//      N números contiguos, sin duplicados ni huecos.
//   4. Conversión de una reserva simultánea con su vencimiento: una sola gana.
//
// Se ejecuta contra el contenedor local de Supabase mediante docker exec, así
// que no necesita cliente de PostgreSQL instalado ni credenciales en disco.

import { spawn } from "node:child_process";

const CONTAINER = "supabase_db_e-commerce-catalog";
const BRANCH_CODE = "SALECONC";
const SKU = "DEMO-ESM-ROJO";
const ACTOR = "c0000000-0000-4000-8000-000000000021";

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

function saleSql({ operationId, quantity, amount, sleepSeconds = 0 }) {
  return `
    begin;
    ${asActor}
    ${sleepSeconds ? `select pg_sleep(${sleepSeconds});` : ""}
    select public.register_sale(
      (select id from public.branches where code = '${BRANCH_CODE}'),
      jsonb_build_array(jsonb_build_object(
        'variantId', (select id from public.product_variants where sku = '${SKU}'),
        'quantity', ${quantity})),
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
      'authenticated','authenticated','sale-conc@example.invalid','',now(),'{}','{}',
      now(),now(),'','','',''
    );
    insert into public.admin_profiles(id, role, full_name)
    values ('${ACTOR}','seller','Vendedora de concurrencia');

    insert into public.branches (company_id, code, name, district, is_default, sort_order)
    select c.id, '${BRANCH_CODE}', 'Sede de concurrencia de caja', 'Lima', false, 960
    from public.companies c limit 1;

    insert into public.staff_branches (staff_id, branch_id, is_primary)
    select '${ACTOR}', id, true from public.branches where code = '${BRANCH_CODE}';

    update public.product_variants set tracks_inventory = true, availability_status = 'available'
    where sku = '${SKU}';

    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${SKU}'),
      (select id from public.branches where code = '${BRANCH_CODE}'),
      'initial_load', 30, 10.00, 'sales-concurrency', null, 'fixture', 'existencia', '${ACTOR}'
    );
  `);

  if (code !== 0) {
    console.error("No se pudo preparar el escenario:\n" + err);
    process.exit(1);
  }
}

async function escenarioDobleConfirmacion() {
  console.log("\n1. Doble confirmación literal de la misma operación");

  const operationId = "aaaaaaaa-0000-4000-8000-000000000001";
  const a = psql(saleSql({ operationId, quantity: 2, amount: 30.0, sleepSeconds: 0 }));
  const b = psql(saleSql({ operationId, quantity: 2, amount: 30.0, sleepSeconds: 0 }));

  const [ra, rb] = await Promise.all([a, b]);

  check("las dos peticiones responden sin error", ra.code === 0 && rb.code === 0,
    `A=${ra.code} ${ra.err.split("\n")[0]} · B=${rb.code} ${rb.err.split("\n")[0]}`);

  const { out } = await psql(`
    select (select count(*) from public.sales s
             join public.branches b on b.id = s.branch_id and b.code = '${BRANCH_CODE}') || '|' ||
           (select on_hand from public.inventory_stock s
             join public.branches b on b.id = s.branch_id and b.code = '${BRANCH_CODE}'
             join public.product_variants v on v.id = s.variant_id and v.sku = '${SKU}') || '|' ||
           (select next_number from public.branch_document_counters c
             join public.branches b on b.id = c.branch_id and b.code = '${BRANCH_CODE}'
            where c.document_kind = 'sale_note');
  `);

  const [sales, onHand, nextNumber] = out.split("|");

  check("una sola venta", sales === "1", `ventas = ${sales}`);
  check("una sola salida de inventario", onHand === "28", `on_hand = ${onHand} (esperado 28)`);
  check("un solo correlativo consumido", nextNumber === "2", `next_number = ${nextNumber}`);
}

async function escenarioUltimaUnidad() {
  console.log("\n2. Dos vendedoras contra la última unidad");

  await psql(`
    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${SKU}'),
      (select id from public.branches where code = '${BRANCH_CODE}'),
      'adjustment', -27, null, 'sales-concurrency', null, 'ajuste', 'dejar 1', '${ACTOR}'
    );
  `);

  const a = psql(saleSql({ operationId: "aaaaaaaa-0000-4000-8000-000000000002", quantity: 1, amount: 15.0, sleepSeconds: 0 }));
  const b = psql(saleSql({ operationId: "aaaaaaaa-0000-4000-8000-000000000003", quantity: 1, amount: 15.0, sleepSeconds: 0 }));

  const [ra, rb] = await Promise.all([a, b]);

  const ganadoras = [ra, rb].filter((r) => r.code === 0).length;
  const perdedora = [ra, rb].find((r) => r.code !== 0);

  check("exactamente una venta gana", ganadoras === 1, `ganadoras = ${ganadoras}`);
  check("la perdedora recibe un error explícito, no un stock negativo",
    Boolean(perdedora) && /No hay existencias suficientes/.test(perdedora.err),
    perdedora?.err?.split("\n").find((line) => line.includes("ERROR")) ?? "sin perdedora");

  const { out } = await psql(`
    select s.on_hand from public.inventory_stock s
    join public.branches b on b.id = s.branch_id and b.code = '${BRANCH_CODE}'
    join public.product_variants v on v.id = s.variant_id and v.sku = '${SKU}';
  `);

  check("el saldo queda en cero, nunca negativo", out === "0", `on_hand = ${out}`);
}

async function escenarioNumeracion() {
  console.log("\n3. Numeración contigua bajo concurrencia");

  await psql(`
    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${SKU}'),
      (select id from public.branches where code = '${BRANCH_CODE}'),
      'receipt', 40, 10.00, 'sales-concurrency', null, 'reposición', 'reponer', '${ACTOR}'
    );
  `);

  const ventas = Array.from({ length: 6 }, (_, index) =>
    psql(saleSql({
      operationId: `aaaaaaaa-0000-4000-8000-00000000001${index}`,
      quantity: 1,
      amount: 15.0
    })));

  const resultados = await Promise.all(ventas);
  const okCount = resultados.filter((r) => r.code === 0).length;

  check("las seis ventas simultáneas confirman", okCount === 6,
    resultados.filter((r) => r.code !== 0).map((r) => r.err.split("\n")[0]).join(" · "));

  const { out } = await psql(`
    select count(*) || '|' || count(distinct s.sale_number) || '|' ||
           max(substring(s.sale_number from 4))::integer
    from public.sales s
    join public.branches b on b.id = s.branch_id and b.code = '${BRANCH_CODE}';
  `);

  const [total, distintos, maximo] = out.split("|");

  check("ningún número duplicado", total === distintos, `${total} ventas y ${distintos} números`);
  check("ningún hueco en la numeración de la sede", total === maximo,
    `${total} ventas y el último número es ${maximo}`);
}

async function escenarioReservaConcurrente() {
  console.log("\n4. Conversión de una reserva simultánea con su vencimiento");

  const setupOut = await psql(`
    ${asActor.replace("set local", "set")}
    select public.create_reservation(
      (select id from public.branches where code = '${BRANCH_CODE}'),
      jsonb_build_array(jsonb_build_object(
        'variantId', (select id from public.product_variants where sku = '${SKU}'),
        'quantity', 3)),
      jsonb_build_object('name', 'Clienta concurrente'),
      now() + interval '1 hour',
      'bbbbbbbb-0000-4000-8000-000000000001'::uuid
    ) ->> 'id';
  `);

  if (setupOut.code !== 0) {
    check("se pudo crear la reserva", false, setupOut.err.split("\n")[0]);
    return;
  }

  const reservationId = setupOut.out.split("\n").pop().trim();

  const conversion = psql(`
    begin;
    ${asActor}
    select public.register_sale(
      (select id from public.branches where code = '${BRANCH_CODE}'),
      null,
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', 45.00)),
      'aaaaaaaa-0000-4000-8000-000000000030'::uuid,
      'in_store'::public.sale_source_channel,
      'in_store'::public.fulfillment_method,
      null, 0, null, '${reservationId}'::uuid
    );
    commit;
  `);

  const liberacion = psql(`
    begin;
    ${asActor}
    select public.release_reservation('${reservationId}'::uuid, 'Vencimiento simultáneo', 'expired');
    commit;
  `);

  const [rc, rl] = await Promise.all([conversion, liberacion]);
  const ganadoras = [rc, rl].filter((r) => r.code === 0).length;

  check("solo una de las dos transiciones gana", ganadoras === 1,
    `conversión=${rc.code} · liberación=${rl.code}`);

  const { out } = await psql(`
    select r.status || '|' ||
           (select count(*) from public.sales s where s.reservation_id = r.id) || '|' ||
           (select reserved from public.inventory_stock st
             where st.variant_id = (select id from public.product_variants where sku = '${SKU}')
               and st.branch_id = r.branch_id)
    from public.reservations r where r.id = '${reservationId}';
  `);

  const [status, ventas, reservado] = out.split("|");

  check("el estado final es coherente con la ganadora",
    (status === "converted" && ventas === "1") || (status === "expired" && ventas === "0"),
    `status=${status} ventas=${ventas}`);
  check("no queda nada comprometido de esa reserva", reservado === "0", `reserved = ${reservado}`);
}

async function teardown() {
  await psql(`
    delete from public.sales s using public.branches b
      where s.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.reservations r using public.branches b
      where r.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.branch_document_counters c using public.branches b
      where c.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.inventory_movements m using public.branches b
      where m.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.inventory_stock s using public.branches b
      where s.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.inventory_valuation v using public.branches b
      where v.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.staff_branches sb using public.branches b
      where sb.branch_id = b.id and b.code = '${BRANCH_CODE}';
    delete from public.branches where code = '${BRANCH_CODE}';
    delete from public.admin_profiles where id = '${ACTOR}';
    delete from auth.users where id = '${ACTOR}';
    update public.product_variants set tracks_inventory = false where sku = '${SKU}';
  `);
}

console.log("Concurrencia de la caja · Supabase local");

await setup();
try {
  await escenarioDobleConfirmacion();
  await escenarioUltimaUnidad();
  await escenarioNumeracion();
  await escenarioReservaConcurrente();
} finally {
  await teardown();
}

console.log(failures === 0 ? "\nPASS · sin fallos" : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
