// Concurrencia del inventario. No puede expresarse en pgTAP: necesita DOS
// sesiones reales de PostgreSQL corriendo a la vez.
//
// Uso: node scripts/test-inventory-concurrency.mjs
//
// Escenarios:
//   1. Dos primeras operaciones sobre un par (variante, sede) TODAVÍA INEXISTENTE.
//      Es el caso que un `select … for update` no cubre —bloquea cero filas— y
//      que el upsert de apply_inventory_movement sí serializa.
//   2. Dos ventas simultáneas de la última unidad: una gana, la otra falla con
//      un mensaje de dominio y no deja saldo negativo.
//
// Se ejecuta contra el contenedor local de Supabase mediante docker exec, así
// que no necesita cliente de PostgreSQL instalado ni credenciales en disco.

import { spawn } from "node:child_process";

const CONTAINER = "supabase_db_e-commerce-catalog";

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

const FIXTURE_SKU = "DEMO-ESM-ROJO";
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

async function setup() {
  const { code, err } = await psql(`
    delete from public.inventory_movements
     where source_type = 'concurrency-test';
    delete from public.inventory_stock s
     using public.branches b
     where s.branch_id = b.id and b.code = 'CONCTEST';
    delete from public.inventory_valuation v
     using public.branches b
     where v.branch_id = b.id and b.code = 'CONCTEST';
    delete from public.branches where code = 'CONCTEST';
    delete from public.admin_profiles where id = 'c0000000-0000-4000-8000-000000000001';
    delete from auth.users where id = 'c0000000-0000-4000-8000-000000000001';

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values (
      '00000000-0000-0000-0000-000000000000','c0000000-0000-4000-8000-000000000001',
      'authenticated','authenticated','conc-admin@example.invalid','',now(),'{}','{}',
      now(),now(),'','','',''
    );
    insert into public.admin_profiles(id, role, full_name)
    values ('c0000000-0000-4000-8000-000000000001','admin','Propietaria concurrencia');

    insert into public.branches (company_id, code, name, district, is_default, sort_order)
    select c.id, 'CONCTEST', 'Sede de prueba de concurrencia', 'Lima', false, 950
    from public.companies c limit 1;
  `);

  if (code !== 0) {
    console.error("No se pudo preparar el escenario:\n" + err);
    process.exit(1);
  }
}

function movementSql({ quantity, unitCost, sleepSeconds = 0, type = "receipt" }) {
  return `
    begin;
    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${FIXTURE_SKU}'),
      (select id from public.branches where code = 'CONCTEST'),
      '${type}', ${quantity}, ${unitCost === null ? "null" : unitCost},
      'concurrency-test', null, 'concurrencia', 'prueba',
      'c0000000-0000-4000-8000-000000000001'
    );
    ${sleepSeconds ? `select pg_sleep(${sleepSeconds});` : ""}
    commit;
  `;
}

async function escenarioParAusente() {
  console.log("\n1. Dos primeras operaciones sobre un par (variante, sede) inexistente");

  const a = psql(movementSql({ quantity: 10, unitCost: 5.0, sleepSeconds: 1.5 }));
  // Pequeño desfase para que A llegue primero al upsert y retenga el candado.
  await new Promise((resolve) => setTimeout(resolve, 250));
  const b = psql(movementSql({ quantity: 10, unitCost: 5.0 }));

  const [ra, rb] = await Promise.all([a, b]);

  check("ambas transacciones confirman", ra.code === 0 && rb.code === 0,
    `A=${ra.code} ${ra.err} · B=${rb.code} ${rb.err}`);

  const { out } = await psql(`
    select coalesce(s.on_hand, -1) || '|' ||
           (select count(*) from public.inventory_movements m
             where m.branch_id = s.branch_id and m.variant_id = s.variant_id) || '|' ||
           coalesce(round(v.total_value, 2)::text, 'sin valoracion')
    from public.inventory_stock s
    left join public.inventory_valuation v
      on v.variant_id = s.variant_id and v.branch_id = s.branch_id
    join public.branches b on b.id = s.branch_id and b.code = 'CONCTEST';
  `);

  const [onHand, movements, value] = out.split("|");

  check("no se pierde ningún movimiento", movements === "2", `asientos = ${movements}`);
  check("el saldo suma las dos entradas", onHand === "20", `on_hand = ${onHand}`);
  check("la valoración suma las dos entradas", value === "100.00", `total_value = ${value}`);
}

async function escenarioUltimaUnidad() {
  console.log("\n2. Dos ventas simultáneas de la última unidad");

  await psql(`
    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${FIXTURE_SKU}'),
      (select id from public.branches where code = 'CONCTEST'),
      'sale', -19, null, 'concurrency-test', null, 'ajuste', 'dejar 1',
      'c0000000-0000-4000-8000-000000000001'
    );
  `);

  const a = psql(movementSql({ quantity: -1, unitCost: null, sleepSeconds: 1.5, type: "sale" }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const b = psql(movementSql({ quantity: -1, unitCost: null, type: "sale" }));

  const [ra, rb] = await Promise.all([a, b]);

  const ganadoras = [ra, rb].filter((r) => r.code === 0).length;
  const perdedoras = [ra, rb].filter((r) => r.code !== 0);

  check("exactamente una venta gana", ganadoras === 1, `ganadoras = ${ganadoras}`);
  check(
    "la perdedora falla con un mensaje de dominio",
    perdedoras.length === 1 && /No hay existencias suficientes/.test(perdedoras[0].err),
    perdedoras[0]?.err?.split("\n")[0]
  );

  const { out } = await psql(`
    select s.on_hand from public.inventory_stock s
    join public.branches b on b.id = s.branch_id and b.code = 'CONCTEST'
    join public.product_variants v on v.id = s.variant_id and v.sku = '${FIXTURE_SKU}';
  `);

  check("el saldo queda en cero, nunca negativo", out === "0", `on_hand = ${out}`);
}

async function teardown() {
  await psql(`
    delete from public.inventory_movements where source_type = 'concurrency-test';
    delete from public.inventory_stock s using public.branches b
      where s.branch_id = b.id and b.code = 'CONCTEST';
    delete from public.inventory_valuation v using public.branches b
      where v.branch_id = b.id and b.code = 'CONCTEST';
    delete from public.branches where code = 'CONCTEST';
    delete from public.admin_profiles where id = 'c0000000-0000-4000-8000-000000000001';
    delete from auth.users where id = 'c0000000-0000-4000-8000-000000000001';
  `);
}

console.log("Concurrencia de inventario · Supabase local");

await setup();
try {
  await escenarioParAusente();
  await escenarioUltimaUnidad();
} finally {
  await teardown();
}

console.log(failures === 0 ? "\nPASS · sin fallos" : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
