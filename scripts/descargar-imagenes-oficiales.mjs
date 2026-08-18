/**
 * Descarga la imagen oficial de cada variante, emparejando por SKU.
 *
 * El descargador anterior (research/catalog-master/download-verified-tone-images.mjs)
 * empareja por nombre de tono. Eso es exactamente lo que falló: Masglo vende
 * «Campeona» en Tradicional, Gel Evolution y Gel Polish, con tres envases y
 * tres precios. Emparejar por nombre elige uno de los tres al azar.
 *
 * Aquí el emparejamiento va por niveles, del más firme al más débil, y cada
 * imagen queda anotada con el nivel por el que entró:
 *
 *   SKU_OFICIAL   el SKU nuestro es el SKU del fabricante. Sin ambigüedad.
 *   NOMBRE_EN_LINEA   el SKU es correlativo nuestro, pero SABEMOS la línea del
 *                     producto (0134 la fijó), así que el nombre del tono ya
 *                     solo puede referirse a un producto oficial. La ambigüedad
 *                     que hacía inservible el nombre era la línea; resuelta la
 *                     línea, el nombre vuelve a servir.
 *
 * Lo que no entra por ninguno de los dos no se descarga ni se adivina: se
 * enumera. Preferir SKU y caer a lo interno solo si no hay otra es la regla.
 *
 * Uso:
 *   node scripts/descargar-imagenes-oficiales.mjs            (ensayo, no baja nada)
 *   node scripts/descargar-imagenes-oficiales.mjs --aplicar  (descarga y registra)
 */
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "research", "catalog-master", "data");
const APLICAR = process.argv.includes("--aplicar");
const BUCKET = "catalog-assets";
const PREFIJO = "oficial-1";

const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function parseCsv(texto) {
  const filas = [];
  let campo = "", fila = [], comillas = false;
  for (let i = 0; i < texto.length; i += 1) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') { if (texto[i + 1] === '"') { campo += '"'; i += 1; } else comillas = false; }
      else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ",") { fila.push(campo); campo = ""; }
    else if (c === "\n") { fila.push(campo); filas.push(fila); fila = []; campo = ""; }
    else if (c !== "\r") campo += c;
  }
  if (campo !== "" || fila.length) { fila.push(campo); filas.push(fila); }
  const [cab, ...resto] = filas;
  return resto.filter((f) => f.length === cab.length).map((f) => Object.fromEntries(cab.map((k, i) => [k, f[i]])));
}
const leer = (n) => parseCsv(readFileSync(path.join(DATA, n), "utf8"));

const oficialesProd = leer("external_official_products.csv");
const oficialesVar = leer("external_official_variants.csv");
const oficialesImg = leer("external_official_images.csv");

const prodPorId = new Map(oficialesProd.map((p) => [p.external_product_id, p]));
const imgsPorProd = new Map();
for (const im of oficialesImg) {
  if (!imgsPorProd.has(im.external_product_id)) imgsPorProd.set(im.external_product_id, []);
  imgsPorProd.get(im.external_product_id).push({ url: im.image_url, pos: Number(im.image_position) || 99 });
}
for (const [, lista] of imgsPorProd) lista.sort((a, b) => a.pos - b.pos);

const norm = (s) =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function lineaMasglo(p) {
  const t = (p.tags ?? "").split("|").map((x) => x.trim().toUpperCase());
  if (t.includes("GEL POLISH") || t.includes("MASGLO PROFESSIONAL")) return "Gel Polish";
  if (t.includes("GEL EVOLUTION") || t.includes("BASE GEL EVOLUTION")) return "Gel Evolution";
  if (t.includes("MASGLO ADVANCED")) return "Advanced";
  if (t.includes("TRADICIONAL") || t.includes("ESMALTE TRADICIONAL") || t.includes("BASE TRADICIONAL")) return "Tradicional";
  return null;
}
function lineaAdmiss(p) {
  const t = (p.tags ?? "").split("|").map((x) => x.trim().toUpperCase());
  if (t.includes("BASES")) return "Bases";
  if (t.includes("BRILLOS")) return "Brillos";
  if (t.includes("ESMALTE TRADICIONAL") || t.includes("TRADICIONAL")) return "Esmalte tradicional";
  return null;
}
const lineaDe = (p) => (p.brand === "Masglo" ? lineaMasglo(p) : p.brand === "Admiss" ? lineaAdmiss(p) : null);

// Nivel 1: por SKU de fabricante.
const porSku = new Map();
for (const v of oficialesVar) {
  const p = prodPorId.get(v.external_product_id);
  if (!p) continue;
  const sku = (v.sku ?? "").trim();
  if (!sku) continue;
  const k = `${p.brand.toLowerCase()}::${sku}`;
  if (!porSku.has(k)) porSku.set(k, p);
}

// Nivel 2: por nombre DENTRO de una línea conocida. El título oficial tiene
// forma «TONO - ESMALTE …», así que se exige que empiece por el nombre.
const porMarcaLinea = new Map();
for (const p of oficialesProd) {
  const l = lineaDe(p);
  if (!l) continue;
  const k = `${p.brand.toLowerCase()}::${l.toLowerCase()}`;
  if (!porMarcaLinea.has(k)) porMarcaLinea.set(k, []);
  porMarcaLinea.get(k).push(p);
}

const palabrasVacias = new Set(["de", "del", "la", "el", "con", "sin", "para", "ml", "gr", "oz"]);
const tokens = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !palabrasVacias.has(w)));
function seCorroboran(a, b) {
  const ta = tokens(a), tb = tokens(b);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

// Un producto genérico nuestro no puede quedarse con la foto de UN color
// concreto del oficial. «Polvo Acrílico 2OZ» emparejado con «Polvo acrilico 2oz
// BOLD PINK» le pondría a la clienta la foto de un rosa que quizá no es el que
// compra: el mismo error que las líneas de Masglo, en otra marca.
//
// Si un lado nombra un color y el otro no lo nombra, no hay emparejamiento.
const COLORES = new Set([
  "blanco", "white", "negro", "black", "rojo", "red", "rosa", "rosado", "pink",
  "azul", "blue", "verde", "green", "amarillo", "yellow", "naranja", "orange",
  "morado", "purple", "violeta", "lila", "nude", "beige", "marron", "brown",
  "gris", "grey", "gray", "dorado", "gold", "plata", "silver", "cobre", "bronce",
  "turquesa", "coral", "fucsia", "fuchsia", "magenta", "celeste", "crema",
  "transparente", "clear", "peach", "almond", "snow", "bold", "melon", "cover"
]);

function coloresDe(s) {
  return new Set([...tokens(s)].filter((t) => COLORES.has(t)));
}

// Fijar la línea no basta. Dentro de Tradicional, Masglo vende el esmalte
// «Negro» Y el «Brillo Gel Tapa» en negro: mismo nombre de tono, clases
// distintas. Emparejar por nombre dentro de la línea le daba al brillo la ficha
// y la foto del esmalte.
//
// Así que la clase también tiene que coincidir. Se lee del nombre, de más
// específico a más general, igual que en auditar-coherencia-interna.mjs.
function claseDe(texto) {
  const n = norm(texto);
  if (/^(brillo|top coat|matificador|sellante)\b/.test(n) || /\bbrillo\b/.test(n)) return "BRILLO";
  if (/^(base|bases)\b/.test(n) || /\bbase\b/.test(n)) return "BASE";
  if (/^(lima|limas|pulidor|buffer)\b/.test(n) || /\blima\b/.test(n)) return "LIMA";
  if (/^(removedor|limpiador|cleanser|dilusor)\b/.test(n)) return "REMOVEDOR";
  if (/^(pincel|brocha)\b/.test(n)) return "PINCEL";
  if (/^(aceite|crema|serum)\b/.test(n)) return "CUIDADO";
  if (/\b(polvo acrilico|monomero|acrilico)\b/.test(n)) return "ACRILICO";
  if (/\bdecoracion\b/.test(n)) return "DECORACION";
  if (/\besmalte\b/.test(n)) return "ESMALTE";
  return null;
}

function claseDiscrepante(nuestro, oficial) {
  const a = claseDe(nuestro);
  const b = claseDe(oficial);
  if (!a || !b) return false;
  return a !== b;
}

function colorDiscrepante(nuestro, oficial) {
  const a = coloresDe(nuestro);
  const b = coloresDe(oficial);
  if (a.size === 0 && b.size === 0) return false;
  // Basta con que compartan uno: «Peach 30GR» y «Cover Peach 30gr» son el mismo
  // producto aunque el oficial añada «Cover».
  for (const t of a) if (b.has(t)) return false;
  return true;
}

async function todas(tabla, select, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db.from(tabla).select(select).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const variantes = await todas(
  "product_variants",
  "id, sku, name, is_active, product_id, products(id, code, name, is_active, brands(name), product_lines(name))"
);
const yaConFoto = new Set(
  (await todas("product_media", "variant_id, media_role")).filter((m) => m.variant_id).map((m) => `${m.variant_id}::${m.media_role}`)
);

const plan = [];
const sinFuente = [];

for (const v of variantes) {
  const p = v.products;
  if (!p || !p.is_active || !v.is_active) continue;
  const marca = p.brands?.name ?? "";
  const linea = p.product_lines?.name ?? null;

  let oficial = null;
  let nivel = null;

  const porSkuHit = porSku.get(`${marca.toLowerCase()}::${(v.sku ?? "").trim()}`);
  if (porSkuHit && seCorroboran(`${p.name} ${v.name}`, porSkuHit.title)) {
    oficial = porSkuHit;
    nivel = "SKU_OFICIAL";
  } else if (linea) {
    const candidatos = porMarcaLinea.get(`${marca.toLowerCase()}::${linea.toLowerCase()}`) ?? [];
    const n = norm(v.name);
    if (n.length >= 3) {
      const exactos = candidatos
        .filter((c) => norm(c.title).startsWith(n + " "))
        .filter((c) => !claseDiscrepante(`${p.name} ${v.name}`, c.title));
      // Si dentro de UNA línea el nombre sigue casando con dos productos, no se
      // elige: se enumera. La línea resolvió la ambigüedad entre líneas, no
      // promete resolver todas.
      if (exactos.length === 1) { oficial = exactos[0]; nivel = "NOMBRE_EN_LINEA"; }
      else if (exactos.length > 1) {
        sinFuente.push({ sku: v.sku, variante: v.name, producto: p.code, motivo: `ambiguo dentro de la línea ${linea} (${exactos.length} candidatos)` });
        continue;
      }
    }
  }

  // Nivel 3: nombre del PRODUCTO, para marcas sin líneas de color.
  //
  // La ambigüedad que obligaba a desconfiar del nombre es la de línea, y solo
  // la tienen los catálogos de tonos: Masglo repite «Campeona» tres veces.
  // Cherimoya no vende el mismo monómero en tres líneas — «Monomero 100ML» es
  // una cosa sola. Ahí el nombre del producto sí identifica.
  //
  // Aun así se exige mucho: coincidencia ÚNICA en toda la marca y al menos dos
  // palabras con contenido en común. Con una sola palabra, «Removedor» casaría
  // con los cuatro removedores distintos de la marca.
  if (!oficial && !linea && marca) {
    const deLaMarca = oficialesProd.filter((c) => c.brand.toLowerCase() === marca.toLowerCase());
    if (deLaMarca.length) {
      const mios = tokens(`${p.name} ${v.name}`);
      const puntuados = deLaMarca
        .map((c) => {
          const suyos = tokens(c.title);
          let comunes = 0;
          for (const t of mios) if (suyos.has(t)) comunes += 1;
          return { c, comunes };
        })
        .filter((x) => x.comunes >= 2);
      const maximo = Math.max(0, ...puntuados.map((x) => x.comunes));
      const mejores = puntuados.filter((x) => x.comunes === maximo);
      if (mejores.length === 1 && !colorDiscrepante(`${p.name} ${v.name}`, mejores[0].c.title)) {
        oficial = mejores[0].c;
        nivel = "NOMBRE_DE_PRODUCTO";
      } else if (mejores.length === 1) {
        sinFuente.push({
          sku: v.sku, variante: v.name, producto: p.code, marca,
          motivo: "el oficial nombra un color que el nuestro no",
          tituloOficial: mejores[0].c.title
        });
        continue;
      }
      else if (mejores.length > 1) {
        sinFuente.push({ sku: v.sku, variante: v.name, producto: p.code, marca, motivo: `nombre ambiguo en ${marca} (${mejores.length} candidatos con ${maximo} palabras en común)` });
        continue;
      }
    }
  }

  if (!oficial) {
    sinFuente.push({ sku: v.sku, variante: v.name, producto: p.code, marca, linea, motivo: linea ? "sin ficha oficial" : "sin fuente oficial rastreada para esta marca" });
    continue;
  }

  const imgs = imgsPorProd.get(oficial.external_product_id) ?? [];
  if (!imgs.length) {
    sinFuente.push({ sku: v.sku, variante: v.name, producto: p.code, motivo: "la ficha oficial no trae imagen" });
    continue;
  }

  plan.push({
    variantId: v.id, sku: v.sku, variante: v.name, producto: p.code, marca, linea, nivel,
    tituloOficial: oficial.title, url: oficial.source_product_url,
    imagenUrl: imgs[0].url,
    yaTiene: yaConFoto.has(`${v.id}::main`)
  });
}

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
writeFileSync(path.join(ROOT, "outputs", "plan-imagenes-oficiales.json"), JSON.stringify({ plan, sinFuente }, null, 2), "utf8");

const porNivel = new Map();
for (const x of plan) porNivel.set(x.nivel, (porNivel.get(x.nivel) ?? 0) + 1);
const nuevas = plan.filter((x) => !x.yaTiene);

console.log(`Variantes activas revisadas: ${variantes.filter((v) => v.is_active && v.products?.is_active).length}`);
console.log(`Con imagen oficial localizable: ${plan.length}`);
for (const [n, c] of porNivel) console.log(`   ${String(c).padStart(4)}  ${n}`);
console.log(`   de ellas, SIN foto todavía: ${nuevas.length}`);
console.log(`Sin fuente oficial: ${sinFuente.length}`);

const motivos = new Map();
for (const s of sinFuente) motivos.set(s.motivo, (motivos.get(s.motivo) ?? 0) + 1);
for (const [m, c] of [...motivos].sort((a, b) => b[1] - a[1])) console.log(`   ${String(c).padStart(4)}  ${m}`);

if (!APLICAR) {
  console.log(`\nEnsayo. Nada descargado. → outputs/plan-imagenes-oficiales.json`);
  console.log(`Para ejecutar:  node scripts/descargar-imagenes-oficiales.mjs --aplicar`);
  process.exit(0);
}

// ── Descarga y registro ─────────────────────────────────────────────────────
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
let subidas = 0, saltadas = 0, fallos = 0;

for (const item of nuevas) {
  try {
    const respuesta = await fetch(item.imagenUrl, { headers: { "User-Agent": "BellarosheCatalogImagePipeline/1.0" } });
    if (!respuesta.ok) throw new Error(`${respuesta.status} ${respuesta.statusText}`);
    const tipo = (respuesta.headers.get("content-type") || "").split(";")[0];
    if (!tipo.startsWith("image/")) throw new Error(`content-type inesperado: ${tipo}`);

    const original = Buffer.from(await respuesta.arrayBuffer());
    const normalizada = await sharp(original).rotate()
      .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 90, effort: 4 }).toBuffer();
    const meta = await sharp(normalizada).metadata();
    const checksum = sha256(normalizada);

    // El checksum es único en media_assets: si esta imagen ya está cargada por
    // otra vía, se reutiliza el registro en vez de duplicar el archivo.
    const { data: existente } = await db.from("media_assets").select("id").eq("checksum", checksum).maybeSingle();

    let assetId = existente?.id ?? null;
    if (!assetId) {
      const ruta = `${PREFIJO}/${crypto.randomUUID()}.webp`;
      const { error: errSubida } = await db.storage.from(BUCKET).upload(ruta, normalizada, { contentType: "image/webp", upsert: false });
      if (errSubida) throw new Error(`storage: ${errSubida.message}`);

      const { data: creado, error: errAsset } = await db.from("media_assets").insert({
        bucket: BUCKET, storage_path: ruta, file_name: `${item.sku ?? item.variantId}.webp`,
        mime_type: "image/webp", size_bytes: normalizada.length,
        width: meta.width ?? null, height: meta.height ?? null,
        alt_text: item.variante, checksum, evidence_class: "FOTO_REAL",
        metadata: {
          origen: "OFICIAL_MARCA",
          nivelEmparejamiento: item.nivel,
          skuInterno: item.sku,
          marca: item.marca,
          linea: item.linea,
          tituloOficial: item.tituloOficial,
          fichaOficial: item.url,
          imagenOriginal: item.imagenUrl,
          sha256Original: sha256(original)
        }
      }).select("id").single();
      if (errAsset) throw new Error(`media_assets: ${errAsset.message}`);
      assetId = creado.id;
    }

    const { error: errVinculo } = await db.from("product_media").insert({
      variant_id: item.variantId, media_asset_id: assetId, media_role: "main", is_primary: true, sort_order: 0
    });
    if (errVinculo) {
      if (/duplicate|unique/i.test(errVinculo.message)) { saltadas += 1; continue; }
      throw new Error(`product_media: ${errVinculo.message}`);
    }

    subidas += 1;
    if (subidas % 25 === 0) console.log(`   ${subidas}/${nuevas.length}…`);
  } catch (error) {
    fallos += 1;
    console.error(`   ✗ ${item.sku ?? item.variantId} · ${item.variante}: ${error.message}`);
  }
}

console.log(`\nDescargadas y registradas: ${subidas}`);
console.log(`Ya vinculadas (saltadas):  ${saltadas}`);
console.log(`Fallos: ${fallos}`);
