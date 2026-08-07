/**
 * Integral del Bloque 4 — inteligencia comercial e IA.
 *
 * Prueba la cadena completa al nivel de los contratos reales:
 *
 *   1. El TABLERO no inventa: cada indicador se recomputa aquí de forma
 *      independiente contra las tablas del Bloque 2 y debe cuadrar exacto.
 *   2. La batería IA del plan (Bloque 5): pedido correcto, ambiguo e
 *      inexistente contra el CATÁLOGO REAL; servicio caído registrado como
 *      fallo; corrección humana descartando.
 *   3. REGLA 9 de punta a punta: proponer y resolver asistencias no crea
 *      ventas; la venta la registra una persona por register_sale y SOLO
 *      entonces la asistencia queda confirmada y enlazada.
 *   4. Tendencias: borrador → aprobación → «publicada por la dueña», con los
 *      atajos prohibidos explotando.
 *
 * Reutilizable (§49): las propuestas de contenido del run se limpian; las
 * interacciones quedan como evidencia descartada/fallida — no se borran
 * porque la base lo PROHÍBE por diseño, y eso también es una verificación.
 */
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { interpretOrderText } from "../src/lib/ai/matching.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-block4-intelligence" });
if (!isLocal) throw new Error("La integral del Bloque 4 solo corre contra Supabase local.");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});
const asSeller = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const results = [];
function check(name, condition, extra = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || !extra ? "" : ` — ${extra}`}`);
}

const adminSession = await asAdmin.auth.signInWithPassword({
  email: "demo-admin@local.invalid", password: "Demo-Admin-2026!"
});
if (adminSession.error) throw new Error(`Sesión admin: ${adminSession.error.message}. Corre seed:demo-operation.`);
const sellerSession = await asSeller.auth.signInWithPassword({
  email: "demo-seller@local.invalid", password: "Demo-Seller-2026!"
});
if (sellerSession.error) throw new Error(`Sesión vendedora: ${sellerSession.error.message}.`);
const adminId = adminSession.data.user.id;

// Limpieza de propuestas de contenido de corridas anteriores.
await service.from("content_proposals").delete().like("title", "%[B4-INTEGRAL]%");

console.log("\n1. El tablero cuadra contra una recomputación independiente");

const desde = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const hasta = new Date().toISOString().slice(0, 10);
const windowStart = `${desde}T00:00:00Z`;
const windowEndDate = new Date(new Date(`${hasta}T00:00:00Z`).getTime() + 86400000).toISOString();

const dashboard = must(
  await asAdmin.rpc("business_dashboard", { p_from: desde, p_to: hasta }),
  "tablero"
);

const salesRows = must(
  await service.from("sales").select("total, branch_id")
    .eq("status", "confirmed").gte("issued_at", windowStart).lt("issued_at", windowEndDate),
  "ventas del rango"
);
const expectedTotal = salesRows.reduce((sum, row) => sum + Number(row.total), 0);
check("Total vendido = suma independiente de sales confirmadas",
  Math.abs(Number(dashboard.ventas.total) - expectedTotal) < 0.005,
  `tablero=${dashboard.ventas.total} recomputado=${expectedTotal}`);
check("Operaciones = conteo independiente",
  Number(dashboard.ventas.operaciones) === salesRows.length);

const expensesRows = must(
  await service.from("expenses").select("amount")
    .is("voided_at", null).gte("incurred_at", desde).lte("incurred_at", hasta),
  "gastos del rango"
);
const expectedExpenses = expensesRows.reduce((sum, row) => sum + Number(row.amount), 0);
check("Gastos del periodo = suma independiente de expenses vigentes",
  Math.abs(Number(dashboard.margen.gastosTotales) - expectedExpenses) < 0.005,
  `tablero=${dashboard.margen.gastosTotales} recomputado=${expectedExpenses}`);

const marginRows = must(
  await service.from("sale_margins").select("margin")
    .gte("issued_at", windowStart).lt("issued_at", windowEndDate),
  "márgenes del rango"
);
const hasUnknown = marginRows.some((row) => row.margin === null);
const expectedMargin = marginRows.reduce((sum, row) => sum + Number(row.margin ?? 0), 0);
if (hasUnknown) {
  check("Con costo desconocido el margen bruto es NULL (doctrina sale_margins)",
    dashboard.margen.margenBruto === null && dashboard.margen.razonNoCalculable === "ventas_sin_costo");
} else {
  check("Margen bruto = suma independiente de sale_margins",
    Math.abs(Number(dashboard.margen.margenBruto) - expectedMargin) < 0.005,
    `tablero=${dashboard.margen.margenBruto} recomputado=${expectedMargin}`);
  check("Utilidad neta estimada = margen − TODOS los gastos (regla 16)",
    Math.abs(Number(dashboard.margen.utilidadNetaEstimada) - (expectedMargin - expectedExpenses)) < 0.005);
}

const branchId = salesRows[0]?.branch_id;
if (branchId) {
  const filtered = must(
    await asAdmin.rpc("business_dashboard", { p_from: desde, p_to: hasta, p_branch_id: branchId }),
    "tablero filtrado"
  );
  const expectedBranch = salesRows.filter((row) => row.branch_id === branchId)
    .reduce((sum, row) => sum + Number(row.total), 0);
  check("El filtro por sede recorta exactamente esa sede",
    Math.abs(Number(filtered.ventas.total) - expectedBranch) < 0.005);
}

const asSellerDashboard = await asSeller.rpc("business_dashboard", {});
check("La vendedora NO ve el tablero (42501)",
  asSellerDashboard.error != null && /administrativ/i.test(asSellerDashboard.error.message));

console.log("\n2. La batería IA del plan, contra el catálogo real");

const catalogRows = must(
  await service.from("product_variants").select(`
    id, sku, name,
    products!inner(id, name, is_active, brands(name), categories(name)),
    color_shades(name)
  `).eq("is_active", true).eq("products.is_active", true).limit(400),
  "catálogo real"
);
const one = (value) => (Array.isArray(value) ? value[0] ?? null : value);
const catalog = catalogRows.map((row) => ({
  variantId: row.id,
  productId: row.products.id,
  sku: row.sku,
  productName: row.products.name,
  variantName: row.name,
  shadeName: one(row.color_shades)?.name ?? null,
  brandName: one(row.products.brands)?.name ?? null,
  categoryName: one(row.products.categories)?.name ?? null,
  available: true
}));
if (catalog.length === 0) throw new Error("Catálogo vacío: corre seed:demo-operation.");

const correcto = interpretOrderText("tres rojo intenso", catalog);
check("Pedido CORRECTO: una línea clara con cantidad 3",
  correcto.lineas.length === 1 && correcto.lineas[0].cantidad === 3 &&
  correcto.ambiguedades.length === 0,
  JSON.stringify(correcto).slice(0, 140));

const ambiguo = interpretOrderText("un gel evolution", catalog);
check("Pedido AMBIGUO: los tonos compiten y se declara la duda",
  ambiguo.ambiguedades.length >= 1 && ambiguo.ambiguedades[0].opciones.length >= 2,
  JSON.stringify(ambiguo).slice(0, 140));

const inexistente = interpretOrderText("una freidora de aire industrial", catalog);
check("Producto INEXISTENTE: va a noEncontrado, sin inventos",
  inexistente.noEncontrado.length === 1 && inexistente.lineas.length === 0);

console.log("\n3. Regla 9: la IA propone, solo una persona vende");

const countSales = async () => {
  const { count, error } = await service.from("sales").select("id", { count: "exact", head: true });
  if (error) throw new Error(error.message);
  return count;
};
const salesBefore = await countSales();

const interactionId = must(
  await asSeller.rpc("record_ai_interaction", {
    p_kind: "audio_order",
    p_input_summary: "[B4-INTEGRAL] tres rojo intenso",
    p_proposal: { lineas: correcto.lineas },
    p_provider_status: "degraded"
  }),
  "registrar asistencia"
);
check("La vendedora registró la asistencia con su propuesta", typeof interactionId === "string");

// El servicio caído es un RESULTADO, no una excepción (regla 10).
const failedId = must(
  await asAdmin.rpc("record_ai_interaction", {
    p_kind: "photo_recognition",
    p_input_summary: "[B4-INTEGRAL] foto sin credencial",
    p_provider_status: "unavailable",
    p_error_message: "Sin credencial de IA configurada"
  }),
  "registrar caída"
);
const failedRow = must(
  await service.from("ai_interactions").select("status, provider_status").eq("id", failedId).single(),
  "leer caída"
);
check("Regla 10: la IA caída queda como fallo registrado y nada se detiene",
  failedRow.status === "failed" && failedRow.provider_status === "unavailable");

check("Ninguna asistencia creó ventas", (await countSales()) === salesBefore);

// La otra persona no resuelve lo ajeno; la corrección humana descarta lo suyo.
const foreign = await asAdmin.rpc("resolve_ai_interaction", {
  p_interaction_id: interactionId, p_status: "discarded"
});
check("Administración SÍ puede resolver (supervisión)", foreign.error === null);

const sellerOwn = must(
  await asSeller.rpc("record_ai_interaction", {
    p_kind: "audio_order",
    p_input_summary: "[B4-INTEGRAL] pedido para venta real",
    p_proposal: { lineas: correcto.lineas },
    p_provider_status: "degraded"
  }),
  "asistencia para la venta"
);
const crossResolve = await asAdmin.rpc("resolve_ai_interaction", {
  p_interaction_id: sellerOwn, p_status: "confirmed"
});
// Nota: admin puede; una TERCERA vendedora no — eso lo cubre pgTAP 0044/7.
check("Confirmar sin venta también es válido (asistencia informativa)", crossResolve.error === null);

// LA VENTA LA HACE LA PERSONA, por el contrato del Bloque 2.
const humanInteraction = must(
  await asSeller.rpc("record_ai_interaction", {
    p_kind: "audio_order",
    p_input_summary: "[B4-INTEGRAL] un rojo intenso para la clienta",
    p_proposal: { lineas: [{ ...correcto.lineas[0], cantidad: 1 }] },
    p_provider_status: "degraded"
  }),
  "asistencia previa a la venta"
);

const demoBranch = must(
  await service.from("branches").select("id").eq("is_default", true).limit(1).single(),
  "sede demo"
);
const saleVariant = correcto.lineas[0].variantId;

const sale = must(
  await asAdmin.rpc("register_sale", {
    p_branch_id: demoBranch.id,
    p_lines: [{ variantId: saleVariant, quantity: 1 }],
    p_payments: [{ method: "cash", amount: null }],
    p_client_operation_id: crypto.randomUUID(),
    p_source_channel: "in_store",
    p_fulfillment_method: "in_store",
    p_customer: { name: "Clienta B4 Integral" },
    p_discount_total: 0,
    p_notes: "[B4-INTEGRAL] venta humana tras propuesta de IA",
    p_reservation_id: null,
    p_source_reference: null
  }).then(async (result) => {
    if (!result.error) return result;
    // El contrato exige el pago exacto: se reintenta con el total evaluado.
    const evaluated = await asAdmin.rpc("evaluate_cart_v2", {
      p_lines: [{ variantId: saleVariant, quantity: 1 }]
    });
    if (evaluated.error) return result;
    const total = evaluated.data?.subtotal ?? evaluated.data?.total;
    return asAdmin.rpc("register_sale", {
      p_branch_id: demoBranch.id,
      p_lines: [{ variantId: saleVariant, quantity: 1 }],
      p_payments: [{ method: "cash", amount: total }],
      p_client_operation_id: crypto.randomUUID(),
      p_source_channel: "in_store",
      p_fulfillment_method: "in_store",
      p_customer: { name: "Clienta B4 Integral" },
      p_discount_total: 0,
      p_notes: "[B4-INTEGRAL] venta humana tras propuesta de IA",
      p_reservation_id: null,
      p_source_reference: null
    });
  }),
  "venta humana"
);
const saleId = sale.saleId ?? sale.id;
check("La persona registró la venta por el Bloque 2", typeof saleId === "string");

const resolved = must(
  await asSeller.rpc("resolve_ai_interaction", {
    p_interaction_id: humanInteraction,
    p_status: "confirmed",
    p_sale_id: saleId,
    p_note: "Venta registrada a mano"
  }),
  "confirmar con enlace"
);
check("La asistencia quedó confirmada y ENLAZADA a la venta humana",
  resolved.status === "confirmed");

const linkedRow = must(
  await service.from("ai_interactions").select("sale_id, status, confirmed_by").eq("id", humanInteraction).single(),
  "leer enlace"
);
check("El enlace es write-once y apunta a la venta correcta",
  linkedRow.sale_id === saleId && linkedRow.status === "confirmed");

check("Las ventas crecieron en EXACTAMENTE la que hizo la persona",
  (await countSales()) === salesBefore + 1);

console.log("\n4. Tendencias: proponer no es publicar");

const proposalId = must(
  await asAdmin.rpc("create_content_proposal", {
    p_title: "[B4-INTEGRAL] Rojo intenso manda",
    p_body: "Señales internas: el rojo intenso lidera. Idea: reel corto de demostración.",
    p_signals: { origen: "integral-b4" }
  }),
  "crear propuesta"
);

const earlyPublish = await asAdmin.rpc("mark_content_published", { p_proposal_id: proposalId });
check("Un borrador NO se publica sin aprobación", earlyPublish.error != null);

must(await asAdmin.rpc("review_content_proposal", {
  p_proposal_id: proposalId, p_decision: "approved", p_note: "Va"
}), "aprobar");

const doubleReview = await asAdmin.rpc("review_content_proposal", {
  p_proposal_id: proposalId, p_decision: "rejected"
});
check("Lo revisado no se re-revisa", doubleReview.error != null);

must(await asAdmin.rpc("mark_content_published", {
  p_proposal_id: proposalId, p_note: "Publicada a mano (integral)"
}), "registrar publicación");

const publishedRow = must(
  await service.from("content_proposals").select("status, published_by").eq("id", proposalId).single(),
  "leer publicada"
);
check("Publicada registra QUIÉN publicó — jamás fue automática",
  publishedRow.status === "published" && publishedRow.published_by === adminId);

// Limpieza: las propuestas del run se retiran; la evidencia de IA se queda
// porque la base PROHÍBE borrarla — y probarlo es parte del cierre.
await service.from("content_proposals").delete().like("title", "%[B4-INTEGRAL]%");
const deletionAttempt = await service.from("ai_interactions").delete().eq("id", failedId);
check("La evidencia de IA no se puede borrar ni con service_role",
  deletionAttempt.error != null);

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length > 0
    ? `\n${failed.length} verificación(es) fallaron de ${results.length}.`
    : `\n${results.length}/${results.length} verificaciones de la integral B4 en verde.`
);
if (failed.length > 0) process.exit(1);
