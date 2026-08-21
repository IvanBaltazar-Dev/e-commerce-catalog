/**
 * Fixture del contrato de captura.
 *
 * Dos reglas que ya fallaron una vez cada una:
 *
 *   · un HTTP 400 a mitad se tomó por fin de catálogo y se reportaron 336
 *     productos como si fueran los 680. Un cierre mal clasificado convierte una
 *     captura a medias en «el catálogo encogió».
 *
 *   · el parser se quedaba con el primer código de «SH-607,608» y perdía el
 *     segundo. De 499 declaraciones salen 540 códigos porque 134 traen más de
 *     uno.
 *
 * Ejecutar: npm run test:captura-contratos
 */
import assert from "node:assert/strict";

const { clasificarCierre, puedePromoverseComoCompleta, expandirCodigos, normalizarCodigo } =
  await import("../src/lib/catalog-intelligence/captura-contratos.ts");

// ── Cierre ────────────────────────────────────────────────────────────────
const completa = clasificarCierre({
  declaredTotal: 680, itemsCaptured: 680, pagesCompleted: 29,
  failedPages: [], terminoPorVacioCorrecto: true, terminoPorTope: false,
});
assert.equal(completa.closure, "COMPLETE");
assert.equal(puedePromoverseComoCompleta(completa.closure), true);

// El caso real: 336 de 680 por un 400 en la página 15.
const truncada = clasificarCierre({
  declaredTotal: 680, itemsCaptured: 336, pagesCompleted: 14,
  failedPages: [15], terminoPorVacioCorrecto: false, terminoPorTope: false,
});
assert.equal(truncada.closure, "INCOMPLETE_CAPTURE",
  "una página sin recuperar hace la captura incompleta, no un catálogo más pequeño");
assert.equal(puedePromoverseComoCompleta(truncada.closure), false,
  "una captura incompleta NO puede promoverse como el catálogo entero");

// El catálogo encogió de verdad: sin fallos y terminando en vacío correcto.
const encogio = clasificarCierre({
  declaredTotal: null, itemsCaptured: 640, pagesCompleted: 27,
  failedPages: [], terminoPorVacioCorrecto: true, terminoPorTope: false,
});
assert.equal(encogio.closure, "COMPLETE",
  "sin fallos y con final correcto, menos productos es un hecho de la fuente");

// La fuente declara más de lo capturado, aunque no falle ninguna página.
const faltan = clasificarCierre({
  declaredTotal: 698, itemsCaptured: 640, pagesCompleted: 27,
  failedPages: [], terminoPorVacioCorrecto: true, terminoPorTope: false,
});
assert.equal(faltan.closure, "INCOMPLETE_CAPTURE",
  "si la fuente declara 698 y capturamos 640, falta algo aunque nada haya fallado");

assert.equal(clasificarCierre({
  declaredTotal: null, itemsCaptured: 0, pagesCompleted: 0,
  failedPages: [1], terminoPorVacioCorrecto: false, terminoPorTope: false,
}).closure, "SOURCE_UNAVAILABLE");

assert.equal(clasificarCierre({
  declaredTotal: null, itemsCaptured: 1440, pagesCompleted: 60,
  failedPages: [], terminoPorVacioCorrecto: false, terminoPorTope: true,
}).closure, "STOPPED_AT_LIMIT",
  "pararse en el tope no es haber terminado");

// ── Códigos compuestos ────────────────────────────────────────────────────
assert.deepEqual(expandirCodigos("SH-607,608").sort(), ["SH-607", "SH-608"]);
assert.deepEqual(
  expandirCodigos("LA-302,306,309,310,311").sort(),
  ["LA-302", "LA-306", "LA-309", "LA-310", "LA-311"]
);
assert.deepEqual(expandirCodigos("#601007"), ["#601007"]);
assert.deepEqual(expandirCodigos("#508036, #508038, #508054").sort(),
  ["#508036", "#508038", "#508054"]);

// Rangos: el formato de la partida 96, cepillos de cabello.
assert.deepEqual(
  expandirCodigos("CEPILLO DE CABELLO SH-635 AL 639,648 23CM").sort(),
  ["SH-635", "SH-636", "SH-637", "SH-638", "SH-639", "SH-648"],
  "«635 AL 639» es inequívoco y debe expandirse"
);
const cepillos = expandirCodigos("CEPILLO DE CABELLO SH-633,634,642 AL 647,649 AL 653,658 18CM");
// 633, 634 (2) + 642..647 (6) + 649..653 (5) + 658 (1) = 14. Conté quince la
// primera vez: la aserción estaba mal, no el parser.
assert.equal(cepillos.length, 14, "633, 634, 642-647, 649-653 y 658 son catorce códigos");
assert.ok(cepillos.includes("SH-645") && cepillos.includes("SH-651") && cepillos.includes("SH-658"));

// Un rango ilegible no devuelve NADA, ni siquiera el número de anclaje.
//
// El texto dice «100 AL 9999», no «100»: quedarse con SH-100 sería adivinar que
// el primero es un código y el resto ruido, y no hay nada que lo respalde. Y no
// se pierde información, porque la descripción cruda se guarda entera y siempre
// se puede volver a leer con una regla mejor.
assert.deepEqual(expandirCodigos("SH-100 AL 9999"), [],
  "un rango de miles no es una serie de códigos y no se adivina el ancla");
assert.deepEqual(expandirCodigos("SH-500 AL 400"), [],
  "un rango invertido tampoco se interpreta a medias");

// Lo que NO debe inventar.
assert.deepEqual(expandirCodigos("SH-577 y otros"), ["SH-577"],
  "«y otros» no es una expansión: no se inventa lo que no está");
assert.deepEqual(expandirCodigos("").sort(), []);
assert.deepEqual(expandirCodigos(null), []);

// Dos prefijos distintos en la misma línea: cada uno es suyo, sin mezclarse.
const dos = expandirCodigos("SH-607 LA-302").sort();
assert.deepEqual(dos, ["LA-302", "SH-607"]);

// El caso real completo de una declaración aduanera.
const real = expandirCodigos(
  "KIT BRILLO GLOSS, REVE`L, S/M KIT BRILLO GLOSS SH-577 BOX X 24PCS LOTE:26240577 13.5G"
);
assert.ok(real.includes("SH-577"), "el código del producto debe salir de la declaración");

// ── Normalización ─────────────────────────────────────────────────────────
assert.equal(normalizarCodigo("SH-496"), "SH496");
assert.equal(normalizarCodigo("#601007"), "601007");
assert.equal(normalizarCodigo(" sh 496 "), "SH496");
assert.equal(normalizarCodigo(null), "");

console.log("Contratos de captura verificados:");
console.log("  cierre COMPLETE / INCOMPLETE_CAPTURE / SOURCE_UNAVAILABLE / STOPPED_AT_LIMIT");
console.log("  códigos compuestos SH-607,608 y LA-302,306,309,310,311 sin inventar expansiones");
