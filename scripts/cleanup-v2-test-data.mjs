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
      check(await client.from("wholesale_rules").delete().in("variant_id", variantIds).select("id"), "eliminar reglas mayoristas de variante");
      check(await client.from("product_relations").delete().in("source_variant_id", variantIds).select("id"), "eliminar relaciones origen variante");
      check(await client.from("product_relations").delete().in("target_variant_id", variantIds).select("id"), "eliminar relaciones destino variante");
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
