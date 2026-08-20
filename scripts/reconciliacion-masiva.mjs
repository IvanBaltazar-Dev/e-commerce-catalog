/**
 * Fase 3 · Reconciliación masiva: catálogo comercial ↔ universo de referencia.
 *
 * Esta etapa NO copia nada. Su única salida es identidad:
 *
 *   ¿este producto Bellaroshé es este producto oficial?
 *   ¿esta variante Bellaroshé es este tono/presentación concreto?
 *
 * Y son dos preguntas, no una. Resolver solo la primera y repartir la foto, el
 * SKU o el precio de UNA variante entre las demás es el error que ya nos costó
 * caro con Masglo: 159 fotos de tono revueltas por emparejar a nivel de nombre.
 * La restricción de catalog_reconciliation_cases ya obliga a separarlas.
 *
 * Las señales van en ORDEN DE AUTORIDAD, no por puntuación genérica. Un
 * parecido de nombre nunca basta por sí solo:
 *
 *   A  código de proveedor histórico exacto
 *   B  SKU de fabricante exacto + marca
 *   C  identificador externo persistido + marca
 *   D  modelo/referencia exacta + marca
 *   E  nombre normalizado + marca + presentación exacta
 *   F  nombre + tono/variante + presentación + clase
 *   G  similitud textual, siempre acotada por marca Y clase
 *
 * La primera señal que resuelve gana y las demás no se evalúan: si el SKU de
 * fabricante coincide, que el nombre difiera es irrelevante —la tienda pudo
 * reescribirlo— y seguir puntuando solo añade ruido.
 *
 * Reproducible: la corrida se identifica por la huella de sus dos conjuntos de
 * entrada. Volver a correrla sin cambios no crea casos nuevos.
 *
 * Uso:
 *   node scripts/reconciliacion-masiva.mjs             (ensayo + informe)
 *   node scripts/reconciliacion-masiva.mjs --aplicar
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function todas(tabla, select, filtro = (q) => q, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await filtro(db.from(tabla).select(select)).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
const norm = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const clave = (s) => norm(s).replace(/\s+/g, "");

// ── El congelado ────────────────────────────────────────────────────────────
console.log("Congelando los dos lados…");

const productos = await todas(
  "products",
  "id, code, name, presentation, description, product_type, is_active, brand_id, categories(name), brands(name), product_lines(name)"
);
const variantes = await todas(
  "product_variants",
  "id, product_id, name, sku, sku_interno, sku_origen, barcode, is_active"
);
const enlacesProv = await todas("product_suppliers", "product_id, variant_id, supplier_sku");
const refProductos = await todas(
  "catalog_reference_products",
  "id, reference_key, brand_id, name, normalized_name, product_type, line, source_url, primary_image_url, primary_source_record_id, primary_external_id, enrichment_level, metadata"
);
const refVariantes = await todas(
  "catalog_reference_variants",
  "id, reference_product_id, reference_key, name, normalized_name, sku, barcode, shade_name, presentation, primary_source_record_id, primary_external_id, metadata"
);

const activos = productos.filter((p) => p.is_active);
const varActivas = variantes.filter((v) => v.is_active);

// La huella del congelado: si cambia cualquiera de los dos lados, es otra
// corrida. Si no cambia nada, volver a correr no debe producir un solo caso
// nuevo — esa es la prueba de que el proceso es reproducible y no acumulativo.
const huella = sha(JSON.stringify([
  activos.length, varActivas.length, refProductos.length, refVariantes.length,
  activos.map((p) => p.id).sort().join("").slice(0, 2048),
  refProductos.map((r) => r.reference_key).sort().join("").slice(0, 2048)
]));

console.log(`  comerciales: ${activos.length} productos · ${varActivas.length} variantes activas`);
console.log(`  referencia:  ${refProductos.length} productos · ${refVariantes.length} variantes`);
console.log(`  huella del congelado: ${huella}\n`);

// ── Índices del lado referencia ─────────────────────────────────────────────
const refProdPorId = new Map(refProductos.map((r) => [r.id, r]));
const refVarDe = new Map();
for (const rv of refVariantes) {
  if (!refVarDe.has(rv.reference_product_id)) refVarDe.set(rv.reference_product_id, []);
  refVarDe.get(rv.reference_product_id).push(rv);
}

const idx = {
  skuPorMarca: new Map(),      // marca::sku      → refVariante
  externoPorMarca: new Map(),  // marca::externo  → refProducto
  nombrePorMarca: new Map(),   // marca::nombre   → [refProducto]
  porMarca: new Map()          // marca           → [refProducto]
};
for (const rv of refVariantes) {
  const rp = refProdPorId.get(rv.reference_product_id);
  if (!rp || !rv.sku) continue;
  idx.skuPorMarca.set(`${rp.brand_id}::${clave(rv.sku)}`, rv);
}
for (const rp of refProductos) {
  idx.externoPorMarca.set(`${rp.brand_id}::${clave(rp.primary_external_id)}`, rp);
  const k = `${rp.brand_id}::${norm(rp.name)}`;
  if (!idx.nombrePorMarca.has(k)) idx.nombrePorMarca.set(k, []);
  idx.nombrePorMarca.get(k).push(rp);
  if (!idx.porMarca.has(rp.brand_id)) idx.porMarca.set(rp.brand_id, []);
  idx.porMarca.get(rp.brand_id).push(rp);
}

// Códigos de proveedor por producto comercial (señal A).
const provDe = new Map();
const productoDeVariante = new Map(variantes.map((v) => [v.id, v.product_id]));
for (const e of enlacesProv) {
  if (!e.supplier_sku) continue;
  const pid = e.product_id ?? productoDeVariante.get(e.variant_id);
  if (!pid) continue;
  if (!provDe.has(pid)) provDe.set(pid, new Set());
  provDe.get(pid).add(clave(e.supplier_sku));
}

// ── Vocabulario compartido con el resto del sistema ─────────────────────────
// La clase se lee del nombre igual que en auditar-coherencia-interna.mjs y en
// descargar-imagenes-oficiales.mjs. Tres lecturas distintas del mismo concepto
// serían tres formas de discrepar.
function claseDe(texto) {
  const n = norm(texto);
  if (/\bbrillo\b|^top coat|^matificador|^sellante/.test(n)) return "BRILLO";
  if (/^base\b|\bbase\b/.test(n)) return "BASE";
  if (/^lima|\blima\b|^pulidor|^buffer/.test(n)) return "LIMA";
  if (/^removedor|^limpiador|^cleanser|^dilusor/.test(n)) return "REMOVEDOR";
  if (/^pincel|^brocha/.test(n)) return "PINCEL";
  if (/^aceite|^crema|^serum/.test(n)) return "CUIDADO";
  if (/\bpolvo acrilico\b|\bmonomero\b|\bacrilico\b/.test(n)) return "ACRILICO";
  if (/\bdecoracion\b/.test(n)) return "DECORACION";
  if (/\besmalte\b/.test(n)) return "ESMALTE";
  return null;
}

const COLORES = new Set(["blanco","white","negro","black","rojo","red","rosa","rosado","pink","azul","blue",
  "verde","green","amarillo","yellow","naranja","orange","morado","purple","violeta","lila","nude","beige",
  "marron","brown","gris","grey","gray","dorado","gold","plata","silver","cobre","bronce","turquesa","coral",
  "fucsia","magenta","celeste","crema","transparente","clear","peach","almond","snow"]);
const coloresDe = (s) => new Set(norm(s).split(" ").filter((t) => COLORES.has(t)));

function contradiceColor(a, b) {
  const ca = coloresDe(a), cb = coloresDe(b);
  if (!ca.size || !cb.size) return false;
  for (const t of ca) if (cb.has(t)) return false;
  return true;
}
function contradiceClase(a, b) {
  const x = claseDe(a), y = claseDe(b);
  return Boolean(x && y && x !== y);
}

const vacias = new Set(["de","del","la","el","con","sin","para","por","ml","gr","oz","und","pza","x"]);
const fichas = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !vacias.has(w)));
function jaccard(a, b) {
  const A = fichas(a), B = fichas(b);
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const t of A) if (B.has(t)) comunes += 1;
  return comunes / (A.size + B.size - comunes);
}

// ── Reconciliación de PRODUCTO ──────────────────────────────────────────────
const casosProducto = [];
const resumenProducto = new Map();
const refDeProducto = new Map();

function anota(mapa, k) { mapa.set(k, (mapa.get(k) ?? 0) + 1); }

for (const p of activos) {
  const candidatosMarca = idx.porMarca.get(p.brand_id) ?? [];
  const vs = varActivas.filter((v) => v.product_id === p.id);
  let resultado = null;

  // A · código de proveedor histórico exacto
  const provs = provDe.get(p.id);
  if (provs) {
    for (const rv of refVariantes) {
      const rp = refProdPorId.get(rv.reference_product_id);
      if (!rp || rp.brand_id !== p.brand_id || !rv.sku) continue;
      if (provs.has(clave(rv.sku))) { resultado = { rp, señal: "A_CODIGO_PROVEEDOR", clase: "MATCH_EXACT", score: 1 }; break; }
    }
  }

  // B · SKU de fabricante exacto + marca
  if (!resultado) {
    for (const v of vs) {
      if (!v.sku) continue;
      const rv = idx.skuPorMarca.get(`${p.brand_id}::${clave(v.sku)}`);
      if (rv) {
        const rp = refProdPorId.get(rv.reference_product_id);
        if (rp) { resultado = { rp, señal: "B_SKU_FABRICANTE", clase: "MATCH_EXACT", score: 1 }; break; }
      }
    }
  }

  // C · identificador externo persistido + marca
  if (!resultado) {
    for (const v of vs) {
      const codigo = v.sku_interno ?? v.sku;
      if (!codigo) continue;
      const rp = idx.externoPorMarca.get(`${p.brand_id}::${clave(codigo)}`);
      if (rp) { resultado = { rp, señal: "C_EXTERNO_PERSISTIDO", clase: "MATCH_EXACT", score: 1 }; break; }
    }
  }

  // E · nombre normalizado + marca + presentación
  if (!resultado) {
    const mismos = idx.nombrePorMarca.get(`${p.brand_id}::${norm(p.name)}`) ?? [];
    if (mismos.length === 1) {
      resultado = { rp: mismos[0], señal: "E_NOMBRE_EXACTO_MARCA", clase: "MATCH_STRONG", score: 0.9 };
    } else if (mismos.length > 1) {
      resultado = { rp: mismos[0], señal: "E_NOMBRE_EXACTO_MARCA", clase: "MATCH_CANDIDATE", score: 0.6,
        nota: `${mismos.length} fichas oficiales con ese mismo nombre` };
    }
  }

  // G · similitud textual, acotada por marca Y clase
  if (!resultado && candidatosMarca.length) {
    const puntuados = candidatosMarca
      .map((rp) => ({ rp, s: jaccard(`${p.name} ${p.presentation ?? ""}`, rp.name) }))
      .filter((x) => x.s >= 0.5)
      .filter((x) => !contradiceClase(p.name, x.rp.name))
      .sort((a, b) => b.s - a.s);
    if (puntuados.length) {
      const mejor = puntuados[0];
      const empatan = puntuados.filter((x) => x.s === mejor.s).length;
      resultado = empatan === 1 && mejor.s >= 0.75
        ? { rp: mejor.rp, señal: "G_SIMILITUD_ACOTADA", clase: "MATCH_STRONG", score: Number(mejor.s.toFixed(5)) }
        : { rp: mejor.rp, señal: "G_SIMILITUD_ACOTADA", clase: "MATCH_CANDIDATE", score: Number(mejor.s.toFixed(5)),
            nota: empatan > 1 ? `${empatan} fichas empatan` : "parecido por debajo del umbral firme" };
    }
  }

  if (!resultado) {
    // «No lo encontré» y «no había dónde buscarlo» son cosas distintas, y
    // juntarlas en un solo UNRESOLVED del 92% haría creer que el emparejador
    // falla cuando lo que pasa es que esa marca no tiene universo rastreado.
    // Una cifra que mezcla las dos manda a arreglar lo que no está roto.
    anota(resumenProducto, candidatosMarca.length ? "UNRESOLVED" : "SIN_REFERENCIA_DE_MARCA");
    continue;
  }

  // La contradicción no descarta: se registra. Un producto cuyo nombre dice
  // «brillo» emparejado con una ficha que dice «esmalte» es información —quizá
  // nuestro nombre está mal— y esconderla repetiría el error de Ajo y Limón.
  if (contradiceClase(p.name, resultado.rp.name) || contradiceColor(`${p.name} ${p.presentation ?? ""}`, resultado.rp.name)) {
    resultado.clase = "CONTRADICTION";
    resultado.nota = `${resultado.nota ? resultado.nota + "; " : ""}la clase o el color no concuerdan`;
  }

  anota(resumenProducto, resultado.clase);
  refDeProducto.set(p.id, resultado);
  casosProducto.push({
    case_key: `recon:${huella.slice(0, 8)}:p:${p.id}`,
    entity_type: "product",
    product_id: p.id,
    reference_product_id: resultado.rp.id,
    source_record_id: resultado.rp.primary_source_record_id,
    algorithm: resultado.señal,
    score: resultado.score,
    status: resultado.clase === "MATCH_EXACT" || resultado.clase === "MATCH_STRONG" ? "proposed" : "needs_review",
    evidence: {
      clase: resultado.clase,
      nuestro: `${p.name} · ${p.presentation ?? ""}`.trim(),
      oficial: resultado.rp.name,
      marca: p.brands?.name ?? null,
      urlOficial: resultado.rp.source_url,
      nota: resultado.nota ?? null,
      huellaCongelado: huella
    }
  });
}

// ── Reconciliación de VARIANTE ──────────────────────────────────────────────
// Solo dentro del producto ya emparejado. Buscar variantes por todo el universo
// permitiría que el tono de un producto acabara apuntando a la ficha de otro.
const casosVariante = [];
const resumenVariante = new Map();
const refDeVariante = new Map();

const productoDe = new Map(productos.map((p) => [p.id, p]));

for (const v of varActivas) {
  const p = productoDe.get(v.product_id);
  let elegida = null;

  // B · SKU de fabricante exacto dentro de la marca, SIN exigir que el producto
  // padre haya emparejado.
  //
  // Los dos catálogos no tienen la misma forma. Nosotros guardamos «Esmalte
  // Masglo Tradicional» con 164 tonos dentro; masglo.com.es publica 292 fichas,
  // una por tono. Ningún parecido de nombre va a casar un producto de 164 con
  // uno de 1, así que exigir el padre dejaba fuera las 291 variantes cuyo SKU
  // coincide exactamente — y con ellas sus códigos de barras.
  //
  // El SKU es autoridad B: más alta que cualquier similitud textual de producto.
  // Supeditarlo a una señal más débil era invertir el orden que rige todo esto.
  if (v.sku && p) {
    const rv = idx.skuPorMarca.get(`${p.brand_id}::${clave(v.sku)}`);
    if (rv) elegida = { rv, señal: "B_SKU_FABRICANTE", clase: "MATCH_EXACT", score: 1 };
  }

  const m = refDeProducto.get(v.product_id);
  if (!elegida && !m) { anota(resumenVariante, "SIN_PRODUCTO_RECONCILIADO"); continue; }

  const hermanas = m ? (refVarDe.get(m.rp.id) ?? []) : [];
  if (!elegida && !hermanas.length) { anota(resumenVariante, "UNRESOLVED"); continue; }

  // Producto de una sola variante en ambos lados: la correspondencia es la
  // única posible, y no hace falta que los nombres se parezcan.
  if (!elegida && hermanas.length === 1 && varActivas.filter((x) => x.product_id === v.product_id).length === 1) {
    elegida = { rv: hermanas[0], señal: "UNICA_EN_AMBOS", clase: "MATCH_STRONG", score: 0.9 };
  }

  // F · tono/presentación exactos
  if (!elegida) {
    const mios = norm(v.name);
    const exactas = hermanas.filter(
      (rv) => norm(rv.shade_name ?? "") === mios || norm(rv.name) === mios || norm(rv.presentation ?? "") === mios
    );
    if (exactas.length === 1) elegida = { rv: exactas[0], señal: "F_TONO_PRESENTACION", clase: "MATCH_STRONG", score: 0.9 };
    else if (exactas.length > 1) elegida = { rv: exactas[0], señal: "F_TONO_PRESENTACION", clase: "MATCH_CANDIDATE", score: 0.6, nota: `${exactas.length} variantes oficiales con ese nombre` };
  }

  // G · similitud dentro del producto
  if (!elegida) {
    const puntuadas = hermanas
      .map((rv) => ({ rv, s: Math.max(jaccard(v.name, rv.shade_name ?? ""), jaccard(v.name, rv.name)) }))
      .filter((x) => x.s >= 0.5)
      .sort((a, b) => b.s - a.s);
    if (puntuadas.length) {
      const mejor = puntuadas[0];
      const empatan = puntuadas.filter((x) => x.s === mejor.s).length;
      elegida = empatan === 1 && mejor.s >= 0.75
        ? { rv: mejor.rv, señal: "G_SIMILITUD_EN_PRODUCTO", clase: "MATCH_STRONG", score: Number(mejor.s.toFixed(5)) }
        : { rv: mejor.rv, señal: "G_SIMILITUD_EN_PRODUCTO", clase: "MATCH_CANDIDATE", score: Number(mejor.s.toFixed(5)), nota: empatan > 1 ? `${empatan} empatan` : "por debajo del umbral firme" };
    }
  }

  if (!elegida) { anota(resumenVariante, "UNRESOLVED"); continue; }

  if (contradiceColor(v.name, elegida.rv.shade_name ?? elegida.rv.name)) {
    elegida.clase = "CONTRADICTION";
    elegida.nota = `${elegida.nota ? elegida.nota + "; " : ""}el color no concuerda`;
  }

  anota(resumenVariante, elegida.clase);
  refDeVariante.set(v.id, elegida);
  casosVariante.push({
    case_key: `recon:${huella.slice(0, 8)}:v:${v.id}`,
    entity_type: "variant",
    variant_id: v.id,
    reference_variant_id: elegida.rv.id,
    source_record_id: elegida.rv.primary_source_record_id,
    algorithm: elegida.señal,
    score: elegida.score,
    status: elegida.clase === "MATCH_EXACT" || elegida.clase === "MATCH_STRONG" ? "proposed" : "needs_review",
    evidence: {
      clase: elegida.clase,
      nuestro: v.name,
      oficial: elegida.rv.shade_name ?? elegida.rv.name,
      skuOficial: elegida.rv.sku ?? null,
      nota: elegida.nota ?? null,
      huellaCongelado: huella
    }
  });
}

// ── Cobertura: qué desbloquea cada emparejamiento ───────────────────────────
// No se copia nada. Solo se dice qué HAY disponible al otro lado del vínculo,
// para poder decidir con números en vez de con intuición.
const conFoto = new Set();
for (const m of await todas("product_media", "product_id, variant_id")) {
  const pid = m.product_id ?? productoDeVariante.get(m.variant_id);
  if (pid) conFoto.add(pid);
}

const cobertura = { identidad: 0, sku: 0, descripcion: 0, precio: 0, imagen: 0, presentacion: 0, barcode: 0 };
const fotoNuevaPosible = [];

for (const [pid, m] of refDeProducto) {
  if (m.clase === "CONTRADICTION") continue;
  cobertura.identidad += 1;
  const rvs = refVarDe.get(m.rp.id) ?? [];
  if (rvs.some((rv) => rv.sku)) cobertura.sku += 1;
  if ((m.rp.metadata?.descripcion ?? "").trim().length > 30) cobertura.descripcion += 1;
  if (rvs.some((rv) => rv.metadata?.precioObservado != null)) cobertura.precio += 1;
  if (m.rp.primary_image_url) {
    cobertura.imagen += 1;
    if (!conFoto.has(pid)) fotoNuevaPosible.push({ pid, url: m.rp.primary_image_url, oficial: m.rp.name });
  }
  if (rvs.some((rv) => rv.presentation)) cobertura.presentacion += 1;
  if (rvs.some((rv) => rv.barcode)) cobertura.barcode += 1;
}

// ── Informe ─────────────────────────────────────────────────────────────────
const orden = ["MATCH_EXACT", "MATCH_STRONG", "MATCH_CANDIDATE", "CONTRADICTION", "UNRESOLVED", "SIN_REFERENCIA_DE_MARCA", "SIN_PRODUCTO_RECONCILIADO"];
const pinta = (mapa, total, excluir = []) => orden
  .filter((k) => mapa.has(k) && !excluir.includes(k))
  .map((k) => `   ${String(mapa.get(k)).padStart(5)}  ${String(Math.round(mapa.get(k) / total * 100)).padStart(3)}%  ${k}`)
  .join("\n");

const sinUniverso = resumenProducto.get("SIN_REFERENCIA_DE_MARCA") ?? 0;
const conUniverso = activos.length - sinUniverso;
console.log(`PRODUCTOS · ${activos.length} activos`);
console.log(`   ${sinUniverso} son de marcas sin universo rastreado — no hay dónde buscarlos.`);
console.log(`   ${conUniverso} sí tienen universo. Sobre esos:\n`);
console.log(pinta(resumenProducto, conUniverso, ["SIN_REFERENCIA_DE_MARCA"]));
const varSinPadre = resumenVariante.get("SIN_PRODUCTO_RECONCILIADO") ?? 0;
const varConPadre = varActivas.length - varSinPadre;
console.log(`\nVARIANTES · ${varActivas.length} activas`);
console.log(`   ${varSinPadre} sin SKU que case y sin producto reconciliado — no hay por dónde.`);
console.log(`   ${varConPadre} sí. Sobre esas:\n`);
console.log(pinta(resumenVariante, varConPadre, ["SIN_PRODUCTO_RECONCILIADO"]));

const confirmados = (resumenProducto.get("MATCH_EXACT") ?? 0) + (resumenProducto.get("MATCH_STRONG") ?? 0);
console.log(`\nCOBERTURA que abre la identidad (${cobertura.identidad} productos emparejados, contradicciones fuera)`);
for (const [k, v] of Object.entries(cobertura)) {
  if (k === "identidad") continue;
  console.log(`   ${String(v).padStart(5)}  ${String(Math.round(v / Math.max(1, cobertura.identidad) * 100)).padStart(3)}%  ${k}`);
}
// El código de barras y el SKU viven en la VARIANTE, no en el producto: medirlos
// a nivel de producto los infravalora —un esmalte con 164 tonos cuenta como
// uno— y esconde justo la cifra que decide si hace falta ir a la estantería.
const covVar = { identidad: 0, sku: 0, barcode: 0, precio: 0, presentacion: 0 };
const adoptables = { sku: 0, barcode: 0 };
for (const [vid, e] of refDeVariante) {
  if (e.clase === "CONTRADICTION") continue;
  const v = varActivas.find((x) => x.id === vid);
  covVar.identidad += 1;
  if (e.rv.sku) { covVar.sku += 1; if (v && v.sku_origen !== "OFICIAL_MARCA") adoptables.sku += 1; }
  if (e.rv.barcode) { covVar.barcode += 1; if (v && !v.barcode) adoptables.barcode += 1; }
  if (e.rv.metadata?.precioObservado != null) covVar.precio += 1;
  if (e.rv.presentation) covVar.presentacion += 1;
}
console.log(`\nCOBERTURA por VARIANTE (${covVar.identidad} variantes con identidad)`);
for (const [k, n] of Object.entries(covVar)) {
  if (k === "identidad") continue;
  console.log(`   ${String(n).padStart(5)}  ${String(Math.round(n / Math.max(1, covVar.identidad) * 100)).padStart(3)}%  ${k}`);
}
console.log(`\n   ADOPTABLE sin tocar un envase:`);
console.log(`     ${adoptables.barcode} códigos de barras que hoy no tenemos`);
console.log(`     ${adoptables.sku} SKU de fabricante que hoy son correlativo interno`);

console.log(`\n   ${fotoNuevaPosible.length} productos SIN foto nuestra tienen imagen oficial localizada`);
console.log(`   (evidencia remota, no imagen publicable: falta descargar, validar derechos y correspondencia)`);

console.log(`\nSeñales que resolvieron:`);
const porSeñal = new Map();
for (const c of [...casosProducto, ...casosVariante]) anota(porSeñal, `${c.entity_type}·${c.algorithm}`);
for (const [s, n] of [...porSeñal].sort((a, b) => b[1] - a[1])) console.log(`   ${String(n).padStart(5)}  ${s}`);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(
  path.join(ROOT, "outputs", "reconciliacion-masiva.json"),
  JSON.stringify({
    huella,
    entrada: { productos: activos.length, variantes: varActivas.length, refProductos: refProductos.length, refVariantes: refVariantes.length },
    resumenProducto: Object.fromEntries(resumenProducto),
    resumenVariante: Object.fromEntries(resumenVariante),
    cobertura,
    fotoNuevaPosible: fotoNuevaPosible.length,
    contradicciones: [...casosProducto, ...casosVariante].filter((c) => c.evidence.clase === "CONTRADICTION").map((c) => c.evidence)
  }, null, 2),
  "utf8"
);
console.log(`\n→ outputs/reconciliacion-masiva.json`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada escrito. Añade --aplicar para registrar ${casosProducto.length + casosVariante.length} casos.`);
  process.exit(0);
}

const { data: corrida, error: errCorrida } = await db
  .from("catalog_research_runs")
  .upsert({
    run_key: `reconciliacion-masiva-${huella.slice(0, 12)}`,
    run_kind: "baseline",
    actor_kind: "system",
    actor_label: "reconciliacion-masiva.mjs",
    status: "running",
    // Reabrir una corrida ya cerrada exige limpiar la fecha de fin: la
    // restricción prohíbe «en curso» con finished_at puesto, y sin esto el
    // segundo intento revienta después de haber escrito todos los casos.
    finished_at: null,
    result_fingerprint: null,
    input_fingerprint: huella,
    scope: { productos: activos.length, referencias: refProductos.length },
    metrics: { casosProducto: casosProducto.length, casosVariante: casosVariante.length }
  }, { onConflict: "run_key" })
  .select("id").single();
if (errCorrida) throw new Error(`catalog_research_runs: ${errCorrida.message}`);

const casos = [...casosProducto, ...casosVariante].map((c) => ({ ...c, research_run_id: corrida.id }));
for (let i = 0; i < casos.length; i += 300) {
  const lote = casos.slice(i, i + 300);
  const { error } = await db.from("catalog_reconciliation_cases").upsert(lote, { onConflict: "case_key" });
  if (error) throw new Error(`catalog_reconciliation_cases: ${error.message}`);
  console.log(`   casos: ${Math.min(i + 300, casos.length)}/${casos.length}`);
}

await db.from("catalog_research_runs").update({
  status: "succeeded", finished_at: new Date().toISOString(), result_fingerprint: huella,
  result: { resumenProducto: Object.fromEntries(resumenProducto), resumenVariante: Object.fromEntries(resumenVariante), cobertura }
}).eq("id", corrida.id);

console.log(`\nCasos registrados. Corrida ${corrida.id}`);
console.log(`Nada canonizado: todo queda como «proposed» o «needs_review».`);
