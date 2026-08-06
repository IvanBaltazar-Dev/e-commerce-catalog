import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { registerSaleSchema, type Sale } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SaleRow = {
  id: string;
  sale_number: string;
  branch_id: string;
  branch: { name: string } | { name: string }[] | null;
  status: Sale["status"];
  source_channel: Sale["sourceChannel"];
  fulfillment_method: Sale["fulfillmentMethod"];
  customer_name: string | null;
  customer_phone: string | null;
  gross_subtotal: number;
  discount_total: number;
  total: number;
  currency: string;
  seller_label: string | null;
  issued_at: string;
};

function branchName(branch: SaleRow["branch"]): string | undefined {
  if (!branch) return undefined;
  return Array.isArray(branch) ? branch[0]?.name : branch.name;
}

export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    // La RLS ya recorta por las sedes de quien consulta: no se filtra aquí.
    const { data, error } = await supabase
      .from("sales")
      .select("id, sale_number, branch_id, branch:branches(name), status, source_channel, fulfillment_method, customer_name, customer_phone, gross_subtotal, discount_total, total, currency, seller_label, issued_at")
      .order("issued_at", { ascending: false })
      .limit(limit);

    if (error) throw new HttpError(400, "sales_list_failed", error.message);

    return ok({
      items: (data as SaleRow[]).map((row) => ({
        id: row.id,
        saleNumber: row.sale_number,
        branchId: row.branch_id,
        branchName: branchName(row.branch),
        status: row.status,
        sourceChannel: row.source_channel,
        fulfillmentMethod: row.fulfillment_method,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        grossSubtotal: Number(row.gross_subtotal),
        discountTotal: Number(row.discount_total),
        total: Number(row.total),
        currency: row.currency,
        sellerLabel: row.seller_label,
        issuedAt: row.issued_at
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, registerSaleSchema);
    const { supabase } = await requireStaff();

    // Toda la operación —inventario, costos, correlativo, líneas y pagos— ocurre
    // dentro de register_sale: si algo falla, no queda nada a medias.
    const { data, error } = await supabase.rpc("register_sale", {
      p_branch_id: input.branchId,
      p_lines: input.lines,
      p_payments: input.payments,
      p_client_operation_id: input.clientOperationId,
      p_source_channel: input.sourceChannel,
      p_fulfillment_method: input.fulfillmentMethod,
      p_customer: input.customer ?? null,
      p_discount_total: input.discountTotal,
      p_notes: input.notes ?? null,
      p_reservation_id: input.reservationId ?? null,
      p_source_reference: input.sourceReference ?? null
    });

    if (error) throw new HttpError(400, "sale_register_failed", error.message);

    return created(data as Sale);
  } catch (error) {
    return handleApiError(error);
  }
}
