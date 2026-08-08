/**
 * Rendimiento con volumen representativo (Bloque 5, §9).
 *
 * Siembra un volumen MUY superior al esperado del negocio (~1,500 SKUs reales
 * del Excel maestro) y mide las superficies con cronómetro, no con intuición:
 *
 *   catálogo público · búsqueda · detalle · evaluación de carrito · venta ·
 *   reserva · kardex · caja · business_dashboard · rankings 90d ·
 *   conversaciones · carritos persistentes
 *
 * Cada medición corre N veces y reporta mediana y peor caso contra un umbral.
 * Lo que no cumple recibe su EXPLAIN (ANALYZE, BUFFERS) impreso — la única
 * base admitida para tocar un índice. Prefijo VOLB5- para poder limpiar.
 *
 * Uso:  node scripts/perf-volume.mjs [--keep] [--skip-seed]
 *   --keep       no limpia el volumen al final (para inspección/frontend)
 *   --skip-seed  mide sobre el volumen ya sembrado (segunda pasada)
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "perf-volume", allowedFlags: ["--keep", "--skip-seed"] });
if (!isLocal) throw new Error("El arnés de volumen solo corre contra Supabase local.");

const BASE_URL = process.env.UI_BASE_URL ?? "http://localhost:3002";
const CONTAINER = "supabase_db_e-commerce-catalog";
const KEEP = process.argv.includes("--keep");
const SKIP_SEED = process.argv.includes("--skip-seed");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

const PRODUCTS = 1500;
const SALES = 5000;
const CONVERSATIONS = 2000;
const MESSAGES_PER_CONV = 5;
const CARTS = 1500;

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function psql(query) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"],
    { input: query, encoding: "utf8", maxBuffer: 1024 * 1024 * 64 }
  );
  if (result.status !== 0) throw new Error(`psql: ${(result.stderr || "").slice(-800)}`);
  return result.stdout.trim();
}

async function chunks(items, size, operation) {
  for (let index = 0; index < items.length; index += size) await operation(items.slice(index, index + size), index);
}

// ---------------------------------------------------------------------------
// 1. Siembra de volumen
// ---------------------------------------------------------------------------

async function cleanupVolume() {
  console.log("Limpieza del volumen VOLB5 previo…");
  psql(`
    delete from public.channel_attributions where last_utm->>'volb5' = '1';
    delete from public.public_cart_items where cart_id in (select id from public.public_carts where metadata->>'volb5' = '1');
    delete from public.public_carts where metadata->>'volb5' = '1';
    delete from public.channel_events where conversation_id in (
      select c.id from public.channel_conversations c
      join public.channel_accounts a on a.id = c.channel_account_id
      where a.external_account_id = 'volb5-account');
    delete from public.channel_messages where conversation_id in (
      select c.id from public.channel_conversations c
      join public.channel_accounts a on a.id = c.channel_account_id
      where a.external_account_id = 'volb5-account');
    delete from public.conversation_assignments where conversation_id in (
      select c.id from public.channel_conversations c
      join public.channel_accounts a on a.id = c.channel_account_id
      where a.external_account_id = 'volb5-account');
    delete from public.channel_conversations where channel_account_id in (
      select id from public.channel_accounts where external_account_id = 'volb5-account');
    delete from public.channel_contacts where external_contact_id like 'volb5-%';
    delete from public.channel_accounts where external_account_id = 'volb5-account';
    delete from public.expenses where description like 'VOLB5%';
    -- Solo la CABECERA: cascadea a líneas, costos y pagos. Quitar los pagos
    -- antes dejaría la venta con total y cobranza cero, y el trigger diferido
    -- assert_sale_fully_paid lo rechaza (la lección de cleanup-v2-test-data).
    delete from public.sales where notes = 'VOLB5';
    -- Las mediciones de venta y reserva crean reservas sobre variantes VOLB5;
    -- sus líneas tienen FK restrictiva a la variante y deben irse antes.
    delete from public.reservations where notes = 'VOLB5';

    -- Los productos del volumen: todo por SQL (sin límite de URI). Primero se
    -- DESPUBLICAN — un producto publicado no puede quedarse sin precio, y el
    -- trigger diferido lo comprueba al borrar los precios — y luego se borra
    -- en el orden que respetan las FKs restrictivas del kardex.
    update public.products set is_active = false, editorial_status = 'draft'
      where code like 'VOLB5-%';
    delete from public.inventory_movements where variant_id in (
      select id from public.product_variants where sku like 'VOLB5-%');
    delete from public.inventory_valuation where variant_id in (
      select id from public.product_variants where sku like 'VOLB5-%');
    delete from public.inventory_stock where variant_id in (
      select id from public.product_variants where sku like 'VOLB5-%');
    delete from public.variant_prices where variant_id in (
      select id from public.product_variants where sku like 'VOLB5-%');
    delete from public.product_variants where sku like 'VOLB5-%';
    delete from public.products where code like 'VOLB5-%';
  `);
}

async function seedVolume() {
  await cleanupVolume();
  console.log(`Sembrando ${PRODUCTS} productos, ${SALES} ventas, ${CONVERSATIONS} conversaciones, ${CARTS} carritos…`);

  const [brand, category, template, retailList, wholesaleList, branch] = await Promise.all([
    service.from("brands").select("id").eq("slug", "demo-professional").single(),
    service.from("categories").select("id").eq("slug", "accesorios").is("parent_id", null).single(),
    service.from("attribute_templates").select("id").eq("code", "LEGACY_V1").single(),
    service.from("price_lists").select("id").eq("code", "retail-pen").single(),
    service.from("price_lists").select("id").eq("code", "wholesale-pen").single(),
    service.from("branches").select("id").eq("is_default", true).limit(1).single()
  ]).then((results) => results.map((result, i) => must(result, `diccionario ${i}`)));

  // Productos ACTIVOS y publicados: el catálogo público debe cargarlos todos.
  const products = Array.from({ length: PRODUCTS }, (_, index) => ({
    code: `VOLB5-${String(index).padStart(4, "0")}`,
    slug: `volb5-${String(index).padStart(4, "0")}`,
    brand_id: brand.id,
    category_id: category.id,
    template_id: template.id,
    name: `Producto volumen ${String(index).padStart(4, "0")}`,
    presentation: "Presentación única",
    product_type: "Volumen B5",
    description: "Fila de volumen del gate de rendimiento del Bloque 5.",
    unit_price: 10 + (index % 40),
    wholesale_price: 8 + (index % 40),
    wholesale_min_quantity: 3,
    availability: "available",
    // Nacen INACTIVOS: el trigger diferido exige que un producto activo ya
    // tenga variante predeterminada, y supabase-js confirma cada inserción
    // por separado. Se activan al final, cuando sus variantes existen.
    editorial_status: "draft",
    is_active: false,
    sort_order: 9000 + index
  }));

  const createdProducts = [];
  await chunks(products, 250, async (rows) => {
    createdProducts.push(...must(await service.from("products").insert(rows).select("id, code"), "insert productos"));
  });

  const variants = createdProducts.map((product, index) => ({
    product_id: product.id,
    sku: `${product.code}-SKU`,
    name: `Tono ${index % 24}`,
    variant_key: "presentation=default",
    availability_status: "available",
    is_default: true,
    is_active: true,
    sort_order: 0
  }));
  const createdVariants = [];
  await chunks(variants, 250, async (rows) => {
    createdVariants.push(...must(await service.from("product_variants").insert(rows).select("id, sku"), "insert variantes"));
  });

  const prices = createdVariants.flatMap((variant, index) => ([
    { variant_id: variant.id, price_list_id: retailList.id, amount: 10 + (index % 40), minimum_quantity: 1, is_active: true },
    { variant_id: variant.id, price_list_id: wholesaleList.id, amount: 8 + (index % 40), minimum_quantity: 3, is_active: true }
  ]));
  await chunks(prices, 500, async (rows) => {
    must(await service.from("variant_prices").insert(rows).select("variant_id"), "insert precios");
  });

  // Ahora que cada producto tiene su variante predeterminada activa, se
  // activan y publican en un solo golpe — el trigger diferido queda contento.
  console.log("  activando productos…");
  psql(`
    update public.products
    set is_active = true, editorial_status = 'published'
    where code like 'VOLB5-%';
  `);

  // Ventas consistentes por SQL puro: total = suma de líneas, un pago igual al
  // total, costo conocido — y `set constraints all immediate` para que los
  // triggers diferidos del Bloque 2 VALIDEN cada lote antes del commit.
  console.log("  ventas…");
  const variantIdsSql = `array(select id from public.product_variants where sku like 'VOLB5-%' order by sku)`;
  const batch = 500;
  for (let offset = 0; offset < SALES; offset += batch) {
    psql(`
      begin;
      with vars as (select ${variantIdsSql} as ids),
      nums as (select generate_series(${offset + 1}, ${Math.min(offset + batch, SALES)}) as n),
      inserted_sales as (
        insert into public.sales (id, branch_id, sale_number, status, source_channel,
          gross_subtotal, discount_total, total, seller_label, client_operation_id, issued_at, notes)
        select gen_random_uuid(), '${branch.id}', 'VOLB5-' || n, 'confirmed',
          (array['in_store','whatsapp','web','instagram'])[1 + (n % 4)]::public.sale_source_channel,
          20 + (n % 60), 0, 20 + (n % 60), 'Volumen B5', gen_random_uuid(),
          now() - ((n % 60) || ' days')::interval - ((n % 720) || ' minutes')::interval, 'VOLB5'
        from nums
        returning id, sale_number, total
      ),
      inserted_lines as (
        insert into public.sale_lines (sale_id, variant_id, sku, product_name, variant_name,
          quantity, unit_price, discount_amount, subtotal, purchase_mode)
        select s.id,
          (select ids[1 + (substr(s.sale_number, 7)::int % array_length(ids, 1))] from vars),
          'VOLB5-SKU', 'Producto volumen', 'Tono', 1, s.total, 0, s.total, 'retail'
        from inserted_sales s
        returning id, sale_id, subtotal
      ),
      inserted_costs as (
        insert into public.sale_line_costs (sale_line_id, sale_id, unit_cost, total_cost, cost_basis, valued_units)
        select l.id, l.sale_id, 4, 4, 'weighted_average', 1 from inserted_lines l
        returning sale_line_id
      )
      insert into public.sale_payments (sale_id, method, amount)
      select s.id, 'cash', s.total from inserted_sales s;
      set constraints all immediate;
      commit;
    `);
  }

  console.log("  conversaciones y mensajes…");
  psql(`
    begin;
    insert into public.channel_accounts (channel_id, branch_id, display_name, external_account_id)
    select ch.id, '${branch.id}', 'WhatsApp volumen B5', 'volb5-account'
    from public.channels ch where ch.code = 'whatsapp'
    on conflict do nothing;

    with account as (select id, channel_id from public.channel_accounts where external_account_id = 'volb5-account'),
    nums as (select generate_series(1, ${CONVERSATIONS}) as n),
    contacts as (
      insert into public.channel_contacts (channel_account_id, external_contact_id, display_name, phone_normalized)
      select account.id, 'volb5-' || n, 'Clienta volumen ' || n, '519' || lpad(n::text, 8, '7')
      from nums, account
      returning id, channel_account_id, external_contact_id
    ),
    convs as (
      -- Todas abiertas: una cerrada exige sus campos de cierre (close_
      -- consistent), y para medir la bandeja el estado es irrelevante.
      insert into public.channel_conversations (channel_account_id, channel_contact_id, branch_id, status, opened_at, last_activity_at)
      select c.id_account, c.id_contact, '${branch.id}',
        'open'::public.conversation_status,
        now() - ((n % 45) || ' days')::interval,
        now() - ((n % 45) || ' days')::interval + interval '30 minutes'
      from (select row_number() over () as n, channel_account_id as id_account, id as id_contact from contacts) c
      returning id, channel_account_id
    )
    -- Todos entrantes: un saliente exige remitente (channel_messages_outbound_
    -- has_sender), y para medir la bandeja la dirección es irrelevante — lo que
    -- importa es el VOLUMEN de mensajes y conversaciones.
    insert into public.channel_messages (conversation_id, channel_account_id, direction, message_type, status, body, external_message_id, received_at)
    select convs.id, convs.channel_account_id,
      'inbound'::public.message_direction,
      'text',
      'received'::public.message_delivery_status,
      'Mensaje de volumen ' || gs,
      'volb5-m-' || convs.id || '-' || gs,
      now() - interval '1 day' + (gs || ' minutes')::interval
    from convs, generate_series(1, ${MESSAGES_PER_CONV}) gs;
    commit;
  `);

  console.log("  carritos persistentes…");
  const webChannel = must(await service.from("channels").select("id").eq("code", "web").single(), "canal web");
  psql(`
    begin;
    with vars as (select array(select id from public.product_variants where sku like 'VOLB5-%' limit 500) as ids),
    nums as (select generate_series(1, ${CARTS}) as n),
    visitors as (
      insert into public.anonymous_visitors (id)
      select gen_random_uuid() from nums returning id
    ),
    carts as (
      insert into public.public_carts (anonymous_visitor_id, channel_id, branch_id, status, metadata, last_activity_at)
      select v.id, '${webChannel.id}', '${branch.id}',
        (case when n % 3 = 0 then 'abandoned' else 'active' end)::public.cart_status,
        '{"volb5":"1"}'::jsonb,
        now() - ((n % 30) || ' days')::interval
      from (select row_number() over () as n, id from visitors) v
      returning id
    )
    insert into public.public_cart_items (cart_id, variant_id, quantity)
    select carts.id, (select ids[1 + (gs % 500)] from vars), 1 + (gs % 3)
    from carts, generate_series(1, 2) gs
    on conflict do nothing;
    commit;
  `);

  console.log("  gastos…");
  psql(`
    insert into public.expenses (branch_id, expense_category_id, method, amount, incurred_at, description, client_operation_id)
    select '${branch.id}', (select id from public.expense_categories limit 1), 'cash',
      10 + (n % 90), current_date - (n % 60), 'VOLB5 gasto ' || n, gen_random_uuid()
    from generate_series(1, 500) n;
  `);

  const counts = psql(`
    select 'productos: ' || count(*) from public.products where code like 'VOLB5-%'
    union all select 'ventas: ' || count(*) from public.sales where notes = 'VOLB5'
    union all select 'mensajes: ' || (select count(*) from public.channel_messages where external_message_id like 'volb5-%')
    union all select 'carritos: ' || (select count(*) from public.public_carts where metadata->>'volb5' = '1');
  `);
  console.log(counts.split("\n").map((line) => `  ${line}`).join("\n"));
}

// ---------------------------------------------------------------------------
// 2. Mediciones
// ---------------------------------------------------------------------------

const RUNS = 7;

async function timeIt(fn) {
  const times = [];
  for (let index = 0; index < RUNS; index += 1) {
    const started = performance.now();
    await fn();
    times.push(Math.round(performance.now() - started));
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], worst: times[times.length - 1] };
}

async function measureAll() {
  const admin = await asAdmin.auth.signInWithPassword({ email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" });
  if (admin.error) throw new Error(`Sesión admin: ${admin.error.message}`);

  const someProduct = must(await service.from("products").select("slug").like("code", "VOLB5-%").limit(1).single(), "producto de muestra");
  const tenVariants = must(await service.from("product_variants").select("id").like("sku", "VOLB5-%").limit(10), "variantes de muestra");
  const someCart = must(await service.from("public_carts").select("public_token, metadata").eq("status", "active").limit(1).single(), "carrito de muestra");
  const someVariantForSale = tenVariants[0].id;
  const branch = must(await service.from("branches").select("id").eq("is_default", true).limit(1).single(), "sede");

  const lines10 = tenVariants.map((variant, index) => ({ variantId: variant.id, quantity: 1 + (index % 3) }));

  const surfaces = [
    {
      name: "Catálogo público (página 1 × 24)", threshold: 600,
      fn: async () => { const r = await fetch(`${BASE_URL}/api/catalog?page=1&pageSize=24`); if (!r.ok) throw new Error(String(r.status)); await r.json(); },
      explain: `select * from public.catalog_list_v2(1, 24, null, null, null, null, '{}'::jsonb, 'featured');`
    },
    {
      name: "Búsqueda («volumen»)", threshold: 700,
      fn: async () => { const r = await fetch(`${BASE_URL}/api/catalog?page=1&pageSize=24&search=volumen`); if (!r.ok) throw new Error(String(r.status)); await r.json(); },
      explain: `select * from public.catalog_list_v2(1, 24, 'volumen', null, null, null, '{}'::jsonb, 'featured');`
    },
    {
      name: "Detalle de producto", threshold: 600,
      fn: async () => { const r = await fetch(`${BASE_URL}/api/catalog/${someProduct.slug}`); if (!r.ok) throw new Error(String(r.status)); await r.json(); },
      explain: null
    },
    {
      name: "Evaluación de carrito (10 líneas)", threshold: 500,
      fn: async () => { must(await service.rpc("evaluate_cart_v2", { p_lines: lines10 }), "evaluate"); },
      explain: null
    },
    {
      name: "Registrar venta (2 líneas, RPC completo)", threshold: 1200, once: true,
      fn: async () => {
        const evaluated = must(await service.rpc("evaluate_cart_v2", { p_lines: lines10.slice(0, 2) }), "evaluar venta");
        must(await asAdmin.rpc("register_sale", {
          p_branch_id: branch.id,
          p_lines: lines10.slice(0, 2),
          p_payments: [{ method: "cash", amount: evaluated.subtotal ?? evaluated.total }],
          p_client_operation_id: crypto.randomUUID(),
          p_source_channel: "in_store", p_fulfillment_method: "in_store",
          p_customer: { name: "Medición B5" }, p_discount_total: 0,
          p_notes: "VOLB5", p_reservation_id: null, p_source_reference: null
        }), "register_sale");
      },
      explain: null
    },
    {
      name: "Crear reserva (RPC completo)", threshold: 1200, once: true,
      fn: async () => {
        must(await asAdmin.rpc("create_reservation", {
          p_branch_id: branch.id,
          p_lines: [{ variantId: someVariantForSale, quantity: 1 }],
          p_customer: { name: "Reserva medición B5" },
          p_expires_at: new Date(Date.now() + 2 * 86400000).toISOString(),
          p_client_operation_id: crypto.randomUUID(),
          p_advance: null,
          p_notes: "VOLB5"
        }), "create_reservation");
      },
      explain: null
    },
    {
      name: "Kardex (inventory_ledger, 50 filas)", threshold: 700,
      fn: async () => { must(await asAdmin.rpc("inventory_ledger", { p_variant_id: someVariantForSale, p_branch_id: branch.id, p_from: null, p_to: null, p_limit: 50 }), "kardex"); },
      explain: null
    },
    {
      name: "Lectura de caja (daily_cash_summary)", threshold: 800,
      fn: async () => { must(await asAdmin.rpc("daily_cash_summary", { p_branch_id: branch.id, p_date: new Date().toISOString().slice(0, 10) }), "caja"); },
      explain: null
    },
    {
      name: "business_dashboard (30 días)", threshold: 1500,
      fn: async () => { must(await asAdmin.rpc("business_dashboard", {}), "tablero 30d"); },
      explain: null
    },
    {
      name: "business_dashboard (90 días, rankings)", threshold: 2000,
      fn: async () => {
        const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
        must(await asAdmin.rpc("business_dashboard", { p_from: from }), "tablero 90d");
      },
      explain: null
    },
    {
      name: "Bandeja de conversaciones (30 más recientes)", threshold: 700,
      fn: async () => {
        must(await service.from("channel_conversations")
          .select("id, status, last_activity_at, channel_accounts(display_name), channel_contacts(display_name)")
          .order("last_activity_at", { ascending: false })
          .limit(30), "bandeja");
      },
      explain: `select c.id from public.channel_conversations c order by c.last_activity_at desc limit 30;`
    },
    {
      name: "Carrito persistente (public_cart_detail)", threshold: 700,
      fn: async () => { must(await service.rpc("public_cart_detail", { p_public_token: someCart.public_token }), "carrito"); },
      explain: null
    }
  ];

  console.log(`\nMediciones (${RUNS} corridas por superficie, mediana y peor caso):\n`);
  const rows = [];
  for (const surface of surfaces) {
    const result = surface.once
      ? { median: await (async () => { const s = performance.now(); await surface.fn(); return Math.round(performance.now() - s); })(), worst: null }
      : await timeIt(surface.fn);
    const worst = result.worst ?? result.median;
    const pass = result.median <= surface.threshold;
    rows.push({ ...surface, ...result, worst, pass });
    console.log(`${pass ? "✓" : "✗"} ${surface.name}: mediana ${result.median}ms · peor ${worst}ms · umbral ${surface.threshold}ms`);
    if (!pass && surface.explain) {
      console.log(`\n--- EXPLAIN (ANALYZE, BUFFERS) — ${surface.name} ---`);
      console.log(psql(`explain (analyze, buffers) ${surface.explain}`));
      console.log("---\n");
    }
  }

  mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
  writeFileSync(path.join(ROOT, "test-results", "perf-volume.md"), [
    "# Rendimiento con volumen representativo",
    "",
    `Volumen: ${PRODUCTS} productos · ${SALES} ventas · ${CONVERSATIONS} conversaciones (${CONVERSATIONS * MESSAGES_PER_CONV} mensajes) · ${CARTS} carritos · sobre la operación demo existente.`,
    "",
    "| Superficie | Mediana | Peor | Umbral | Estado |",
    "|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.name} | ${row.median}ms | ${row.worst}ms | ${row.threshold}ms | ${row.pass ? "✓" : "✗"} |`),
    ""
  ].join("\n"));
  console.log("\nEvidencia: test-results/perf-volume.md");

  return rows.filter((row) => !row.pass);
}

// ---------------------------------------------------------------------------

if (!SKIP_SEED) await seedVolume();
const failures = await measureAll();

if (!KEEP) {
  await cleanupVolume();
  console.log("Volumen retirado (usa --keep para conservarlo).");
}

if (failures.length > 0) {
  console.error(`\n${failures.length} superficie(s) fuera de umbral — revisar los EXPLAIN de arriba.`);
  process.exit(1);
}
console.log("\nTODAS las superficies dentro de umbral con volumen representativo.");
