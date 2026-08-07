import { handleApiError, HttpError, ok, created, readJson } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { trendActionSchema, type ContentProposalRow } from "@/lib/ai/contracts";
import { generateTrendProposal } from "@/lib/ai/trends";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Tendencias: el sistema PROPONE contenido desde señales internas y la dueña
 * decide. Aprobar, rechazar y «ya lo publiqué yo» son actos humanos
 * registrados por los contratos de 0044; publicación automática no existe.
 */
export async function GET() {
  try {
    const { supabase } = await requireAdmin();

    const { data, error } = await supabase
      .from("content_proposals")
      .select("id, title, body, status, created_at, reviewed_at, review_note, published_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw new HttpError(400, "proposals_failed", error.message);

    const items: ContentProposalRow[] = ((data ?? []) as {
      id: string; title: string; body: string; status: ContentProposalRow["estado"];
      created_at: string; reviewed_at: string | null; review_note: string | null;
      published_at: string | null;
    }[]).map((row) => ({
      id: row.id,
      titulo: row.title,
      cuerpo: row.body,
      estado: row.status,
      creadaEl: row.created_at,
      revisadaEl: row.reviewed_at,
      notaRevision: row.review_note,
      publicadaEl: row.published_at
    }));

    return ok({ items });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST() {
  try {
    const { supabase } = await requireAdmin();
    const result = await generateTrendProposal(supabase);
    return created(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, trendActionSchema);

    const { data, error } =
      input.accion === "published"
        ? await supabase.rpc("mark_content_published", {
            p_proposal_id: input.proposalId,
            p_note: input.nota ?? null
          })
        : await supabase.rpc("review_content_proposal", {
            p_proposal_id: input.proposalId,
            p_decision: input.accion,
            p_note: input.nota ?? null
          });

    if (error) throw new HttpError(400, "proposal_action_failed", error.message);

    return ok(data as { id: string; status: string });
  } catch (error) {
    return handleApiError(error);
  }
}
