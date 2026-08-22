/**
 * Descarga las imágenes de referencia a disco, con su procedencia.
 *
 * Sigue siendo remote_reference: descargar la foto oficial de otra empresa no la
 * convierte en imagen publicable de Bellaroshé. Eso es una decisión de licencia y
 * no un paso de datos, y el estado de validación no cambia por tener el fichero.
 *
 * Lo que sí resuelve tenerlas en disco: poder comprobar que la URL responde, que
 * el contenido es una imagen, su tamaño real y su huella — y detectar que dos
 * URLs distintas sirven el mismo fichero, que es la única deduplicación honesta.
 *
 *   node --experimental-transform-types scripts/descargar-imagenes-referencia.mjs [--aplicar] [--limite N]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { leerTodo } from "./lib/lectura-masiva.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APLICAR = process.argv.includes("--aplicar");
const iLim = process.argv.indexOf("--limite");
const LIMITE = iLim >= 0 ? Number(process.argv[iLim + 1]) : Infinity;
const DESTINO = path.join(ROOT, "outputs", "imagenes-referencia");
const UA = "BellarosheCatalogResearch/1.0 (+local-read-only)";
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const medios = await leerTodo({
  consulta: () => db.from("catalog_reference_media").select("id, source_id, remote_url, reference_variant_id"),
  orden: ["id"], clave: (m) => m.id, nombre: "medios de referencia",
});
// Una URL se descarga UNA vez aunque la referencien varios medios.
const urls = [...new Set(medios.map((m) => m.remote_url).filter(Boolean))].slice(0, LIMITE);
console.log(`medios ${medios.length} · URLs distintas ${urls.length}`);

fs.mkdirSync(DESTINO, { recursive: true });
const ficheroDe = (u) => path.join(DESTINO, crypto.createHash("sha256").update(u).digest("hex") + ".bin");

let ok = 0, yaEstaban = 0, fallos = 0, bytes = 0;
const porHuella = new Map();
const resultados = [];

for (const [i, u] of urls.entries()) {
  const fp = ficheroDe(u);
  if (fs.existsSync(fp)) {
    const b = fs.readFileSync(fp);
    const h = sha(b);
    porHuella.set(h, (porHuella.get(h) ?? 0) + 1);
    resultados.push({ url: u, estado: "EN_CACHE", bytes: b.length, huella: h });
    yaEstaban += 1; bytes += b.length;
    continue;
  }
  if (!APLICAR) { resultados.push({ url: u, estado: "PENDIENTE" }); continue; }
  try {
    const r = await fetch(u, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) { resultados.push({ url: u, estado: "ERROR", status: r.status }); fallos += 1; await espera(120); continue; }
    const tipo = r.headers.get("content-type") ?? "";
    const buf = Buffer.from(await r.arrayBuffer());
    // Un 200 que no devuelve una imagen no es una imagen: guardarlo como tal
    // dejaría un fichero que parece bueno y no lo es.
    if (!/^image\//i.test(tipo)) {
      resultados.push({ url: u, estado: "NO_ES_IMAGEN", contentType: tipo });
      fallos += 1; await espera(120); continue;
    }
    fs.writeFileSync(fp, buf);
    const h = sha(buf);
    porHuella.set(h, (porHuella.get(h) ?? 0) + 1);
    resultados.push({ url: u, estado: "DESCARGADA", bytes: buf.length, huella: h, contentType: tipo });
    ok += 1; bytes += buf.length;
  } catch (e) {
    resultados.push({ url: u, estado: "ERROR_RED", detalle: String(e?.name ?? e) });
    fallos += 1;
  }
  if ((i + 1) % 250 === 0) console.log(`   ${i + 1}/${urls.length} · ok ${ok} · fallos ${fallos}`);
  await espera(120);
}

const duplicadas = [...porHuella.values()].filter((n) => n > 1).length;
console.log(`\ndescargadas ${ok} · ya estaban ${yaEstaban} · fallos ${fallos}`);
console.log(`bytes ${(bytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`ficheros idénticos servidos por URLs distintas: ${duplicadas}`);
fs.writeFileSync(path.join(ROOT, "outputs", "imagenes-descargadas.json"),
  JSON.stringify({ total: urls.length, ok, yaEstaban, fallos, duplicadas, resultados }, null, 2), "utf8");
console.log(`→ outputs/imagenes-descargadas.json`);
