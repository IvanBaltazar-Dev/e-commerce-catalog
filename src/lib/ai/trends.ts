import "server-only";

import { z } from "zod/v4";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BusinessDashboard } from "@/lib/admin/analytics";
import { AI_MODEL, isAiConfigured, runStructured } from "@/lib/ai/provider";

/**
 * Tendencias (Bloque 4): señales INTERNAS —qué se vende, qué tono sube, qué
 * canal produce— convertidas en una propuesta de contenido en borrador. El
 * sistema propone y espera; la publicación es siempre un acto humano
 * registrado (0044 lo hace estructural). El LLM solo redacta mejor el texto;
 * las señales y el borrador determinista existen sin él.
 */

const copySchema = z.object({
  titulo: z.string().min(1).max(120),
  cuerpo: z.string().min(1).max(2000)
});

type TrendSignals = {
  ventanaDias: number;
  totalVendido: number;
  topTonos: { tono: string; unidades: number }[];
  topProductos: { nombre: string; unidades: number }[];
  canalTop: { canal: string; ingreso: number } | null;
};

function extractSignals(dashboard: BusinessDashboard): TrendSignals {
  const canales = Object.entries(dashboard.rankings.canales);
  canales.sort((a, b) => b[1].ingreso - a[1].ingreso);

  return {
    ventanaDias: 30,
    totalVendido: dashboard.ventas.total,
    topTonos: dashboard.rankings.tonosPorUnidades.slice(0, 3).map((row) => ({
      tono: row.tono,
      unidades: row.unidades
    })),
    topProductos: dashboard.rankings.productosPorUnidades.slice(0, 3).map((row) => ({
      nombre: row.nombre,
      unidades: row.unidades
    })),
    canalTop: canales[0] ? { canal: canales[0][0], ingreso: canales[0][1].ingreso } : null
  };
}

function deterministicDraft(signals: TrendSignals): { titulo: string; cuerpo: string } {
  const tonos = signals.topTonos.map((t) => `${t.tono} (${t.unidades} u.)`).join(", ");
  const productos = signals.topProductos.map((p) => `${p.nombre} (${p.unidades} u.)`).join(", ");

  return {
    titulo:
      signals.topTonos[0] != null
        ? `Contenido sugerido: ${signals.topTonos[0].tono} manda este mes`
        : "Contenido sugerido: lo más vendido del mes",
    cuerpo: [
      `Señales de los últimos ${signals.ventanaDias} días de la propia tienda:`,
      tonos ? `· Tonos con más salida: ${tonos}.` : null,
      productos ? `· Productos con más salida: ${productos}.` : null,
      signals.canalTop ? `· El canal que más produce: ${signals.canalTop.canal}.` : null,
      "",
      "Idea de contenido: mostrar estos favoritos reales en un reel corto con demostración en uñas, cerrando con invitación a escribir por WhatsApp.",
      "Este borrador se genera de ventas reales; revísalo, ajústalo a tu voz y publícalo tú misma cuando decidas."
    ]
      .filter((line): line is string => line != null)
      .join("\n")
  };
}

export type TrendResult = {
  proposalId: string;
  titulo: string;
  proveedor: { estado: "ok" | "degraded"; modelo: string | null; detalle: string | null };
};

export async function generateTrendProposal(supabase: SupabaseClient): Promise<TrendResult> {
  const { data: dashboardData, error: dashboardError } = await supabase.rpc("business_dashboard", {});
  if (dashboardError) {
    throw new Error(`No se pudieron leer las señales internas: ${dashboardError.message}`);
  }

  const signals = extractSignals(dashboardData as BusinessDashboard);
  let draft = deterministicDraft(signals);
  let proveedor: TrendResult["proveedor"] = {
    estado: "degraded",
    modelo: null,
    detalle: "Borrador determinista de señales internas."
  };

  if (isAiConfigured()) {
    const result = await runStructured({
      system: [
        "Eres la creadora de contenido de Bellaroshé (belleza y uñas, Lima).",
        "Con las señales de venta reales que te paso, redacta UNA propuesta de contenido para redes: título corto y cuerpo con la idea del post/reel, en español de Perú, tono cercano y profesional.",
        "Habla solo de los productos y tonos de las señales; no inventes cifras ni productos.",
        "Termina recordando que la publicación la decide y la hace la dueña."
      ].join(" "),
      content: [{ type: "text", text: JSON.stringify(signals) }],
      schema: copySchema,
      maxTokens: 1024
    });

    if (result.ok) {
      draft = { titulo: result.data.titulo, cuerpo: result.data.cuerpo };
      proveedor = { estado: "ok", modelo: AI_MODEL, detalle: null };
    } else {
      proveedor = { estado: "degraded", modelo: null, detalle: result.message };
    }
  }

  const { data: proposalId, error } = await supabase.rpc("create_content_proposal", {
    p_title: draft.titulo,
    p_body: draft.cuerpo,
    p_signals: signals as unknown as Record<string, unknown>
  });

  if (error) {
    throw new Error(`No se pudo guardar la propuesta: ${error.message}`);
  }

  return { proposalId: proposalId as string, titulo: draft.titulo, proveedor };
}
