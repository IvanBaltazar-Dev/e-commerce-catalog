// Cierra las 2 anomalías de la cola de la certificación 1C con decisión de la
// dueña (2026-08-09), dejando registro en la evidencia:
//   1. REVE'L y REVEL son la misma marca → se unifican bajo REVEL; REVE'L
//      queda desactivada (sin borrar, conserva referencias).
//   2. LIN-DEC-F87EC1 y LIN-DEC-FA087F son el mismo producto comercial → la
//      variante Surtido se muda al producto agrupado con clave limpia y el
//      producto viejo queda desactivado; la trazabilidad de la fila 743 sigue
//      a su variante (mismo id) y se actualiza el producto destino.
//
//   node scripts/fix-anomalias-certificacion.mjs --env .env.supabase.local

import path from "node:path";
import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1")), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: root, scriptName: "fix-anomalias-1c" });
if (!isLocal) throw new Error("Solo local.");
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const log = { aplicado: new Date().toISOString(), decisor: "Ivan (certificación 1C)", acciones: [] };

// --- 1 · Unificar REVE'L → REVEL -------------------------------------------
{
  const { data: brands, error } = await service.from("brands").select("id, slug, name, is_active").in("slug", ["revel", "reve-l"]);
  if (error) throw error;
  const revel = brands.find((b) => b.slug === "revel");
  const reveL = brands.find((b) => b.slug === "reve-l");
  if (revel && reveL && reveL.is_active) {
    const moved = await service.from("products").update({ brand_id: revel.id }).eq("brand_id", reveL.id).select("code");
    if (moved.error) throw moved.error;
    const shades = await service.from("color_shades").update({ brand_id: revel.id }).eq("brand_id", reveL.id).select("id");
    if (shades.error) throw shades.error;
    const off = await service.from("brands").update({ is_active: false }).eq("id", reveL.id);
    if (off.error) throw off.error;
    log.acciones.push({
      anomalia: "marca_fragmentada",
      decision: "REVE'L y REVEL son la misma marca; sobrevive REVEL.",
      productosMovidos: (moved.data ?? []).map((p) => p.code),
      shadesMovidas: (shades.data ?? []).length,
      marcaDesactivada: "reve-l"
    });
  } else {
    log.acciones.push({ anomalia: "marca_fragmentada", decision: "ya resuelta", nota: "REVE'L inactiva o inexistente." });
  }
}

// --- 2 · Fusionar pastilleros LINDA JHADE -----------------------------------
{
  const { data: oldProduct } = await service.from("products").select("id, code, is_active").eq("code", "LIN-DEC-F87EC1").maybeSingle();
  const { data: newProduct } = await service.from("products").select("id, code, name").eq("code", "LIN-DEC-FA087F").maybeSingle();
  if (oldProduct && newProduct && oldProduct.is_active) {
    const { data: variants } = await service.from("product_variants").select("id, name, variant_key, is_default").eq("product_id", oldProduct.id);
    for (const variant of variants ?? []) {
      const move = await service.from("product_variants").update({
        product_id: newProduct.id,
        variant_key: "set_name:surtido",
        name: "Surtido",
        is_default: false
      }).eq("id", variant.id);
      if (move.error) throw move.error;
    }
    // La fila del Excel que creó el producto viejo sigue a su variante.
    const trail = await service.from("import_rows").update({ target_product_id: newProduct.id }).eq("target_product_id", oldProduct.id).select("row_number");
    if (trail.error) throw trail.error;
    const off = await service.from("products").update({ is_active: false, editorial_status: "hidden" }).eq("id", oldProduct.id);
    if (off.error) throw off.error;
    // Nombre comercial limpio del producto fusionado (guion final era artefacto).
    const rename = await service.from("products").update({ name: "Adorno P/uñas Pastillero" }).eq("id", newProduct.id);
    if (rename.error) throw rename.error;
    log.acciones.push({
      anomalia: "producto_nombre_casi_identico",
      decision: "Mismo producto comercial; las variantes viven en LIN-DEC-FA087F.",
      variantesMovidas: (variants ?? []).map((v) => `${v.name} → set_name:surtido`),
      filasReapuntadas: (trail.data ?? []).map((r) => r.row_number),
      productoDesactivado: "LIN-DEC-F87EC1",
      nombreFinal: "Adorno P/uñas Pastillero"
    });
  } else {
    log.acciones.push({ anomalia: "producto_nombre_casi_identico", decision: "ya resuelta", nota: "Producto viejo inactivo o inexistente." });
  }
}

const target = path.join(root, "docs", "evidencia-certificacion-1c", "anomalias-resueltas.json");
await fs.writeFile(target, JSON.stringify(log, null, 2), "utf8");
console.log(JSON.stringify(log, null, 2));
