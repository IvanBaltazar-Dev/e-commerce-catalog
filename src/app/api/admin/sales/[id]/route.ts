import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { requestTaxDocumentSchema, type Sale } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { supabase } = await requireStaff();

    // sale_detail es SECURITY INVOKER: el bloque de costo llega nulo a la
    // vendedora por la RLS de sale_line_costs, no por una rama en el código.
    const { data, error } = await supabase.rpc("sale_detail", { p_sale_id: id });

    if (error) throw new HttpError(400, "sale_detail_failed", error.message);
    if (!data) throw new HttpError(404, "sale_not_found", "La venta no existe o no pertenece a tus sedes.");

    return ok(data as Sale);
  } catch (error) {
    return handleApiError(error);
  }
}

/** Solicitud de comprobante tributario. Nunca bloquea ni modifica la venta. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await readJson(request, requestTaxDocumentSchema);
    const { supabase } = await requireStaff();

    const { data, error } = await supabase.rpc("request_tax_document", {
      p_sale_id: id,
      p_kind: input.kind,
      p_receiver: input.receiver ?? null
    });

    if (error) throw new HttpError(400, "tax_document_request_failed", error.message);

    return ok(data as Sale);
  } catch (error) {
    return handleApiError(error);
  }
}
