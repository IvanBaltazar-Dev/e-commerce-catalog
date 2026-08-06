import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "cleanup-v2-test-data" });
if (!isLocal) throw new Error("La limpieza de datos de prueba solo se permite en Supabase local.");
const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function check(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data ?? [];
}

async function deleteProducts(pattern) {
  let removed = 0;
  while (true) {
    const rows = check(await client.from("products").select("id").like("code", pattern).limit(100), "listar productos de prueba");
    if (!rows.length) return removed;
    const ids = rows.map((row) => row.id);
    const variants = check(await client.from("product_variants").select("id").in("product_id", ids), "listar variantes de prueba");
    const variantIds = variants.map((row) => row.id);
    check(await client.from("wholesale_rules").delete().in("product_id", ids).select("id"), "eliminar reglas mayoristas de producto");
    check(await client.from("product_relations").delete().in("source_product_id", ids).select("id"), "eliminar relaciones origen");
    check(await client.from("product_relations").delete().in("target_product_id", ids).select("id"), "eliminar relaciones destino");
    if (variantIds.length) {
      // Caja (0029). `sale_lines.variant_id` y `reservation_lines.variant_id`
      // son RESTRICTIVAS, así que una variante vendida en una prueba bloquea el
      // borrado del producto. Se retiran los documentos completos: la cabecera
      // cascadea a líneas, costos y pagos, y hacerlo al revés es imposible
      // —quitar los pagos primero dejaría la venta con total y cobranza cero, y
      // el trigger diferido lo rechaza—.
      const saleLines = check(await client.from("sale_lines").select("sale_id").in("variant_id", variantIds), "listar líneas de venta de prueba");
      const saleIds = [...new Set(saleLines.map((row) => row.sale_id))];
      const reservationLines = check(await client.from("reservation_lines").select("reservation_id").in("variant_id", variantIds), "listar líneas de reserva de prueba");
      const reservationIds = [...new Set(reservationLines.map((row) => row.reservation_id))];

      if (saleIds.length) {
        check(await client.from("sales").delete().in("id", saleIds).select("id"), "eliminar ventas de prueba");
      }
      if (reservationIds.length) {
        check(await client.from("reservations").delete().in("id", reservationIds).select("id"), "eliminar reservas de prueba");
      }

      check(await client.from("wholesale_rules").delete().in("variant_id", variantIds).select("id"), "eliminar reglas mayoristas de variante");
      check(await client.from("product_relations").delete().in("source_variant_id", variantIds).select("id"), "eliminar relaciones origen variante");
      check(await client.from("product_relations").delete().in("target_variant_id", variantIds).select("id"), "eliminar relaciones destino variante");

      // Inventario (0028). El kardex tiene clave foránea RESTRICTIVA hacia la
      // variante y un trigger que rechaza el borrado con historia, así que sin
      // este bloque el borrado de productos fallaría. El orden importa: primero
      // los movimientos, que son lo que el trigger comprueba, y después el saldo
      // y la valoración, que dependen del mismo par (variante, sede).
      //
      // El kardex acepta DELETE aunque rechace UPDATE, siguiendo el precedente
      // de supplier_cost_agreements: reescribir un importe es silencioso y
      // corrompe la historia; borrar es explícito y queda en la bitácora. Es lo
      // que mantiene limpiable el entorno de prueba sin aflojar la inmutabilidad
      // que protege a producción.
      check(await client.from("inventory_movements").delete().in("variant_id", variantIds).select("id"), "eliminar movimientos de inventario de prueba");
      check(await client.from("inventory_valuation").delete().in("variant_id", variantIds).select("variant_id"), "eliminar valoración de prueba");
      check(await client.from("inventory_stock").delete().in("variant_id", variantIds).select("variant_id"), "eliminar existencias de prueba");
    }
    check(await client.from("products").delete().in("id", ids).select("id"), "eliminar productos de prueba");
    removed += rows.length;
  }
}

const removedProducts = (await deleteProducts("TEST-%")) + (await deleteProducts("SCALE-%"));
const definitions = check(await client.from("attribute_definitions").select("id").like("code", "test_%"), "listar atributos de prueba");
if (definitions.length) {
  check(await client.from("template_attributes").delete().in("attribute_definition_id", definitions.map((row) => row.id)).select("attribute_definition_id"), "eliminar asociaciones de prueba");
  check(await client.from("attribute_options").delete().in("attribute_definition_id", definitions.map((row) => row.id)).select("id"), "eliminar opciones de prueba");
  check(await client.from("attribute_definitions").delete().in("id", definitions.map((row) => row.id)).select("id"), "eliminar atributos de prueba");
}
check(await client.from("categories").delete().like("slug", "test-%").select("id"), "eliminar categorías de prueba");
check(await client.from("attribute_templates").delete().like("code", "TEST_%").select("id"), "eliminar plantillas de prueba");

let removedUsers = 0;
for (let page = 1; page <= 20; page += 1) {
  const listed = await client.auth.admin.listUsers({ page, perPage: 200 });
  if (listed.error) throw listed.error;
  const users = listed.data.users.filter((user) => user.email?.startsWith("codex-v2-") && user.email.endsWith("@local.invalid"));
  for (const user of users) {
    const deleted = await client.auth.admin.deleteUser(user.id);
    if (deleted.error) throw deleted.error;
    removedUsers += 1;
  }
  if (listed.data.users.length < 200) break;
}

console.log(`Limpieza local completada: ${removedProducts} productos y ${removedUsers} usuarios de prueba.`);
