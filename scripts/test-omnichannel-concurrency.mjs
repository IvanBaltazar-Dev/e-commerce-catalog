// Concurrencia omnicanal. No puede expresarse en pgTAP: necesita sesiones
// reales de PostgreSQL corriendo a la vez.
//
// Uso: node scripts/test-omnichannel-concurrency.mjs
//
// Escenarios (§36 del plan del Bloque 3):
//   1. El mismo webhook CINCO veces simultáneas → una fila de evento.
//   2. Dos webhooks simultáneos del mismo contacto → 1 conversación, 2 mensajes.
//   3. El mismo mensaje externo simultáneo → 1 mensaje.
//   4. Dos dispositivos mutan el mismo carrito con la misma versión → uno gana,
//      el otro recibe conflicto explícito. Nada de last-write-wins.
//   5. Dos conversiones simultáneas del mismo carrito → 1 venta.
//   6. Dos vendedoras toman la misma conversación → exactamente una gana.

import { spawn } from "node:child_process";

const CONTAINER = "supabase_db_e-commerce-catalog";
const BRANCH_CODE = "OMNICONC";
const ACTOR_ADMIN = "c9000000-0000-4000-8000-000000000001";
const SELLER_A = "c9000000-0000-4000-8000-000000000002";
const SELLER_B = "c9000000-0000-4000-8000-000000000003";
const SKU = "DEMO-ESM-ROJO";

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
let trackedBefore = false;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

const asAdmin = `set local role authenticated;
  set local request.jwt.claims = '{"sub":"${ACTOR_ADMIN}","role":"authenticated"}';`;

async function setup() {
  const previous = await psql(`select tracks_inventory from public.product_variants where sku = '${SKU}';`);
  trackedBefore = previous.out.trim() === "t";

  const { code, err } = await psql(`
    delete from public.admin_profiles where id in ('${ACTOR_ADMIN}','${SELLER_A}','${SELLER_B}');
    delete from auth.users where id in ('${ACTOR_ADMIN}','${SELLER_A}','${SELLER_B}');

    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, email_change, email_change_token_new, recovery_token
    ) values
      ('00000000-0000-0000-0000-000000000000','${ACTOR_ADMIN}','authenticated','authenticated','omni-admin@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
      ('00000000-0000-0000-0000-000000000000','${SELLER_A}','authenticated','authenticated','omni-sa@example.invalid','',now(),'{}','{}',now(),now(),'','','',''),
      ('00000000-0000-0000-0000-000000000000','${SELLER_B}','authenticated','authenticated','omni-sb@example.invalid','',now(),'{}','{}',now(),now(),'','','','');

    insert into public.admin_profiles(id, role, full_name) values
      ('${ACTOR_ADMIN}','admin','Admin omnicanal'),
      ('${SELLER_A}','seller','Vendedora omni A'),
      ('${SELLER_B}','seller','Vendedora omni B');

    insert into public.branches (company_id, code, name, district, is_default, sort_order)
    select c.id, '${BRANCH_CODE}', 'Sede de concurrencia omnicanal', 'Lima', false, 902
    from public.companies c limit 1;

    insert into public.staff_branches (staff_id, branch_id, is_primary)
    select s.id, b.id, true
    from (values ('${SELLER_A}'::uuid), ('${SELLER_B}'::uuid)) s(id)
    cross join (select id from public.branches where code = '${BRANCH_CODE}') b;

    insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
    select ch.id, b.id, 'WhatsApp concurrencia', 'wa-omniconc'
    from public.channels ch, public.branches b
    where ch.code = 'whatsapp' and b.code = '${BRANCH_CODE}';

    update public.product_variants set tracks_inventory = true, availability_status = 'available'
    where sku = '${SKU}';

    select public.apply_inventory_movement(
      (select id from public.product_variants where sku = '${SKU}'),
      (select id from public.branches where code = '${BRANCH_CODE}'),
      'initial_load', 30, 9.00, 'omni-conc', null, 'fixture', 'existencia', '${ACTOR_ADMIN}');
  `);

  if (code !== 0) {
    console.error("No se pudo preparar el escenario:\n" + err);
    process.exit(1);
  }
}

async function escenarioWebhookCincoVeces() {
  console.log("\n1. El mismo webhook cinco veces SIMULTÁNEAS");

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      psql(`select public.ingest_webhook_event('whatsapp', 'omni-evt-1', '{"n": 1}'::jsonb) ->> 'duplicate';`))
  );

  const fresh = results.filter((result) => result.code === 0 && result.out === "false").length;

  const { out } = await psql(
    `select count(*) from public.integration_webhook_events where external_event_id = 'omni-evt-1';`
  );

  check("una sola fila de evento", out === "1", `filas = ${out}`);
  check("exactamente una entrega se registró como nueva", fresh === 1, `nuevas = ${fresh}`);
}

async function escenarioConversacionSimultanea() {
  console.log("\n2. Dos webhooks simultáneos del mismo contacto");

  const account = `(select id from public.channel_accounts where external_account_id = 'wa-omniconc')`;

  const messageCall = (externalId, body, sleep) => psql(`
    begin;
    ${sleep ? `select pg_sleep(${sleep});` : ""}
    select public.ingest_channel_message(
      ${account}, '51955666777', 'inbound', '${body}', 'text', '${externalId}',
      'Clienta Concurrente', '+51 955 666 777');
    commit;
  `);

  const [ra, rb] = await Promise.all([
    messageCall("omni-m1", "Hola", 0),
    messageCall("omni-m2", "¿Están?", 0)
  ]);

  check("las dos ingestas confirman", ra.code === 0 && rb.code === 0,
    `${ra.err.split("\n")[0]} · ${rb.err.split("\n")[0]}`);

  const { out } = await psql(`
    select
      (select count(*) from public.channel_conversations c
       join public.channel_accounts a on a.id = c.channel_account_id
       where a.external_account_id = 'wa-omniconc') || '|' ||
      (select count(*) from public.channel_messages m
       join public.channel_accounts a on a.id = m.channel_account_id
       where a.external_account_id = 'wa-omniconc');
  `);

  const [conversations, messages] = out.split("|");
  check("UNA conversación", conversations === "1", `conversaciones = ${conversations}`);
  check("DOS mensajes", messages === "2", `mensajes = ${messages}`);

  console.log("\n3. El mismo mensaje externo, simultáneo");

  const [rc, rd] = await Promise.all([
    messageCall("omni-m3", "Repetido", 0),
    messageCall("omni-m3", "Repetido", 0)
  ]);

  check("las dos peticiones responden", rc.code === 0 && rd.code === 0,
    `${rc.err.split("\n")[0]} · ${rd.err.split("\n")[0]}`);

  const dup = await psql(`select count(*) from public.channel_messages where external_message_id = 'omni-m3';`);
  check("UN mensaje", dup.out === "1", `mensajes = ${dup.out}`);
}

async function escenarioCarritoDosDispositivos() {
  console.log("\n4. Dos dispositivos contra el mismo carrito");

  const created = await psql(`
    select public.get_or_create_public_cart(null, null, 'web') ->> 'publicToken';
  `);
  const token = created.out.split("\n").pop().trim();

  await psql(`
    select public.set_public_cart_item('${token}',
      (select id from public.product_variants where sku = '${SKU}'), 2, null);
  `);

  // Ambos dispositivos conocen la versión 2 y escriben a la vez.
  const write = (quantity, sleep) => psql(`
    begin;
    ${sleep ? `select pg_sleep(${sleep});` : ""}
    select public.set_public_cart_item('${token}',
      (select id from public.product_variants where sku = '${SKU}'), ${quantity}, 2);
    commit;
  `);

  const [ra, rb] = await Promise.all([write(5, 0), write(9, 0)]);
  const winners = [ra, rb].filter((result) => result.code === 0).length;
  const conflicted = [ra, rb].find((result) => result.code !== 0);

  check("exactamente un dispositivo gana", winners === 1, `ganadores = ${winners}`);
  check("el otro recibe conflicto explícito, no un pisotón",
    Boolean(conflicted) && /cart_version_conflict/.test(conflicted.err),
    conflicted?.err?.split("\n").find((line) => line.includes("ERROR")));

  const { out } = await psql(`
    select i.quantity from public.public_cart_items i
    join public.public_carts c on c.id = i.cart_id
    where c.public_token = '${token}';
  `);

  check("la cantidad final es la del ganador", out === "5" || out === "9", `cantidad = ${out}`);
  return token;
}

async function escenarioConversionDoble(token) {
  console.log("\n5. Dos conversiones simultáneas del mismo carrito");

  await psql(`
    update public.public_carts set branch_id = (select id from public.branches where code = '${BRANCH_CODE}')
    where public_token = '${token}';
  `);

  const quantityResult = await psql(`
    select i.quantity from public.public_cart_items i
    join public.public_carts c on c.id = i.cart_id where c.public_token = '${token}';
  `);
  const amount = Number(quantityResult.out) * 15;

  const convert = (operation) => psql(`
    begin;
    ${asAdmin}
    select public.convert_cart_to_sale('${token}',
      jsonb_build_array(jsonb_build_object('method', 'cash', 'amount', ${amount}.00)),
      '${operation}'::uuid);
    commit;
  `);

  const [ra, rb] = await Promise.all([
    convert("d9000000-0000-4000-8000-000000000001"),
    convert("d9000000-0000-4000-8000-000000000002")
  ]);

  check("las dos peticiones terminan sin error", ra.code === 0 && rb.code === 0,
    `${ra.err.split("\n")[0]} · ${rb.err.split("\n")[0]}`);

  const { out } = await psql(`
    select count(*) from public.sales
    where source_reference = 'cart:${token}';
  `);

  check("UNA venta", out === "1", `ventas = ${out}`);
}

async function escenarioClaimDoble() {
  console.log("\n6. Dos vendedoras toman la misma conversación");

  const conv = await psql(`
    select c.id from public.channel_conversations c
    join public.channel_accounts a on a.id = c.channel_account_id
    where a.external_account_id = 'wa-omniconc' and c.status in ('open','pending')
    limit 1;
  `);
  const conversationId = conv.out.trim();

  await psql(`update public.channel_conversations set assigned_user_id = null, assigned_user_label = null where id = '${conversationId}';`);

  const claim = (seller) => psql(`
    begin;
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"${seller}","role":"authenticated"}';
    select public.claim_conversation('${conversationId}'::uuid);
    commit;
  `);

  const [ra, rb] = await Promise.all([claim(SELLER_A), claim(SELLER_B)]);
  const winners = [ra, rb].filter((result) => result.code === 0).length;
  const loser = [ra, rb].find((result) => result.code !== 0);

  check("exactamente una gana", winners === 1, `ganadoras = ${winners}`);
  check("la otra recibe un error de dominio",
    Boolean(loser) && /ya fue tomada/.test(loser.err),
    loser?.err?.split("\n").find((line) => line.includes("ERROR")));

  const { out } = await psql(`
    select count(*) from public.conversation_assignments where conversation_id = '${conversationId}';
  `);
  check("la historia registra la toma", Number(out) >= 1, `filas = ${out}`);
}

async function teardown() {
  await psql(`
    do $$
    declare
      branch uuid;
    begin
      select id into branch from public.branches where code = '${BRANCH_CODE}';
      if branch is null then return; end if;

      delete from public.channel_attributions where cart_id in
        (select id from public.public_carts where branch_id = branch);
      delete from public.public_carts where branch_id = branch;
      delete from public.conversation_assignments where conversation_id in
        (select id from public.channel_conversations where branch_id = branch);
      delete from public.channel_events where conversation_id in
        (select id from public.channel_conversations where branch_id = branch);
      delete from public.integration_delivery_attempts where channel_message_id in
        (select id from public.channel_messages m
         join public.channel_conversations c on c.id = m.conversation_id
         where c.branch_id = branch);
      delete from public.channel_messages where conversation_id in
        (select id from public.channel_conversations where branch_id = branch);
      delete from public.channel_attributions where conversation_id in
        (select id from public.channel_conversations where branch_id = branch);
      delete from public.channel_conversations where branch_id = branch;
      delete from public.channel_contacts where channel_account_id in
        (select id from public.channel_accounts where branch_id = branch);
      delete from public.channel_accounts where branch_id = branch;
      delete from public.sales where branch_id = branch;
      delete from public.branch_document_counters where branch_id = branch;
      delete from public.inventory_movements where branch_id = branch;
      delete from public.inventory_valuation where branch_id = branch;
      delete from public.inventory_stock where branch_id = branch;
      delete from public.staff_branches where branch_id = branch;
      delete from public.branches where id = branch;
    end $$;

    delete from public.integration_webhook_events where external_event_id like 'omni-evt-%';
    delete from public.admin_profiles where id in ('${ACTOR_ADMIN}','${SELLER_A}','${SELLER_B}');
    delete from auth.users where id in ('${ACTOR_ADMIN}','${SELLER_A}','${SELLER_B}');
    update public.product_variants set tracks_inventory = ${trackedBefore} where sku = '${SKU}';
  `);
}

console.log("Concurrencia omnicanal · Supabase local");

await setup();
try {
  await escenarioWebhookCincoVeces();
  await escenarioConversacionSimultanea();
  const token = await escenarioCarritoDosDispositivos();
  await escenarioConversionDoble(token);
  await escenarioClaimDoble();
} finally {
  await teardown();
}

console.log(failures === 0 ? "\nPASS · sin fallos" : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
