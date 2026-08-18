/**
 * Las tres llamadas que hace GET /api/admin/products, cronometradas por
 * separado. La ruta tarda ~5 s y el RPC en la base son 65 ms: el tiempo está
 * en alguna de las vueltas a PostgREST, y esto dice en cuál.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const envPath = ".env.supabase.local";
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);

const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

const PRODUCT_SELECT = `
  id, code, slug, name, presentation, product_type, requires_lamp, lamp_type,
  description, unit_price, wholesale_price, wholesale_min_quantity, availability,
  color_chart_status, main_image_path, color_chart_image_path, color_chart_pdf_path,
  is_active, editorial_status, sort_order, created_at, updated_at,
  brand:brands(id, name, slug),
  category:categories(id, name, slug),
  gallery:product_images(id, path, alt_text, sort_order)
`;

async function cronometrar(nombre, fn) {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  if (r?.error) console.log(`  ${String(ms).padStart(6)} ms  ${nombre}  ✗ ${r.error.message}`);
  else console.log(`  ${String(ms).padStart(6)} ms  ${nombre}`);
  return r;
}

console.log("\n0. sesión");
await cronometrar("signInWithPassword", () =>
  client.auth.signInWithPassword({ email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" })
);

for (const vuelta of [1, 2, 3]) {
  console.log(`\n── vuelta ${vuelta} ──`);
  const busqueda = await cronometrar("rpc admin_product_search", () =>
    client.rpc("admin_product_search", {
      p_query: null, p_estado: null, p_active: null, p_brand_id: null,
      p_limit: 8, p_offset: 0, p_foto: null
    })
  );
  const ids = busqueda.data?.ids ?? [];

  await cronometrar(`select products (${ids.length} ids, con embebidos)`, () =>
    client.from("products").select(PRODUCT_SELECT).in("id", ids)
  );

  await cronometrar("select products SIN gallery", () =>
    client
      .from("products")
      .select("id, code, name, brand:brands(id,name,slug), category:categories(id,name,slug)")
      .in("id", ids)
  );

  await cronometrar("select admin_product_media_state", () =>
    client
      .from("admin_product_media_state")
      .select("product_id, estado_foto, fotos_total, fotos_envase, fotos_construidas, portada_path")
      .in("product_id", ids)
  );
}
