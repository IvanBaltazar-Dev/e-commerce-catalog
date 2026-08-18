/**
 * Campaña Multimedia · congelar, procesar y reportar.
 *
 * El catálogo declara 158 medios sin un solo byte detrás. Esta campaña los
 * recupera, pero con expediente: cada caso entra congelado, sale con un estado
 * explícito, y ninguno puede desaparecer para poner verde el gate.
 *
 * Dos carriles que no se mezclan:
 *
 *   A · las imágenes oficiales cuya identidad ya está decidida. Se descargan
 *       sin reinterpretar de quién son.
 *   B · los medios ya declarados que necesitan auditoría. Se resuelven a un
 *       estado, no a un borrado.
 *
 *   freeze   congela el alcance y su huella. No toca ni un byte.
 *   report   los cuatro gates de salida.
 *
 * Uso:
 *   node scripts/media-campaign.mjs freeze --key campana-1 --env .env.supabase.local
 *   node scripts/media-campaign.mjs report --key campana-1 --env .env.supabase.local
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { catalogResearchStorageRoot } from "./lib/catalog-research-paths.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "media-campaign",
  allowedFlags: ["--key"],
});
if (!isLocal) throw new Error("La campaña multimedia solo corre contra Supabase local.");

const QUEUE_CSV = path.join(catalogResearchStorageRoot(ROOT), "data", "image_pending_queue.csv");
const action = positionals[0] ?? "report";
const campaignKey = process.argv.find((argument) => argument.startsWith("--key="))?.slice("--key=".length)
  ?? positionals[1];
if (!campaignKey) throw new Error("Falta --key con la clave de la campaña.");

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function parseCsvLine(line) {
  const out = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { out.push(current); current = ""; }
    else current += char;
  }
  out.push(current);
  return out;
}

async function readQueue() {
  const raw = await fs.readFile(QUEUE_CSV, "utf8");
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""]));
  });
}

/**
 * Huella del alcance. Si mañana la cola del auditor cambia, o si un expediente
 * entra o sale, esta huella deja de coincidir y la campaña ya no describe lo
 * que dijo describir.
 */
function scopeFingerprint(items) {
  const lines = items
    .map((item) => [
      item.lane, item.variant_id ?? "", item.product_id ?? "",
      item.media_asset_id ?? "", item.official_url ?? "", item.source_classification,
    ].join("|"))
    .sort();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ---------------------------------------------------------------------------

if (action === "freeze") {
  const existing = must(
    await service.from("catalog_media_campaigns").select("id").eq("campaign_key", campaignKey).maybeSingle(),
    "campaña previa"
  );
  if (existing) throw new Error(`La campaña ${campaignKey} ya está congelada. Usa report.`);

  const queue = await readQueue();

  // Paginado a mano: la API corta en mil filas por defecto y el catálogo tiene
  // 1570 variantes. Sin esto, 570 variantes vivas parecían desaparecidas y la
  // campaña se congelaba con un tercio del alcance real, sin que nada fallara.
  const liveVariants = new Set();
  for (let offset = 0; ; offset += 1000) {
    const page = must(
      await service.from("product_variants").select("id").range(offset, offset + 999),
      `variantes vivas ${offset}`
    );
    for (const row of page) liveVariants.add(row.id);
    if (page.length < 1000) break;
  }

  const items = [];
  const excluded = [];

  // Carril A · identidad ya decidida. La campaña no la revisa.
  for (const row of queue) {
    if (row.classification !== "ENCONTRADA_OFICIAL_PENDIENTE_DESCARGA") continue;
    if (!row.official_remote_image_url) {
      excluded.push({ lane: "A", variant: row.variant_id, motivo: "clasificada como oficial pero sin URL" });
      continue;
    }
    if (!liveVariants.has(row.variant_id)) {
      excluded.push({ lane: "A", variant: row.variant_id, motivo: "la variante ya no existe en el catálogo" });
      continue;
    }
    items.push({
      lane: "A",
      variant_id: row.variant_id,
      product_id: null,
      media_asset_id: null,
      official_url: row.official_remote_image_url,
      source_classification: row.classification,
      provenance: {
        sku: row.sku, brand: row.brand, productName: row.product_name,
        variantName: row.variant_name, shadeName: row.shade_name,
        evidenceUrl: row.official_evidence_url || null,
        auditorConfidence: row.confidence || null,
      },
    });
  }

  // Carril B · medios ya declarados que necesitan auditoría.
  for (const row of queue) {
    if (row.classification !== "ACTIVO_INTERNO_REQUIERE_AUDITORIA") continue;
    if (!liveVariants.has(row.variant_id)) {
      excluded.push({ lane: "B", variant: row.variant_id, motivo: "la variante ya no existe en el catálogo" });
      continue;
    }
    const asset = must(
      await service.from("product_media").select("media_asset_id").eq("variant_id", row.variant_id).limit(1).maybeSingle(),
      "medio declarado de la variante"
    );
    items.push({
      lane: "B",
      variant_id: row.variant_id,
      product_id: null,
      media_asset_id: asset?.media_asset_id ?? null,
      official_url: row.official_remote_image_url || null,
      source_classification: row.classification,
      provenance: {
        sku: row.sku, brand: row.brand, productName: row.product_name,
        internalMediaCount: row.current_internal_media_count,
        internalPaths: row.current_internal_storage_paths || null,
      },
    });
  }

  // Carril B · lo que ninguna clasificación reclama. Los medios que cuelgan de
  // un producto quedan fuera de la cola del auditor, que razona por variante.
  // Sin este barrido, un descuadre que se compensa pasaría por cuadrado.
  const productMedia = must(
    await service.from("product_media")
      .select("media_asset_id, product_id, media_assets(storage_path)")
      .not("product_id", "is", null),
    "medios colgados de un producto"
  );
  for (const link of productMedia) {
    items.push({
      lane: "B",
      variant_id: null,
      product_id: link.product_id,
      media_asset_id: link.media_asset_id,
      official_url: null,
      source_classification: "MEDIO_DE_PRODUCTO_FUERA_DE_COLA",
      provenance: {
        storagePath: Array.isArray(link.media_assets)
          ? link.media_assets[0]?.storage_path
          : link.media_assets?.storage_path,
        motivo: "La cola del auditor razona por variante; este medio cuelga del producto.",
      },
    });
  }

  const fingerprint = scopeFingerprint(items);
  const laneA = items.filter((item) => item.lane === "A").length;
  const laneB = items.filter((item) => item.lane === "B").length;

  const campaign = must(
    await service.from("catalog_media_campaigns").insert({
      campaign_key: campaignKey,
      scope_fingerprint: fingerprint,
      scope_size: items.length,
      lane_a_size: laneA,
      lane_b_size: laneB,
      totals: { excluidos: excluded },
    }).select("id").single(),
    "congelar la campaña"
  );

  for (let offset = 0; offset < items.length; offset += 200) {
    must(
      await service.from("catalog_media_campaign_items")
        .insert(items.slice(offset, offset + 200).map((item) => ({ ...item, campaign_id: campaign.id }))),
      `congelar expedientes ${offset}`
    );
  }

  console.log(JSON.stringify({
    accion: "freeze",
    campana: campaignKey,
    expedientesCongelados: items.length,
    carrilA: laneA,
    carrilB: laneB,
    huellaDelAlcance: fingerprint,
    excluidosDelAlcance: excluded,
  }, null, 2));

} else if (action === "report") {
  const campaign = must(
    await service.from("catalog_media_campaigns").select("*").eq("campaign_key", campaignKey).single(),
    "campaña"
  );
  const integrity = must(
    await service.from("catalog_media_campaign_integrity_v1").select("*").eq("campaign_id", campaign.id).single(),
    "integridad"
  );
  const byState = must(
    await service.from("catalog_media_campaign_items").select("lane, state").eq("campaign_id", campaign.id),
    "expedientes"
  );
  const tally = {};
  for (const item of byState) {
    const key = `${item.lane}·${item.state}`;
    tally[key] = (tally[key] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    accion: "report",
    campana: campaign.campaign_key,
    estado: campaign.status,
    alcance: campaign.scope_size,
    carrilA: campaign.lane_a_size,
    carrilB: campaign.lane_b_size,
    huellaDelAlcance: campaign.scope_fingerprint,
    porEstado: tally,
    gateA: {
      nombre: "Integridad de campaña",
      expedientes: integrity.expedientes,
      terminados: integrity.terminados,
      pendientes: integrity.pendientes,
      conIncidencia: integrity.con_incidencia,
      incidenciasSinCausa: integrity.incidencias_sin_causa,
      retiradosDePublicacion: integrity.retirados_de_publicacion,
      resultado: integrity.integridad_completa ? "VERDE" : "INCOMPLETA",
    },
  }, null, 2));

} else {
  throw new Error(`Acción desconocida: ${action}. Usa freeze o report.`);
}
