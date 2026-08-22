/**
 * Invariante: mismo contenido + contrato de extracción distinto → reprocesar.
 *
 * Nace de un fallo real. Al añadir los ejes de variación, el código quedó
 * correcto y las 136 variantes de Bigen siguieron sin eje. La huella del
 * snapshot solo miraba el contenido de la tienda; como la tienda no había
 * cambiado, la huella coincidía, el snapshot se reutilizaba y el bloque que
 * construye los registros se saltaba entero.
 *
 * O sea: mejorar el extractor no llegaba nunca a los datos. Y no fallaba nada —
 * la campaña decía «ok» y los datos seguían viejos.
 *
 * Esta prueba fija las tres condiciones que lo impiden:
 *
 *   1 · mismo contenido y mismo contrato  → misma huella (no se reprocesa porque sí)
 *   2 · mismo contenido y otro contrato   → huella distinta (se reprocesa)
 *   3 · otro contenido y mismo contrato   → huella distinta (lo de siempre)
 *
 * Y comprueba que los scripts de campaña declaran su contrato: uno que no lo
 * declare vuelve a ser vulnerable a lo mismo.
 *
 *   node scripts/test-contrato-extraccion.mjs
 */
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let fallos = 0;
const comprobar = (ok, msg) => { console.log(`  ${ok ? "✓" : "✗"} ${msg}`); if (!ok) fallos += 1; };

// Réplica de cómo se compone la huella, para poder razonar sobre ella sin
// depender de la base de datos.
const contentHash = (v) => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
const huella = (contenido, contrato) => contentHash({ contenido, contrato });

console.log(`\nINVARIANTE DEL CONTRATO DE EXTRACCIÓN\n`);

const A = "fingerprint-de-la-tienda-A";
const B = "fingerprint-de-la-tienda-B";

comprobar(
  huella(A, "v1") === huella(A, "v1"),
  `mismo contenido y mismo contrato → misma huella (no se reprocesa sin motivo)`,
);
comprobar(
  huella(A, "v1") !== huella(A, "v2"),
  `mismo contenido y CONTRATO DISTINTO → huella distinta (se reprocesa)`,
);
comprobar(
  huella(A, "v1") !== huella(B, "v1"),
  `contenido distinto y mismo contrato → huella distinta`,
);

// Que la composición exista en el código, no solo en esta prueba.
const campanas = [
  ["scripts/research-official-brand.mjs", "CONTRATO_EXTRACCION"],
  ["scripts/campana-woocommerce.mjs", "CONTRATO"],
];
for (const [rel, marca] of campanas) {
  const src = readFileSync(path.join(ROOT, rel), "utf8");
  comprobar(src.includes(marca), `${rel} declara su contrato (${marca})`);
}

// Y que la huella de snapshot de la campaña Shopify realmente lo mezcle: si
// alguien volviera a usar capture.contentFingerprint a secas, el fallo vuelve.
{
  const src = readFileSync(path.join(ROOT, "scripts/research-official-brand.mjs"), "utf8");
  const componeHuella = /const huellaDeCaptura = \(capture\) =>\s*\n?\s*contentHash\(\{ contenido: capture\.contentFingerprint, contrato: CONTRATO_EXTRACCION \}\)/.test(src);
  comprobar(componeHuella, `la huella de snapshot mezcla contenido con contrato`);

  const usaCrudo = /\.eq\("content_hash", capture\.contentFingerprint\)/.test(src)
    || /content_hash: capture\.contentFingerprint,/.test(src);
  comprobar(!usaCrudo, `ningún snapshot se busca ni se escribe con la huella cruda del contenido`);
}

console.log();
if (fallos) {
  console.error(`${fallos} comprobación(es) fallan: una mejora del extractor podría quedarse inerte.\n`);
  process.exit(1);
}
console.log(`Cambiar el extractor obliga a reprocesar, aunque la web no haya cambiado.\n`);
