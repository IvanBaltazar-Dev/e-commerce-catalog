/**
 * El choque CHE011, convertido en fixture permanente.
 *
 * El 2026-08-20 la reconciliación emparejó nuestro «Gel Paint 001 Blanco» con
 * el «Colors Lip Oil» de Cherimoya porque ambos se llaman CHE011 y son de la
 * misma marca. La preparación de medios le descargó al gel paint la foto del
 * labial. Los nueve medios preparados resultaron ser los nueve del mismo fallo.
 *
 * Que hoy el código lo detecte no basta: dentro de seis meses alguien puede
 * simplificar la guarda por parecerle redundante. Este fixture lo impide.
 *
 * Ejecutar:  node --experimental-transform-types scripts/test-identidad-guardas.mjs
 */
import assert from "node:assert/strict";

const {
  evaluarIdentidadPorIdentificador,
  puedeAdoptarDerivado,
  puedeSostenerMatchExacto,
  clasesIncompatibles,
  seCorroboran,
} = await import("../src/lib/catalog-intelligence/identidad-guardas.ts");

// ── El caso adversarial: el que ya nos engañó ──────────────────────────────
const cherimoyaChoque = evaluarIdentidadPorIdentificador(
  { valor: "CHE011", clase: "BELLAROSHE_SKU", emisor: "Bellaroshé", nombre: "Gel Paint 001 Blanco" },
  { valor: "CHE011", clase: "MANUFACTURER_SKU", emisor: "Cherimoya", nombre: "Colors Lip Oil" },
);
assert.notEqual(cherimoyaChoque.veredicto, "MATCH_EXACT",
  "CHE011 contra CHE011 con nombres incompatibles NUNCA puede ser identidad exacta");
assert.equal(cherimoyaChoque.veredicto, "COLLISION_GUARD",
  "el choque debe nombrarse, no descartarse en silencio");
assert.equal(puedeAdoptarDerivado(cherimoyaChoque.veredicto), false,
  "de un choque no se adopta ni foto, ni barcode, ni atributo");

// Y el resto de la familia Cherimoya que cayó igual.
for (const [nuestro, suyo] of [
  ["Sanitizante 150ML", "Sombra Liquida para Ojos Micro Glitter"],
  ["Gel Paint 338 Plata", "Lipstick Mate"],
  ["Base Coat 15ML", "Polvo Compacto Facial"],
  ["Monomero 100ML", "Labial Líquido Mate"],
]) {
  const r = evaluarIdentidadPorIdentificador(
    { valor: "CHE017", clase: "BELLAROSHE_SKU", emisor: "Bellaroshé", nombre: nuestro },
    { valor: "CHE017", clase: "MANUFACTURER_SKU", emisor: "Cherimoya", nombre: suyo },
  );
  assert.notEqual(r.veredicto, "MATCH_EXACT", `«${nuestro}» no puede resolver contra «${suyo}»`);
}

// ── El caso positivo: mismo código, procedencia confirmada ────────────────
const masgloConfirmado = evaluarIdentidadPorIdentificador(
  { valor: "310028", clase: "MANUFACTURER_SKU", emisor: "Masglo", nombre: "Esmalte Masglo Tradicional Campeona" },
  { valor: "310028", clase: "MANUFACTURER_SKU", emisor: "Masglo", nombre: "CAMPEONA - ESMALTE TRADICIONAL CREMOSO MASGLO 13,5 ML" },
);
assert.equal(masgloConfirmado.veredicto, "MATCH_EXACT",
  "un SKU de fabricante confirmado y compatible SÍ resuelve");
assert.equal(puedeAdoptarDerivado(masgloConfirmado.veredicto), true,
  "de una identidad exacta sí se puede adoptar");

// Confirmado aunque el nombre no se parezca: la tienda pudo reescribirlo, y el
// código de fabricante manda sobre el texto comercial.
const nombreReescrito = evaluarIdentidadPorIdentificador(
  { valor: "312946", clase: "MANUFACTURER_SKU", emisor: "Admiss", nombre: "Gian" },
  { valor: "312946", clase: "MANUFACTURER_SKU", emisor: "Admiss", nombre: "GIAN - ESMALTE TRADICIONAL CREMOSOS ADMISS 10 ML" },
);
assert.equal(nombreReescrito.veredicto, "MATCH_EXACT", "el SKU confirmado no depende del parecido del nombre");

// Correlativo interno PERO los nombres se tocan: se acepta, porque la
// corroboración sustituye a la procedencia que falta.
const corroborado = evaluarIdentidadPorIdentificador(
  { valor: "CHE023", clase: "BELLAROSHE_SKU", emisor: "Bellaroshé", nombre: "Lima 100/150" },
  { valor: "CHE023", clase: "MANUFACTURER_SKU", emisor: "Cherimoya", nombre: "Lima para Uñas 100/150" },
);
assert.equal(corroborado.veredicto, "MATCH_EXACT",
  "sin procedencia confirmada, la corroboración de nombre habilita el match");

// ── El caso SAC-4: mismo texto, emisores distintos ────────────────────────
const sacChoque = evaluarIdentidadPorIdentificador(
  { valor: "SAC-4", clase: "SUPPLIER_SKU", emisor: "Candy Secret", nombre: "Top Coat 15 ml" },
  { valor: "SAC-4", clase: "SUPPLIER_SKU", emisor: "Konsung Beauty", nombre: "Water Soluble Max 500 g" },
);
assert.equal(sacChoque.veredicto, "COLLISION_GUARD",
  "SAC-4 de Konsung no es SAC-4 de Candy Secret aunque el texto coincida");

// ── LS241: el sistema de códigos cruza marcas ─────────────────────────────
// En importaciones a Perú del mismo periodo, LS241-* aparece bajo Candy Secret,
// bajo ICONSIGN y sin marca. Nuestro LS241-080 es una lima en disco sin marca
// comprada a WEDOR. El sistema identifica DENTRO del catálogo del exportador;
// no dice de qué marca es el producto.
const mismoSistema = evaluarIdentidadPorIdentificador(
  { valor: "LS241-080", clase: "CODE_SYSTEM_SKU", emisor: "LS241", nombre: "Lima en Disco 80,120,180" },
  { valor: "LS241-080", clase: "CODE_SYSTEM_SKU", emisor: "LS241", nombre: "Disco de lija 80/120/180 x60" },
);
assert.equal(mismoSistema.veredicto, "MATCH_EXACT",
  "el mismo código del mismo sistema, con nombres compatibles, resuelve");

const sistemasDistintos = evaluarIdentidadPorIdentificador(
  { valor: "LS241-001", clase: "CODE_SYSTEM_SKU", emisor: "LS241", nombre: "Lash Lift Kit" },
  { valor: "LS241-001", clase: "CODE_SYSTEM_SKU", emisor: "LSH2", nombre: "Top Coat 15 ml" },
);
assert.equal(sistemasDistintos.veredicto, "COLLISION_GUARD",
  "el mismo texto en dos sistemas de códigos distintos no es el mismo código");

assert.equal(puedeSostenerMatchExacto("CODE_SYSTEM_SKU"), true,
  "un código de sistema sí identifica dentro de su catálogo de origen");

// ── El rango por clase, no por columna ────────────────────────────────────
assert.equal(puedeSostenerMatchExacto("GTIN"), true);
assert.equal(puedeSostenerMatchExacto("MANUFACTURER_SKU"), true);
assert.equal(puedeSostenerMatchExacto("SUPPLIER_SKU"), true);
assert.equal(puedeSostenerMatchExacto("SOURCE_EXTERNAL_ID"), true);
assert.equal(puedeSostenerMatchExacto("BELLAROSHE_SKU"), false,
  "nuestro correlativo no significa nada fuera de esta base: nunca sostiene identidad por sí solo");
assert.equal(puedeSostenerMatchExacto("DESCONOCIDA"), false,
  "un valor cuya clase no se conoce no puede sostener identidad");

// ── Valores distintos no emparejan por mucho que se parezcan los nombres ──
assert.equal(
  evaluarIdentidadPorIdentificador(
    { valor: "CHE011", clase: "MANUFACTURER_SKU", emisor: "Cherimoya", nombre: "Gel Paint" },
    { valor: "CHE012", clase: "MANUFACTURER_SKU", emisor: "Cherimoya", nombre: "Gel Paint" },
  ).veredicto,
  "NO_MATCH",
);

// ── Las piezas sueltas ────────────────────────────────────────────────────
// Ojo con esta: la clase NO fue lo que atrapó a CHE011. «Gel Paint Blanco» no
// se puede clasificar con el léxico actual —devuelve null— y con un lado sin
// clase no hay incompatibilidad que declarar. Lo que lo atrapó fue que los
// nombres no se tocan. Se afirma tal cual para que nadie crea que hay una
// defensa que no existe.
assert.equal(clasesIncompatibles("Gel Paint Blanco", "Colors Lip Oil"), false,
  "con un lado sin clase reconocible, la comparación de clases no puede decidir");
assert.equal(seCorroboran("Gel Paint Blanco", "Colors Lip Oil"), false,
  "y es la falta de corroboración la que sostiene la guarda en este caso");
assert.equal(clasesIncompatibles("Brillo Gel Tapa Negro", "NEGRO - ESMALTE TRADICIONAL CREMOSO"), true,
  "un brillo y un esmalte no son la misma clase aunque compartan el tono");
assert.equal(clasesIncompatibles("Lima 100/150", "Lima para Uñas 100/150"), false);
assert.equal(seCorroboran("Lima 100/150", "Lima para Uñas 100/150"), true);
assert.equal(seCorroboran("Gel Paint 001 Blanco", "Colors Lip Oil"), false);

console.log("Guardas de identidad verificadas:");
console.log("  choque CHE011 · familia Cherimoya · SAC-4 entre emisores");
console.log("  LS241 entre sistemas de código · caso positivo Masglo/Admiss · rango por clase");
