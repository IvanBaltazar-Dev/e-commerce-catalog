// La regla del número de operación existe en dos idiomas, y esta prueba impide
// que se separen.
//
// Uso: node --experimental-transform-types scripts/test-payment-rule.mjs
//
// POR QUÉ. `payment_requires_reference` en PostgreSQL es la que manda: la
// aplican las restricciones de `sale_payments` y `reservation_payments`, y
// alcanza a cualquier camino —pantalla, script, asistente—. Pero la pantalla
// necesita saber lo mismo ANTES de enviar, para pedir el código en vez de
// fallar al confirmar, y eso obliga a tener la lista también en TypeScript.
//
// Dos listas es una duplicación inevitable; que se queden distintas, no. Si
// mañana alguien añade un medio en un idioma y se olvida del otro, esto lo dice
// aquí y no en el mostrador.

import { spawnSync } from "node:child_process";
import { paymentMethodSchema, requiresOperationNumber } from "../src/lib/admin/sales.ts";

const CONTAINER = "supabase_db_e-commerce-catalog";

function sql(query) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-c", query],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`Consulta fallida: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail) console.log(`       ${detail}`);
  }
}

// Se recorren TODOS los medios del enumerado, no una lista escrita aquí: si
// mañana se añade uno nuevo, entra solo en la comparación.
const metodos = paymentMethodSchema.options;

console.log(`\nLa regla del N.º de operación, en los ${metodos.length} medios de pago`);

const enBase = Object.fromEntries(
  sql(
    `select m, public.payment_requires_reference(m::public.payment_method)
     from unnest(array[${metodos.map((m) => `'${m}'`).join(",")}]) as m;`
  )
    .split("\n")
    .map((line) => line.split("|"))
    .map(([metodo, exige]) => [metodo, exige === "t"])
);

for (const metodo of metodos) {
  const app = requiresOperationNumber(metodo);
  const base = enBase[metodo];
  check(
    `${metodo}: ${base ? "exige código" : "no exige"} — y la aplicación dice lo mismo`,
    app === base,
    `PostgreSQL=${base} · aplicación=${app}`
  );
}

console.log(
  failures === 0
    ? "\nPASS · la base y la pantalla exigen el número de operación en los mismos medios"
    : `\nFALLO · ${failures} medio(s) en los que las dos reglas discrepan`
);
process.exit(failures === 0 ? 0 : 1);
