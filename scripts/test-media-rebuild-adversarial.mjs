/**
 * Certificación adversarial del gate de medios.
 *
 * Que `verify` diga «verde» sobre un patrimonio sano no prueba gran cosa: lo
 * mismo diría un gate que solo compara el manifiesto contra la base sin abrir
 * un archivo. Lo que hay que demostrar es que se pone ROJO cuando debe, y por
 * el motivo correcto.
 *
 * Se fabrican dos objetos propios, se exporta su checkpoint, y luego se rompe
 * el patrimonio de cuatro maneras distintas, una por vez, devolviéndolo a su
 * sitio entre una y otra:
 *
 *   1. medio fantasma      — se borra el archivo y se deja el metadato;
 *   2. archivo huérfano    — se sube un objeto que nadie declara;
 *   3. hash divergente     — se sustituye el contenido conservando la ruta;
 *   4. dueño inválido      — se desliga el medio de su producto.
 *
 * Y se comprueba lo que el conteo no ve: que la huella agregada cambia cuando
 * el mismo archivo pasa a colgar de otra entidad.
 *
 * Uso: node scripts/test-media-rebuild-adversarial.mjs --env .env.supabase.local
 */
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-media-rebuild-adversarial" });
if (!isLocal) throw new Error("La certificación de medios solo corre contra Supabase local.");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUCKET = "catalog-assets";
const PREFIX = "pruebas/media-adversarial";
// El bucket solo admite tipos de imagen. El contenido es irrelevante para lo que
// se prueba —hashes, dueños y presencia—, pero el tipo declarado sí importa.
const MIME = "image/png";
const ORPHAN_PATH = `${PREFIX}/objeto-que-nadie-declara.png`;

let failures = 0;
function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail !== undefined) console.log(`       ${detail}`);
  }
}

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

/** Corre el gate y devuelve su informe, esté verde o rojo. */
function runGate(action) {
  const result = spawnSync(
    process.execPath,
    ["scripts/gate-media-rebuild.mjs", action, "--env", ".env.supabase.local"],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const output = `${result.stdout}${result.stderr}`;
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`El gate no devolvió informe:\n${output}`);
  return JSON.parse(output.slice(start, end + 1));
}

const bytesFor = (text) => Buffer.from(text, "utf8");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function upload(storagePath, buffer, mime = MIME) {
  const { error } = await service.storage.from(BUCKET)
    .upload(storagePath, buffer, { contentType: mime, upsert: true });
  if (error) throw new Error(`subir ${storagePath}: ${error.message}`);
}

// ---------------------------------------------------------------------------

console.log("Certificación adversarial del patrimonio multimedia\n");

const variants = must(
  await service.from("product_variants").select("id, product_id").eq("is_active", true).limit(2),
  "variantes donde colgar la prueba"
);
if (variants.length < 2) throw new Error("Hacen falta dos variantes activas: corre checkpoint:restore:local.");

console.log("1. Se fabrica un patrimonio propio y se congela");

const fixtures = [
  { name: "adversarial-uno.png", body: "contenido uno", variant: variants[0] },
  { name: "adversarial-dos.png", body: "contenido dos", variant: variants[1] },
];

for (const fixture of fixtures) {
  fixture.path = `${PREFIX}/${fixture.name}`;
  fixture.buffer = bytesFor(fixture.body);
  await upload(fixture.path, fixture.buffer);
  const asset = must(
    await service.from("media_assets").upsert({
      bucket: BUCKET, storage_path: fixture.path, file_name: fixture.name,
      mime_type: MIME, size_bytes: fixture.buffer.byteLength,
      checksum: sha256(fixture.buffer), metadata: { adversarial: true },
    }, { onConflict: "bucket,storage_path" }).select("id").single(),
    "registrar el medio de prueba"
  );
  fixture.assetId = asset.id;
  must(
    await service.from("product_media").insert({
      // Un medio cuelga de un producto O de una variante, nunca de los dos.
      media_asset_id: asset.id, variant_id: fixture.variant.id,
      media_role: "gallery", is_primary: false, sort_order: 900,
    }),
    "colgar el medio de su variante"
  );
}

const exported = runGate("export");
const baseline = exported.huellaDelPatrimonio;
check("el export congela el patrimonio y emite su huella", typeof baseline === "string" && baseline.length === 64, baseline);

// El catálogo real arrastra 158 medios declarados sin un solo byte detrás: el
// gate está en rojo por ellos y hace bien. Lo que esta prueba certifica no es el
// veredicto global sino el DELTA que provoca cada rotura, que es lo único
// atribuible a los objetos que ella misma fabricó.
const base = runGate("verify");
const delta = (informe, contador) => informe[contador] - base[contador];
check("los objetos sanos de la prueba no añaden ningún defecto",
  delta(base, "mediosFantasma") === 0 && base.archivosHuerfanos === 0
  && base.hashesDivergentes === 0 && base.mediosSinDueno === 0,
  JSON.stringify({ fantasma: base.mediosFantasma, huerfanos: base.archivosHuerfanos }));
check("y la huella viva coincide con la del manifiesto", base.huellaCoincide === true);

console.log("\n2. Medio fantasma: se borra el archivo y se deja el metadato");
must(await service.storage.from(BUCKET).remove([fixtures[0].path]), "borrar el archivo");
const fantasma = runGate("verify");
check("el gate se pone ROJO", fantasma.resultado === "ROJO");
check("y suma exactamente un medio fantasma", delta(fantasma, "mediosFantasma") === 1,
  );
await upload(fixtures[0].path, fixtures[0].buffer);
check("devuelto el archivo, el delta vuelve a cero",
  delta(runGate("verify"), "mediosFantasma") === 0);

console.log("\n3. Archivo huérfano: se sube un objeto que nadie declara");
await upload(ORPHAN_PATH, bytesFor("nadie me reclama"));
const huerfano = runGate("verify");
check("el gate se pone ROJO", huerfano.resultado === "ROJO");
check("y suma exactamente un archivo huérfano", delta(huerfano, "archivosHuerfanos") === 1,
  JSON.stringify(huerfano.ejemplos.huerfanos));
must(await service.storage.from(BUCKET).remove([ORPHAN_PATH]), "retirar el huérfano");
check("retirado el huérfano, el delta vuelve a cero",
  delta(runGate("verify"), "archivosHuerfanos") === 0);

console.log("\n4. Hash divergente: misma ruta, otro contenido");
await upload(fixtures[1].path, bytesFor("contenido sustituido a escondidas"));
const divergente = runGate("verify");
check("el gate se pone ROJO", divergente.resultado === "ROJO");
check("y suma exactamente un hash divergente", delta(divergente, "hashesDivergentes") === 1,
  JSON.stringify(divergente.ejemplos.divergentes));
check("la huella viva deja de coincidir con la congelada", divergente.huellaCoincide === false);
await upload(fixtures[1].path, fixtures[1].buffer);
check("devuelto el contenido, el delta vuelve a cero",
  delta(runGate("verify"), "hashesDivergentes") === 0);

console.log("\n5. Dueño inválido: el medio deja de colgar de nada");
must(await service.from("product_media").delete().eq("media_asset_id", fixtures[0].assetId),
  "desligar el medio de su variante");
const sinDueno = runGate("verify");
check("el gate se pone ROJO", sinDueno.resultado === "ROJO");
check("y suma exactamente un medio sin dueño", delta(sinDueno, "mediosSinDueno") === 1,
  JSON.stringify(sinDueno.ejemplos.sinDueno));

console.log("\n6. La huella distingue lo que el conteo no ve");
must(
  await service.from("product_media").insert({
    media_asset_id: fixtures[0].assetId, variant_id: fixtures[1].variant.id,
    media_role: "gallery", is_primary: false, sort_order: 901,
  }),
  "colgar el medio de OTRA variante"
);
const mudado = runGate("verify");
check("el mismo archivo colgado de otra entidad cambia la huella",
  mudado.huellaDelPatrimonio !== baseline,
  `${mudado.huellaDelPatrimonio} vs ${baseline}`);
check("y el gate lo detecta como patrimonio distinto", mudado.resultado === "ROJO");

console.log("\n7. Destrucción y recuperación: se vacía Storage y se restaura");
must(await service.from("product_media").delete().eq("media_asset_id", fixtures[0].assetId),
  "deshacer el dueño prestado");
must(
  await service.from("product_media").insert({
    media_asset_id: fixtures[0].assetId, variant_id: fixtures[0].variant.id,
    media_role: "gallery", is_primary: false, sort_order: 900,
  }),
  "devolver el medio a su variante"
);
check("devuelto el dueño, la huella vuelve a ser la congelada",
  runGate("verify").huellaDelPatrimonio === baseline);

// Se borran los BYTES, no los metadatos: es exactamente lo que pasó el 18 de
// agosto y lo que el checkpoint tiene que saber deshacer.
must(await service.storage.from(BUCKET).remove(fixtures.map((fixture) => fixture.path)),
  "vaciar Storage");
const destruido = runGate("verify");
check("sin bytes, el gate se pone ROJO aunque PostgreSQL esté intacto",
  destruido.resultado === "ROJO" && delta(destruido, "mediosFantasma") === fixtures.length,
  );

const devuelto = runGate("restore");
check("el restore devuelve todos los objetos desde el almacén local",
  devuelto.objetosDevueltos === fixtures.length && devuelto.fallos.length === 0,
  JSON.stringify(devuelto.fallos));

const recuperado = runGate("verify");
check("y tras recuperar, no queda ningún defecto propio",
  delta(recuperado, "mediosFantasma") === 0 && recuperado.archivosHuerfanos === 0
  && recuperado.hashesDivergentes === 0 && recuperado.mediosSinDueno === 0,
  JSON.stringify(recuperado.ejemplos));
check("con la MISMA huella que antes de destruir",
  recuperado.huellaDelPatrimonio === baseline,
  `${recuperado.huellaDelPatrimonio} vs ${baseline}`);

console.log("\n8. Se retira el patrimonio de prueba");
for (const fixture of fixtures) {
  await service.from("product_media").delete().eq("media_asset_id", fixture.assetId);
  await service.from("media_assets").delete().eq("id", fixture.assetId);
  await service.storage.from(BUCKET).remove([fixture.path]);
}
const restante = must(
  await service.from("media_assets").select("id").like("storage_path", `${PREFIX}/%`),
  "medios de prueba restantes"
);
check("no queda ningún medio de la prueba", restante.length === 0, JSON.stringify(restante));

console.log(failures === 0
  ? "\nPASS · el gate de medios se pone rojo por cada motivo, y solo por el suyo"
  : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
