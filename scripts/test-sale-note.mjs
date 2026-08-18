// La nota impresa, comprobada en la pantalla real y sobre ventas ya registradas.
//
// Uso: node scripts/test-sale-note.mjs --env .env.supabase.local
//      E2E_BASE_URL=http://127.0.0.1:3006 node scripts/test-sale-note.mjs …
//
// QUÉ COMPRUEBA, Y POR QUÉ NO LO CUBRE OTRA PRUEBA:
//
//   · Que imprimir NO modifique nada. pgTAP no puede verlo porque el riesgo no
//     está en una función, está en que la pantalla dispare un POST al abrirse.
//     Se toma una huella de ventas, pagos, caja y kardex antes y después de
//     abrir varias notas varias veces; si cambia un solo byte, falla.
//   · Que el saldo pendiente NO se lea como dinero recibido. Es el error que un
//     ticket puede cometer sin que ninguna restricción lo note: los importes son
//     correctos y aun así la clienta entiende que ya pagó.
//   · Que una venta anulada lo diga. Un ticket reimpreso idéntico al de una
//     venta viva es el que se usa para reclamar una entrega que no existe.
//   · Que la impresión esté AISLADA: en la página de la nota no hay panel.
//
// Las ventas las crea la propia prueba y quedan en la base local, igual que las
// del resto de pruebas de flujo: una venta no se borra, se anula.

import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { signInToPanel } from "./lib/admin-login.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-sale-note" });

if (!isLocal) {
  throw new Error("La prueba de la nota impresa solo corre contra Supabase local.");
}

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const SELLER = { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!" };
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let failures = 0;
let browser;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

async function rpc(name, args) {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data;
}

/**
 * Huella de lo que imprimir NO puede tocar, ACOTADA a las ventas de la prueba.
 *
 * La primera versión medía las cuatro tablas enteras y falló por un motivo que
 * no era el suyo: la base local la comparten varias sesiones de desarrollo, y
 * una venta registrada por otra persona mientras esto corría movía la huella.
 * Una prueba que puede fallar por algo ajeno a lo que afirma es una prueba que
 * se acaba ignorando. Lo que se afirma es «reimprimir ESTAS ventas no las
 * modifica», y eso es exactamente lo que ahora se mide.
 */
async function huella(saleIds) {
  const [ventas, pagos, caja, kardex] = await Promise.all([
    admin.from("sales").select("id, sale_number, status, total, updated_at, fulfillment_status, payment_terms").in("id", saleIds),
    admin.from("sale_payments").select("id, sale_id, method, amount, received_at").in("sale_id", saleIds),
    admin.from("cash_movements").select("id, amount, source_id").eq("source_type", "sale").in("source_id", saleIds),
    admin.from("inventory_movements").select("id, quantity, source_id").eq("source_type", "sale").in("source_id", saleIds)
  ]);
  for (const r of [ventas, pagos, caja, kardex]) {
    if (r.error) throw new Error(`No se pudo leer la huella: ${r.error.message}`);
  }
  return [ventas, pagos, caja, kardex]
    .map((r) => r.data.map((row) => JSON.stringify(row)).sort().join("|"))
    .join("#");
}

async function branchAndVariant() {
  const { data: sede } = await admin.from("branches").select("id").eq("code", "PRINCIPAL").single();
  const { data: stock } = await admin
    .from("inventory_stock")
    .select("variant_id, on_hand")
    .eq("branch_id", sede.id)
    .gt("on_hand", 6)
    .limit(1);
  if (!stock?.length) throw new Error("No hay existencia suficiente en la sede principal para la prueba.");
  return { branchId: sede.id, variantId: stock[0].variant_id };
}

async function textoDeLaNota(page, saleId) {
  await page.goto(`${baseUrl}/admin/ventas/${saleId}/nota`, { waitUntil: "networkidle0", timeout: 60000 });
  await page.waitForSelector(".ticket", { timeout: 30000 });
  return page.$eval(".ticket", (node) => node.innerText);
}

async function main() {
  const { branchId, variantId } = await branchAndVariant();

  const precio = (await rpc("evaluate_cart_v2", {
    p_lines: [{ variantId, quantity: 2 }]
  })).subtotal;

  console.log("\nPreparando las ventas que se van a imprimir");

  // 1. Mostrador, pago dividido: efectivo + Yape con su código.
  const dividida = await rpc("register_sale", {
    p_branch_id: branchId,
    p_lines: [{ variantId, quantity: 2 }],
    p_payments: [
      { method: "cash", amount: 5, tenderedAmount: 5 },
      { method: "yape", amount: Number(precio) - 5, reference: "00445511" }
    ],
    p_client_operation_id: randomUUID()
  });

  // 2. Contra entrega a medio cobrar: el caso que un ticket puede contar mal.
  const contraEntrega = await rpc("register_sale", {
    p_branch_id: branchId,
    p_lines: [{ variantId, quantity: 2 }],
    p_payments: [{ method: "yape", amount: 5, reference: "00445522" }],
    p_client_operation_id: randomUUID(),
    p_source_channel: "whatsapp",
    p_fulfillment_method: "local_delivery",
    p_customer: { name: "Rosa Díaz", phone: "987654321" },
    p_parties: [{ role: "recipient", fullName: "Carmen Díaz", phone: "999111222", address: "Jr. Puno 456, Lince" }],
    p_payment_terms: "on_delivery"
  });

  // 3. Una venta anulada.
  const anulada = await rpc("register_sale", {
    p_branch_id: branchId,
    p_lines: [{ variantId, quantity: 2 }],
    p_payments: [{ method: "cash", amount: precio, tenderedAmount: precio }],
    p_client_operation_id: randomUUID()
  });
  await rpc("cancel_sale", {
    p_sale_id: anulada.id,
    p_reason_code: "customer_regret",
    p_explanation: "Prueba de impresión",
    p_refunds: [{ method: "cash", amount: precio }],
    p_evidence_path: null
  });

  const bajoPrueba = [dividida.id, contraEntrega.id, anulada.id];
  const antes = await huella(bajoPrueba);

  browser = await puppeteer.launch({
    headless: "new",
    executablePath: await resolveBrowserExecutable(),
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage();
  await signInToPanel(page, {
    baseUrl, email: SELLER.email, password: SELLER.password, expectedPath: "/admin/ventas"
  });

  // -------------------------------------------------------------------------
  console.log("\n1. La impresión está aislada del panel");
  // -------------------------------------------------------------------------
  await page.goto(`${baseUrl}/admin/ventas/${dividida.id}/nota`, { waitUntil: "networkidle0" });
  await page.waitForSelector(".ticket");

  const panel = await page.$(".panel-shell");
  check("la página de la nota no monta el panel", panel === null);
  const topbar = await page.$(".side-rail, .side-topbar, nav");
  check("ni su navegación", topbar === null);

  // Y lo que de verdad importa: qué queda VISIBLE cuando el navegador cambia al
  // medio de impresión. Que el panel no esté montado es la mitad; la otra es
  // que de esta página solo se imprima el ticket.
  await page.emulateMediaType("print");
  const enPapel = await page.evaluate(() => {
    const visible = (node) => {
      const s = window.getComputedStyle(node);
      return s.display !== "none" && s.visibility !== "hidden" && node.getClientRects().length > 0;
    };
    // Todo elemento con texto propio que se vería impreso, sin contar los
    // contenedores (que solo envuelven a sus hijos).
    const conTexto = [...document.body.querySelectorAll("*")].filter((node) => {
      if (!visible(node)) return false;
      const propio = [...node.childNodes]
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join("");
      return propio.length > 0;
    });
    return {
      fueraDelTicket: conTexto.filter((n) => !n.closest(".ticket")).map((n) => n.textContent.trim().slice(0, 40)),
      dentroDelTicket: conTexto.filter((n) => n.closest(".ticket")).length,
      barraVisible: (() => {
        const barra = document.querySelector(".form-head");
        return barra ? window.getComputedStyle(barra).display !== "none" : false;
      })()
    };
  });
  await page.emulateMediaType(null);

  check("al imprimir, la barra de controles desaparece", enPapel.barraVisible === false);
  check("y NADA fuera del ticket llega al papel",
    enPapel.fueraDelTicket.length === 0,
    `se imprimiría también: ${JSON.stringify(enPapel.fueraDelTicket)}`);
  check("mientras el ticket sí se imprime entero",
    enPapel.dentroDelTicket > 15, `elementos con texto en el ticket: ${enPapel.dentroDelTicket}`);

  // -------------------------------------------------------------------------
  console.log("\n2. Pago dividido: cada medio con su importe");
  // -------------------------------------------------------------------------
  const textoDividida = await page.$eval(".ticket", (node) => node.innerText);
  check("aparece el efectivo", /Efectivo/.test(textoDividida), textoDividida);
  check("aparece el Yape con su número de operación",
    /Yape ·00445511/.test(textoDividida), textoDividida);
  check("y el número de venta", textoDividida.includes(dividida.saleNumber));
  check("sin llamarse boleta ni factura",
    !/\bBOLETA\b|\bFACTURA\b/.test(textoDividida.replace(/Si necesita boleta o factura[^]*/i, "")),
    textoDividida);

  // -------------------------------------------------------------------------
  console.log("\n3. Contra entrega: lo cobrado no se confunde con lo que falta");
  // -------------------------------------------------------------------------
  const textoCE = await textoDeLaNota(page, contraEntrega.id);
  check("dice cuánto se cobró a cuenta", /Cobrado a cuenta/.test(textoCE), textoCE);
  check("y cuánto FALTA, en su propia línea", /FALTA POR PAGAR/.test(textoCE), textoCE);
  check("explicando cuándo se cobra", /Se cobra al recibir/.test(textoCE), textoCE);
  check("muestra a quién se le entrega, que no es la compradora",
    /Recibe: Carmen Díaz/.test(textoCE), textoCE);
  check("y dónde", /Jr. Puno 456/.test(textoCE), textoCE);

  // -------------------------------------------------------------------------
  console.log("\n4. Venta anulada");
  // -------------------------------------------------------------------------
  const textoAnulada = await textoDeLaNota(page, anulada.id);
  check("el ticket de una venta anulada lo dice", /ANULADA/.test(textoAnulada), textoAnulada);

  // -------------------------------------------------------------------------
  console.log("\n5. Reimprimir no cambia nada");
  // -------------------------------------------------------------------------
  for (let vuelta = 0; vuelta < 3; vuelta += 1) {
    for (const id of bajoPrueba) {
      await textoDeLaNota(page, id);
    }
  }

  const despues = await huella(bajoPrueba);
  check("tras nueve reimpresiones, ventas, pagos, caja y kardex están intactos",
    antes === despues,
    antes === despues ? "" : "la huella cambió: imprimir escribió algo");

  await browser.close();
  console.log(
    failures === 0
      ? "\nPASS · la nota se imprime aislada, cuenta el dinero como es y reimprimir no escribe nada"
      : `\nFALLO · ${failures} comprobación(es)`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exit(1);
});
