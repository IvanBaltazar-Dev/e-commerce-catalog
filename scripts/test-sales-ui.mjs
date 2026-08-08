// Prueba de extremo a extremo de la caja DESDE LA PANTALLA, con la sesión real
// de una vendedora. No repite lo que ya cubren pgTAP ni la prueba de
// concurrencia: comprueba lo único que ninguna de las dos puede ver, que es si
// la persona que atiende el mostrador puede cobrar sin pasar por la consola.
//
// Uso: node scripts/test-sales-ui.mjs --env .env.supabase.local
//      E2E_BASE_URL=http://127.0.0.1:3001 node scripts/test-sales-ui.mjs …
//
// Requiere `node scripts/seed-demo-operation.mjs` ejecutado antes: usa la
// vendedora demo, su sede y la existencia inicial cargada por el contrato.

import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { signInToPanel } from "./lib/admin-login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-sales-ui" });

if (!isLocal) {
  throw new Error("La prueba de pantalla de caja solo corre contra Supabase local.");
}

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const SELLER = { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!" };
const ADMIN = { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let failures = 0;
let browser;
let createdSaleId;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

/**
 * Foto de las existencias por variante. Se compara contra las LÍNEAS de la
 * venta que quedó registrada, no contra un SKU fijado a mano: la pantalla elige
 * la primera presentación disponible del producto, y cuál sea depende del
 * catálogo del día.
 */
/**
 * Garantiza que la sede de la vendedora tenga con qué vender. Cada ejecución
 * consume unidades, así que sin esto la prueba acaba fallando por «agotado» —un
 * fallo legítimo del producto que aquí solo significa que se corrió muchas
 * veces—. Se repone por el CONTRATO de ajuste, con su motivo, no con un INSERT.
 */
async function ensureStock(minimum = 12, topUp = 60) {
  const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });

  const signIn = await asAdmin.auth.signInWithPassword(ADMIN);
  if (signIn.error) throw new Error(`No se pudo abrir sesión de administración: ${signIn.error.message}`);

  const branches = must(
    await admin.from("staff_branches").select("branch_id, admin_profiles!inner(full_name)")
      .eq("admin_profiles.full_name", "Vendedora demo"),
    "sedes de la vendedora"
  );
  const branchId = branches[0]?.branch_id;
  if (!branchId) throw new Error("La vendedora demo no tiene sede asignada: corre seed:demo-operation.");

  const variants = must(
    await admin.from("product_variants").select("id, sku").eq("tracks_inventory", true),
    "variantes con seguimiento"
  );

  for (const variant of variants) {
    const rows = must(
      await admin.from("inventory_stock").select("on_hand")
        .eq("variant_id", variant.id).eq("branch_id", branchId),
      "existencias"
    );
    const onHand = rows[0]?.on_hand ?? 0;
    if (onHand >= minimum) continue;

    const { error } = await asAdmin.rpc("adjust_inventory", {
      p_variant_id: variant.id,
      p_branch_id: branchId,
      p_quantity: topUp,
      p_reason: "Reposición para la prueba de pantalla",
      p_unit_cost: 9.5
    });
    if (error) throw new Error(`reposición de ${variant.sku}: ${error.message}`);
  }

  await asAdmin.auth.signOut().catch(() => undefined);
}

async function stockSnapshot() {
  const rows = must(
    await admin.from("inventory_stock").select("variant_id, branch_id, on_hand"),
    "existencias"
  );
  return new Map(rows.map((row) => [`${row.variant_id}|${row.branch_id}`, row.on_hand]));
}

try {
  await ensureStock();

  const before = await stockSnapshot();
  if (before.size === 0) throw new Error("Falta la existencia inicial: corre scripts/seed-demo-operation.mjs.");

  // Identidad de las ventas que YA existían. La venta de esta prueba se
  // reconoce por diferencia, no por «la más reciente»: sobre una base con
  // historial —y varias ventas en el mismo segundo— ordenar por issued_at
  // devuelve otra, y las aserciones pasan o fallan por la venta equivocada.
  const salesBefore = new Set(
    must(await admin.from("sales").select("id"), "ventas previas").map((row) => row.id)
  );

  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 120000,
    args: ["--no-sandbox", "--disable-gpu"],
    executablePath: await resolveBrowserExecutable()
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(90000);
  page.setDefaultNavigationTimeout(90000);

  console.log("\n1. La vendedora entra al panel y aterriza en su caja");

  await signInToPanel(page, {
    baseUrl,
    email: SELLER.email,
    password: SELLER.password,
    expectedPath: "/admin/ventas"
  });

  check("la vendedora aterriza en /admin/ventas", true);

  await page.waitForSelector(".order-page");
  // La vendedora opera venta, caja e inventario de sus sedes. El catálogo, los
  // gastos y el PDF no son suyos: la RLS ya se lo impide y la barra no debe
  // ofrecerle pantallas donde solo encontraría cero filas.
  // Desde S2 la navegación tiene dos niveles: ocho áreas arriba y, dentro del
  // área activa, sus pantallas. Lo que se exige no cambia —qué ve y qué no ve
  // la vendedora— pero hay que mirar los dos niveles, no solo el primero: su
  // caja vive dentro de Ventas.
  const navLabels = await page.$$eval(
    ".topbar-nav .nav-pill, .nav-subbar .nav-sub",
    (nodes) => nodes.map((node) => node.textContent?.trim())
  );
  const forbiddenSections = ["Productos", "Catálogo PDF", "Gastos", "Compras", "Importaciones"];
  check(
    "ve su caja y su inventario, y ninguna sección administrativa",
    ["Ventas", "Caja", "Inventario"].every((label) => navLabels.includes(label))
      && forbiddenSections.every((label) => !navLabels.includes(label)),
    `navegación = ${JSON.stringify(navLabels)}`
  );

  console.log("\n2. Arma la venta desde el catálogo");

  await page.waitForSelector(".order-search");
  await page.type(".order-search", "Gel Evolution");
  await page.waitForFunction(
    () => document.querySelectorAll(".order-product").length > 0,
    { timeout: 30000 }
  );
  await page.click(".order-product");
  await page.waitForSelector(".order-variant");

  // Se agregan dos unidades de la primera presentación disponible.
  const added = await page.$$eval(".order-variant", (nodes) => {
    const target = nodes.find((node) => !node.querySelector("button")?.disabled);
    if (!target) return null;
    target.querySelector("button").click();
    return target.querySelector("small")?.textContent ?? "";
  });
  check("agrega una presentación disponible", added !== null, "todas las presentaciones salían agotadas");

  await page.waitForSelector(".order-line");
  await page.click(".order-qty button:last-child");

  await page.waitForFunction(
    () => document.querySelector(".sale-totals-final b")?.textContent?.includes("S/"),
    { timeout: 30000 }
  );

  const total = await page.$eval(".sale-totals-final b", (node) => node.textContent?.trim());
  check("PostgreSQL resuelve el total y la pantalla lo muestra", Boolean(total && total !== "—"), `total = ${total}`);

  console.log("\n3. Cobra y registra");

  // «Completar» reparte lo que falta sobre el pago. Si se pulsa mientras la
  // pantalla aún recalcula, el importe pendiente todavía es nulo y el botón no
  // hace nada: se REINTENTA hasta que la cobranza cuadre, en lugar de esperar
  // un tiempo fijo y dar por hecho que fue suficiente.
  let balanced = false;
  for (let attempt = 1; attempt <= 8 && !balanced; attempt += 1) {
    await page.$$eval(".sale-payment .btn-soft", (nodes) => nodes[0]?.click());
    balanced = await page
      .waitForFunction(() => document.querySelector(".sale-balance--ok") !== null, { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
  }

  check("el botón de completar cuadra el cobro al céntimo", balanced,
    await page.$eval(".sale-balance", (node) => node.textContent).catch(() => "sin balance"));

  // Se espera a que el botón esté HABILITADO, no a que el total aparezca. La
  // pantalla lo deshabilita mientras recalcula precios, y hay un instante en
  // que el total ya está pintado y el recálculo aún no ha terminado: pulsarlo
  // ahí no hace nada, no sale ningún aviso, y la prueba pasaba o fallaba según
  // lo rápido que fuera la máquina.
  await page.waitForFunction(
    () => {
      const button = [...document.querySelectorAll(".order-actions button")]
        .find((node) => node.textContent?.includes("Registrar venta"));
      return Boolean(button) && !button.disabled;
    },
    { timeout: 60000 }
  );

  await page.$$eval(".order-actions button", (nodes) => {
    nodes.find((node) => node.textContent?.includes("Registrar venta")).click();
  });
  // Se espera el TEXTO, no el elemento: el aviso de «producto agregado» sigue en
  // pantalla y un waitForSelector lo daría por bueno sin haber cobrado nada.
  const toast = await page
    .waitForFunction(
      () => {
        const text = document.querySelector(".toast")?.textContent ?? "";
        return /Venta NV-\d{6} registrada/.test(text) ? text : false;
      },
      { timeout: 60000 }
    )
    .then((handle) => handle.jsonValue())
    .catch(() => "");
  check("la venta se registra y devuelve su correlativo", /Venta NV-\d{6} registrada/.test(toast), `toast = ${toast}`);

  await page.waitForFunction(
    () => document.querySelectorAll(".order-history-item").length > 0,
    { timeout: 30000 }
  );

  console.log("\n4. Lo que la base debe haber hecho");

  const sales = must(
    await admin.from("sales").select("id, sale_number, branch_id, total, seller_label, status"),
    "ventas"
  ).filter((row) => !salesBefore.has(row.id));

  if (sales.length !== 1) {
    throw new Error(`La pantalla debía dejar exactamente una venta nueva y dejó ${sales.length}.`);
  }

  const sale = sales[0];
  createdSaleId = sale.id;

  check("queda una venta confirmada con vendedora identificada",
    sale.status === "confirmed" && sale.seller_label === "Vendedora demo",
    JSON.stringify(sale));

  const payments = must(
    await admin.from("sale_payments").select("amount").eq("sale_id", sale.id),
    "pagos de la venta"
  );
  const paid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
  check("la cobranza suma exactamente el total", Math.abs(paid - Number(sale.total)) < 0.0001,
    `cobrado ${paid} · total ${sale.total}`);

  const after = await stockSnapshot();
  const soldLines = must(
    await admin.from("sale_lines").select("variant_id, quantity, sku").eq("sale_id", sale.id),
    "líneas de la venta"
  );
  const stockDrops = soldLines.map((line) => {
    const key = `${line.variant_id}|${sale.branch_id}`;
    return {
      sku: line.sku,
      expected: (before.get(key) ?? 0) - line.quantity,
      actual: after.get(key) ?? 0
    };
  });

  check(
    "la existencia bajó exactamente en las unidades vendidas",
    stockDrops.length > 0 && stockDrops.every((drop) => drop.actual === drop.expected),
    JSON.stringify(stockDrops)
  );

  const costs = must(
    await admin.from("sale_line_costs").select("unit_cost, cost_basis").eq("sale_id", sale.id),
    "costos capturados"
  );
  check("cada línea capturó su costo al confirmar",
    costs.length > 0 && costs.every((cost) => cost.cost_basis !== null),
    JSON.stringify(costs));

  console.log("\n5. La vendedora no ve el costo por ninguna vía");

  const detail = await page.evaluate(async (id) => {
    const response = await fetch(`/api/admin/sales/${id}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  }, sale.id);

  check("el detalle que sirve la aplicación llega sin bloque de costo",
    detail.status === 200 && detail.body.data.lines.every((line) => line.cost === null || line.cost === undefined),
    JSON.stringify(detail.body?.data?.lines?.map((line) => line.cost)));

  const forbidden = await page.evaluate(async () => {
    const response = await fetch("/api/admin/productos", { method: "GET" }).catch(() => null);
    return response?.status ?? 0;
  });
  check("y el panel de catálogo no le abre ninguna ruta", forbidden !== 200, `status = ${forbidden}`);

  // El kardex es el hueco menos evidente: inventory_movements lleva unit_cost,
  // value_delta y value_after, y su política concede lectura de fila completa
  // al personal de la sede. Sin el recorte por rol del objeto DEFINER, la
  // vendedora leía el costo de cada asiento con una sola consulta.
  const kardex = await page.evaluate(async ({ variantId, branchId }) => {
    const response = await fetch(`/api/admin/inventory/kardex?variant=${variantId}&branch=${branchId}`);
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { variantId: soldLines[0].variant_id, branchId: sale.branch_id });

  const entries = kardex.body?.data?.items ?? [];

  check("el kardex de su sede sí le llega, con sus asientos", kardex.status === 200 && entries.length > 0,
    `status ${kardex.status} · ${entries.length} asiento(s)`);

  check(
    "pero sin una sola cifra de costo",
    entries.every((entry) => entry.unitCost === null && entry.valueDelta === null && entry.valueAfter === null),
    JSON.stringify(entries.slice(0, 2).map((entry) => ({ unitCost: entry.unitCost, valueAfter: entry.valueAfter })))
  );

  const rawCost = await page.evaluate(async () => {
    // Ruta directa a PostgREST con la sesión de la vendedora: la RLS no recorta
    // columnas, así que el cierre tiene que estar en el privilegio de columna.
    const response = await fetch("/api/admin/inventory/kardex?variant=00000000-0000-4000-8000-000000000000&branch=00000000-0000-4000-8000-000000000000");
    return response.status;
  });
  check("y una consulta con sede ajena no devuelve 200", rawCost !== 200, `status = ${rawCost}`);
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (createdSaleId) {
    const cleanup = await admin.from("sales").delete().eq("id", createdSaleId);
    if (cleanup.error) console.log(`  aviso: no se pudo limpiar la venta (${cleanup.error.message})`);
  }
}

console.log(failures === 0 ? "\nPASS · sin fallos" : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
