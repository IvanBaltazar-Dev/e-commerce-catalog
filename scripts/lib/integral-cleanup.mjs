/**
 * Retirada de los documentos que una integral creó, y solo de esos.
 *
 * El runbook lo pide así: cada prueba aísla sus datos y los limpia en su propio
 * `finally`. La alternativa —que la retirada de los fixtures DEMO borre ventas,
 * reservas y carritos de forma global— es más peligrosa: no distingue entre lo
 * que creó una prueba y lo que hay de verdad en la base.
 *
 * Por eso aquí no se borra nada por marca, por sede ni por patrón de código. Se
 * borra por identificador. Quien llama declara qué creó; lo que no declare, se
 * queda.
 *
 * El orden es de la hoja a la raíz porque las claves foráneas de venta y
 * reserva son restrictivas: una línea viva impide borrar su cabecera.
 */

import { spawn } from "node:child_process";

const CONTAINER = process.env.SUPABASE_DB_CONTAINER ?? "supabase_db_e-commerce-catalog";

function psql(statement) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres",
       "-v", "ON_ERROR_STOP=1", "-A", "-t"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim()))));
    child.stdin.end(statement);
  });
}

const isUuid = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Lista SQL de uuid válidos, o `null` si no quedó ninguno que declarar. */
function uuidList(values) {
  const unique = [...new Set((values ?? []).filter(isUuid))];
  return unique.length ? unique.map((value) => `'${value}'::uuid`).join(", ") : null;
}

/**
 * Borra los documentos declarados. Cada grupo es opcional: lo que no se declara
 * no se toca.
 *
 * @param {object} owned
 * @param {string[]} [owned.saleIds]         ventas registradas por la prueba
 * @param {string[]} [owned.reservationIds]  reservas creadas por la prueba
 * @param {string[]} [owned.cartIds]         carritos públicos creados por la prueba
 * @param {string[]} [owned.returnIds]       devoluciones creadas por la prueba
 */
export async function purgeIntegralDocuments(owned = {}) {
  const sales = uuidList(owned.saleIds);
  const reservations = uuidList(owned.reservationIds);
  const carts = uuidList(owned.cartIds);
  const returns = uuidList(owned.returnIds);
  if (!sales && !reservations && !carts && !returns) return;

  // Las líneas, pagos, costos, cancelaciones y devoluciones caen solas: sus
  // claves foráneas son en cascada. Lo que hay que desatar a mano es lo que
  // apunta al documento con RESTRICT, que es justo lo que no debe morir con él.
  //
  // La atribución de canal es el caso claro: sobrevive al documento a
  // propósito —una campaña que no acabó en venta sigue siendo información— así
  // que se le quita el vínculo en vez de borrarla. La limpieza de contactos de
  // cada prueba es la que decide después si esa fila sigue teniendo sentido.
  const blocks = [];
  const detach = [];

  // La atribución y la venta se protegen mutuamente: la venta apunta a la
  // atribución y la atribución apunta a la venta, y además un disparador
  // prohíbe reasignar una atribución ya ligada —«el primer contacto no se
  // reescribe»—. El único orden que existe es soltar el vínculo desde la venta,
  // retirar la atribución que la prueba creó y recién entonces la venta.
  if (sales) {
    detach.push(`update public.sales set attribution_id = null where id in (${sales});`);
    detach.push(`delete from public.channel_attributions where sale_id in (${sales});`);
    detach.push(`delete from public.expense_allocations where sale_id in (${sales});`);
    detach.push(`delete from public.cash_movements where source_type = 'sale' and source_id in (${sales});`);
  }
  if (reservations) {
    detach.push(`delete from public.channel_attributions where reservation_id in (${reservations});`);
    detach.push(`delete from public.cash_movements where source_type = 'reservation' and source_id in (${reservations});`);
  }
  blocks.push(detach.join("\n"));

  // El carrito se retira ENTERO y primero. Vaciarle el vínculo a su venta
  // rompería su propia coherencia —un carrito «convertido» sin conversión no
  // es un estado que exista— y además es lo que bloquea retirar la venta.
  if (carts) {
    blocks.push(`
      update public.channel_attributions set cart_id = null where cart_id in (${carts});
      delete from public.public_carts where id in (${carts});`);
  }

  if (returns) blocks.push(`delete from public.returns where id in (${returns});`);

  // Primero la venta y después la reserva: `sales.reservation_id` es
  // restrictiva, así que una venta viva impide retirar la reserva que la
  // originó.
  if (sales) blocks.push(`delete from public.sales where id in (${sales});`);
  if (reservations) blocks.push(`delete from public.reservations where id in (${reservations});`);

  // El inventario se devuelve solo: borrar la venta no repone stock, pero el
  // kardex conserva el movimiento y ese es el registro que manda. Reponer a
  // mano descuadraría el invariante que 0028 comprueba fila a fila.
  await psql(`begin;\n${blocks.join("\n")}\ncommit;`);
}

/**
 * Igual que la anterior, pero sin propagar el fallo: se usa dentro de un
 * `finally`, donde tapar el error original de la prueba sería peor que dejar un
 * documento sin borrar. Lo que no se pudo limpiar se dice en voz alta.
 */
export async function purgeIntegralDocumentsQuietly(owned = {}, label = "integral") {
  try {
    await purgeIntegralDocuments(owned);
  } catch (error) {
    console.warn(`  aviso  la limpieza de ${label} no pudo completarse: ${error.message}`);
  }
}
