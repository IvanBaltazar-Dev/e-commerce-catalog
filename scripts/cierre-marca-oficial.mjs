/**
 * Cierra una campaña de marca oficial demostrando qué pasó con CADA URL.
 *
 * Las seis campañas de marca descubren por /products.json paginado. Eso captura
 * mucho y muy rápido, pero no tiene con qué contrastarse: si la paginación
 * devuelve de menos, el resultado sigue pareciendo un éxito. Es exactamente el
 * fallo del catálogo de BELLESPA, donde el buscador declaraba 649 y el sitemap
 * 2.583, y durante meses se dio por bueno el 25%.
 *
 * Aquí el testigo externo es el sitemap de cada tienda, y de entrada ya
 * desmiente cuatro de las seis capturas:
 *
 *   mc-nails-mx   sitemap 1.034 · capturado   948   faltan 86
 *   masglo-es     sitemap   303 · capturado   292   faltan 11
 *   cherimoya-pe  sitemap 1.396 · capturado 1.395   falta   1
 *   acrylove      sitemap   512 · capturado   513   SOBRA   1
 *
 * El «sobra 1» importa tanto como los que faltan: hay un producto vivo en la API
 * que la tienda no publica en su sitemap. No es un error, es un producto oculto
 * —y saberlo es distinto de no haberlo mirado.
 *
 * Por eso el conjunto descubierto es la UNIÓN de los dos canales. Un producto
 * descubierto por cualquiera de ellos está descubierto, y debe salir con
 * desenlace: capturado, ausencia válida, error permanente o pendiente.
 *
 *   node --experimental-transform-types scripts/cierre-marca-oficial.mjs <source-key> [--aplicar]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const CLAVE = process.argv.slice(2).find((a) => !a.startsWith("--"));
if (!CLAVE) { console.error("Uso: cierre-marca-oficial.mjs <source-key> [--aplicar]"); process.exit(1); }

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36";
const PAUSA_MS = 700;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
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

async function traer(url, comoJson = false) {
  const esperas = [2000, 6000];
  let ultimoEstado = null, ultimoError = null, intentos = 0;
  for (let i = 0; i < esperas.length + 1; i += 1) {
    intentos += 1;
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
      ultimoEstado = r.status;
      if (r.ok) {
        const cuerpo = await r.text();
        if (!comoJson) return { outcome: "CAPTURED", cuerpo, status: r.status, intentos };
        try { return { outcome: "CAPTURED", json: JSON.parse(cuerpo), status: r.status, intentos }; }
        catch {
          // 200 con cuerpo que no es JSON: la ruta existe pero no es una ficha.
          return { outcome: "PERMANENT_ERROR", status: r.status, intentos, errorClass: "JSON_INVALIDO" };
        }
      }
      if (r.status === 404 || r.status === 410) return { outcome: "VALID_ABSENCE", status: r.status, intentos };
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        return { outcome: "PERMANENT_ERROR", status: r.status, intentos, errorClass: `HTTP_${r.status}` };
      }
    } catch (e) { ultimoError = String(e?.name || e).slice(0, 120); }
    if (i < esperas.length) await espera(esperas[i]);
  }
  return {
    outcome: "TEMPORARY_ERROR_PENDING", status: ultimoEstado, intentos,
    errorClass: ultimoEstado ? `HTTP_${ultimoEstado}` : (ultimoError ? `RED_${ultimoError}` : "SIN_RESPUESTA"),
    errorDetail: ultimoError
  };
}

// ── La fuente ────────────────────────────────────────────────────────────────
const { data: fuente, error: eF } = await db.from("catalog_sources")
  .select("id, source_key, base_url, metadata").eq("source_key", CLAVE).single();
if (eF) throw new Error(`fuente ${CLAVE}: ${eF.message}`);
const base = fuente.base_url.replace(/\/$/, "");

// ── Canal 1 · el sitemap, que es el testigo externo ──────────────────────────
console.log(`${CLAVE}\n  leyendo el sitemap…`);
const raiz = await traer(`${base}/sitemap.xml`);
const urlsSitemap = new Set();
if (raiz.outcome === "CAPTURED") {
  const hijos = [...raiz.cuerpo.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const deProducto = hijos.filter((u) => /product/i.test(u) && /\.xml/i.test(u));
  const recolectar = (xml) => {
    for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/g)) {
      const u = m[1].split("?")[0];
      if (/\/products\/|\/producto\//.test(u)) urlsSitemap.add(u);
    }
  };
  if (deProducto.length) {
    for (const h of deProducto) {
      await espera(PAUSA_MS);
      const x = await traer(h);
      if (x.outcome === "CAPTURED") recolectar(x.cuerpo);
    }
  } else recolectar(raiz.cuerpo);
}
console.log(`  sitemap: ${urlsSitemap.size} URLs de producto`);

// ── Canal 2 · lo que ya está capturado ───────────────────────────────────────
const registros = await todas(
  "catalog_source_records", "id, snapshot_id, entity_type, external_id, source_url, title",
  (q) => q.eq("source_id", fuente.id).eq("entity_type", "product")
);
const porUrl = new Map();
for (const r of registros) if (r.source_url) porUrl.set(r.source_url.split("?")[0], r);
console.log(`  capturado: ${registros.length} productos (${porUrl.size} con URL)`);

const snapshotId = registros[0]?.snapshot_id;
if (!snapshotId) { console.error("  la fuente no tiene snapshot: hay que capturarla antes de cerrarla."); process.exit(1); }

// ── El conjunto descubierto es la unión ──────────────────────────────────────
const descubiertas = new Set([...urlsSitemap, ...porUrl.keys()]);
const soloSitemap = [...urlsSitemap].filter((u) => !porUrl.has(u));
const soloApi = [...porUrl.keys()].filter((u) => !urlsSitemap.has(u));
console.log(`  descubiertas (unión): ${descubiertas.size}`);
console.log(`     en sitemap sin capturar: ${soloSitemap.length}`);
console.log(`     capturadas fuera del sitemap: ${soloApi.length}  (productos ocultos o retirados del índice)`);

// ── Lo ya capturado entra al libro tal cual ──────────────────────────────────
const libro = new Map();
for (const [u, r] of porUrl) {
  libro.set(u, {
    url: u, url_sha256: sha(u), outcome: "CAPTURED", attempts: 1,
    artifact_sha256: sha(u), artifact_bytes: null, http_status: 200,
    metadata: {
      canal: urlsSitemap.has(u) ? "products_json+sitemap" : "solo_products_json",
      record_id: r.id, external_id: r.external_id,
      // Un producto que la API sirve y el sitemap no publica no es un error de
      // captura: es un producto que la tienda no indexa. Merece constar.
      ...(urlsSitemap.has(u) ? {} : { nota: "vivo en la API, ausente del sitemap" })
    }
  });
}

// ── Y lo que falta se persigue una por una ───────────────────────────────────
const nuevos = [];
if (soloSitemap.length) {
  console.log(`\n  persiguiendo ${soloSitemap.length} URLs no capturadas…`);
  let hechas = 0;
  for (const u of soloSitemap) {
    // Shopify sirve la ficha completa en {url}.json. Es la misma forma que trae
    // products.json, así que lo capturado por aquí es indistinguible.
    const res = await traer(`${u}.json`, true);
    hechas += 1;
    if (hechas % 25 === 0) console.log(`     ${hechas}/${soloSitemap.length}`);
    if (res.outcome === "CAPTURED" && res.json?.product) {
      const p = res.json.product;
      nuevos.push({ url: u, producto: p });
      libro.set(u, {
        url: u, url_sha256: sha(u), outcome: "CAPTURED", attempts: res.intentos,
        http_status: res.status, artifact_sha256: sha(u), artifact_bytes: null,
        metadata: { canal: "ficha_individual", motivo: "faltaba en products.json", external_id: `p:${p.id}` }
      });
    } else if (res.outcome === "CAPTURED") {
      libro.set(u, {
        url: u, url_sha256: sha(u), outcome: "PERMANENT_ERROR", attempts: res.intentos,
        http_status: res.status, error_class: "SIN_PRODUCTO_EN_JSON",
        error_detail: "respondió 200 pero el JSON no trae product"
      });
    } else {
      libro.set(u, {
        url: u, url_sha256: sha(u), outcome: res.outcome, attempts: res.intentos,
        http_status: res.status ?? null, error_class: res.errorClass ?? null,
        error_detail: res.errorDetail ?? null
      });
    }
    await espera(PAUSA_MS);
  }
}

// ── Resumen ──────────────────────────────────────────────────────────────────
const cuenta = {};
for (const l of libro.values()) cuenta[l.outcome] = (cuenta[l.outcome] ?? 0) + 1;
console.log(`\n  desenlaces:`);
for (const [k, v] of Object.entries(cuenta).sort((a, b) => b[1] - a[1])) console.log(`     ${String(v).padStart(5)}  ${k}`);
const sinDesenlace = [...descubiertas].filter((u) => !libro.has(u));
if (sinDesenlace.length) { console.error(`  ${sinDesenlace.length} descubiertas sin desenlace — fallo del cierre`); process.exit(3); }
console.log(`  productos nuevos recuperados: ${nuevos.length}`);

if (!APLICAR) { console.log(`\nEnsayo. Nada escrito. Añade --aplicar.`); process.exit(0); }

// ── Persistir los productos recuperados ──────────────────────────────────────
// Van al mismo snapshot: son parte de la misma captura, solo que llegaron por
// otra puerta. Partirlos en dos snapshots haría que ninguno de los dos cuadrase.
if (nuevos.length) {
  const filas = nuevos.map(({ url, producto }) => ({
    snapshot_id: snapshotId, source_id: fuente.id, entity_type: "product",
    external_id: `p:${producto.id}`, title: producto.title ?? null,
    sku: producto.variants?.[0]?.sku || null,
    barcode: producto.variants?.[0]?.barcode || null,
    source_url: url,
    primary_image_url: producto.image?.src ?? producto.images?.[0]?.src ?? null,
    captured_at: new Date().toISOString(),
    payload: {
      title: producto.title, handle: producto.handle, vendor: producto.vendor,
      product_type: producto.product_type, tags: Array.isArray(producto.tags) ? producto.tags.join(" | ") : producto.tags,
      description: producto.body_html, published_at: producto.published_at, updated_at: producto.updated_at,
      variant_count: producto.variants?.length ?? 0, image_count: producto.images?.length ?? 0,
      source_product_url: url, source_root_url: base, external_product_id: String(producto.id),
      source_type: "ficha_individual",
      // Cómo llegó aquí, para que nadie tenga que deducirlo después.
      recuperado_por: "cierre-marca-oficial: estaba en el sitemap y no en products.json"
    }
  }));
  for (let i = 0; i < filas.length; i += 200) {
    const { error } = await db.from("catalog_source_records").upsert(filas.slice(i, i + 200), { onConflict: "snapshot_id,entity_type,external_id" });
    if (error) throw new Error(`catalog_source_records: ${error.message}`);
  }
  console.log(`\n  ${filas.length} productos recuperados escritos`);
}

// ── Persistir el libro y auditar ─────────────────────────────────────────────
const filasLibro = [...libro.values()].map((l) => ({
  snapshot_id: snapshotId, source_id: fuente.id,
  url: l.url, url_sha256: l.url_sha256, outcome: l.outcome,
  http_status: l.http_status ?? null, error_class: l.error_class ?? null,
  error_detail: l.error_detail ?? null, attempts: l.attempts ?? 1,
  first_attempt_at: new Date().toISOString(), last_attempt_at: new Date().toISOString(),
  artifact_sha256: l.artifact_sha256 ?? null, artifact_bytes: l.artifact_bytes ?? null,
  metadata: l.metadata ?? {}
}));
for (let i = 0; i < filasLibro.length; i += 400) {
  const { error } = await db.from("capture_url_ledger")
    .upsert(filasLibro.slice(i, i + 400), { onConflict: "snapshot_id,url_sha256" });
  if (error) throw new Error(`capture_url_ledger: ${error.message}`);
}

// El total declarado por la fuente es el del sitemap: es lo que la tienda dice
// publicar. Se guarda para que la auditoría pueda contrastarlo, pero contando la
// unión, porque los productos que solo sirve la API también existen.
await db.from("catalog_source_snapshots").update({
  metadata: {
    ...(await db.from("catalog_source_snapshots").select("metadata").eq("id", snapshotId).single()).data?.metadata,
    declared_total: descubiertas.size,
    sitemap_total: urlsSitemap.size,
    solo_en_api: soloApi.length,
    solo_en_sitemap: soloSitemap.length,
    cierre_por: "cierre-marca-oficial"
  }
}).eq("id", snapshotId);

const { data: auditoria, error: eA } = await db
  .from("capture_closure_audit_v1").select("*").eq("snapshot_id", snapshotId).single();
if (eA) throw new Error(`auditoría: ${eA.message}`);

console.log(`\n  descubiertas ${auditoria.descubiertas} = intentadas ${auditoria.intentadas}`);
console.log(`  capturadas ${auditoria.capturadas} + ausencias ${auditoria.ausencias} + permanentes ${auditoria.permanentes} + pendientes ${auditoria.pendientes}`);
console.log(`  colisiones de artefacto: ${auditoria.colisiones_de_artefacto}`);
console.log(`  CIERRE: ${auditoria.puede_declararse_completa ? "COMPLETE" : "INCOMPLETE_CAPTURE"} — ${auditoria.motivo}`);
if (!auditoria.puede_declararse_completa) process.exit(1);
