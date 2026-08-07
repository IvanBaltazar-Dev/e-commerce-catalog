/**
 * Prueba unitaria del corazón determinista de la asistencia (regla 10): el
 * intérprete de pedidos debe funcionar entero SIN proveedor de IA. Corre el
 * módulo puro contra un catálogo de fixture y verifica los tres destinos del
 * plan de pruebas: pedido claro, pedido ambiguo y producto inexistente.
 *
 * matching.ts no tiene imports: Node lo carga directo quitando los tipos.
 */
import {
  segmentOrder,
  interpretOrderText,
  matchCandidates
} from "../src/lib/ai/matching.ts";

const CATALOG = [
  {
    variantId: "v-rojo-cereza", productId: "p-esmalte", sku: "MAS-ROJ-01",
    productName: "Esmalte Masglo Clásico", variantName: "Rojo Cereza",
    shadeName: "Rojo Cereza", brandName: "Masglo", categoryName: "Esmaltes", available: true
  },
  {
    variantId: "v-rojo-pasion", productId: "p-esmalte", sku: "MAS-ROJ-02",
    productName: "Esmalte Masglo Clásico", variantName: "Rojo Pasión",
    shadeName: "Rojo Pasión", brandName: "Masglo", categoryName: "Esmaltes", available: true
  },
  {
    variantId: "v-kit-gel", productId: "p-kit", sku: "KIT-GEL-01",
    productName: "Kit Gel Semipermanente Principiante", variantName: "Único",
    shadeName: null, brandName: "Cherimoya", categoryName: "Kits", available: true
  },
  {
    variantId: "v-nude", productId: "p-esmalte-2", sku: "ADM-NUD-01",
    productName: "Esmalte Admiss", variantName: "Nude Rosado",
    shadeName: "Nude Rosado", brandName: "Admiss", categoryName: "Esmaltes", available: true
  },
  {
    variantId: "v-pestanas", productId: "p-pest", sku: "GLM-PES-01",
    productName: "Pestañas Postizas Glam Nails", variantName: "Natural 10mm",
    shadeName: null, brandName: "Glam Nails", categoryName: "Pestañas", available: true
  }
];

const results = [];
function check(name, condition, extra = "") {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "✓" : "✗"} ${name}${condition || !extra ? "" : ` — ${extra}`}`);
}

// --- Segmentación en español ------------------------------------------------
const seg = segmentOrder("dos esmaltes rojo cereza y un kit de gel, 3 pestañas naturales");
check("Segmenta tres ítems", seg.length === 3, JSON.stringify(seg));
check("Lee cantidades en palabra y en cifra",
  seg[0]?.cantidad === 2 && seg[1]?.cantidad === 1 && seg[2]?.cantidad === 3);

// --- Pedido claro -----------------------------------------------------------
const clear = interpretOrderText("dos rojo cereza de masglo y un kit gel principiante", CATALOG);
check("Pedido claro: dos líneas directas, sin ambigüedad",
  clear.lineas.length === 2 && clear.ambiguedades.length === 0,
  JSON.stringify(clear));
check("La primera línea es el tono correcto con su cantidad",
  clear.lineas[0]?.variantId === "v-rojo-cereza" && clear.lineas[0]?.cantidad === 2);
check("La segunda es el kit",
  clear.lineas.some((l) => l.variantId === "v-kit-gel" && l.cantidad === 1));

// --- Pedido ambiguo ---------------------------------------------------------
const ambiguous = interpretOrderText("un esmalte rojo de masglo", CATALOG);
check("Pedido ambiguo: dos rojos plausibles → se declara, no se adivina",
  ambiguous.ambiguedades.length === 1 && ambiguous.lineas.length === 0,
  JSON.stringify(ambiguous));
check("La ambigüedad ofrece ambos tonos rojos",
  ambiguous.ambiguedades[0]?.opciones.some((o) => o.variantId === "v-rojo-cereza") &&
  ambiguous.ambiguedades[0]?.opciones.some((o) => o.variantId === "v-rojo-pasion"));

// --- Producto inexistente ---------------------------------------------------
const missing = interpretOrderText("una plancha de cabello profesional", CATALOG);
check("Producto inexistente: va a noEncontrado, jamás se inventa",
  missing.noEncontrado.length === 1 && missing.lineas.length === 0 && missing.ambiguedades.length === 0,
  JSON.stringify(missing));

// --- SKU directo ------------------------------------------------------------
const bySku = matchCandidates("MAS-ROJ-02", CATALOG);
check("El SKU exacto gana siempre", bySku[0]?.entry.variantId === "v-rojo-pasion" && bySku[0]?.score === 100);

// --- Acumulación ------------------------------------------------------------
const accumulated = interpretOrderText("un kit gel principiante y dos kit gel principiante", CATALOG);
check("El mismo producto dictado dos veces acumula cantidad",
  accumulated.lineas.length === 1 && accumulated.lineas[0]?.cantidad === 3);

// --- Mezcla completa --------------------------------------------------------
const mixed = interpretOrderText(
  "quiero dos nude rosado de admiss, un esmalte rojo y una crema que no vendo", CATALOG);
check("La mezcla reparte bien: 1 línea, 1 ambigüedad y 1 no encontrado",
  mixed.lineas.length === 1 && mixed.ambiguedades.length === 1 && mixed.noEncontrado.length === 1,
  JSON.stringify(mixed));

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} caso(s) fallaron.`);
  process.exit(1);
}
console.log(`\n${results.length}/${results.length} casos del intérprete determinista en verde.`);
