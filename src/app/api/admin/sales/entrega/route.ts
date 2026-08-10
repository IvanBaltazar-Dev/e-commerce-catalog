import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { FulfillmentRequirement } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Qué exige cada método de entrega.
 *
 * La pantalla NO trae esta regla escrita: la lee de la misma tabla que consulta
 * el disparador que impide cerrar una venta incompleta. Es lo que hace que
 * pedirlo antes y prohibirlo después no puedan discrepar — y que la dueña pueda
 * cambiar un requisito sin tocar código ni migrar nada.
 */

type RequirementRow = {
  method: FulfillmentRequirement["method"];
  requires_recipient: boolean;
  requires_phone: boolean;
  requires_address: boolean;
  requires_document: boolean;
  allows_on_delivery: boolean;
  requires_advance: boolean;
  min_advance_percent: number | null;
  hint: string | null;
};

export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const { data, error } = await supabase
      .from("fulfillment_requirements")
      .select("method, requires_recipient, requires_phone, requires_address, requires_document, allows_on_delivery, requires_advance, min_advance_percent, hint");

    if (error) throw new HttpError(400, "fulfillment_requirements_failed", error.message);

    return ok({
      items: (data as RequirementRow[]).map((row) => ({
        method: row.method,
        requiresRecipient: row.requires_recipient,
        requiresPhone: row.requires_phone,
        requiresAddress: row.requires_address,
        requiresDocument: row.requires_document,
        allowsOnDelivery: row.allows_on_delivery,
        requiresAdvance: row.requires_advance,
        // NULL viaja como NULL. `Number(null)` es cero, y cero significa otra
        // cosa: que se admite no adelantar nada. Es la misma ambigüedad que 0064
        // quitó de la base, y colarla aquí la devolvería por la puerta de atrás.
        minAdvancePercent: row.min_advance_percent === null ? null : Number(row.min_advance_percent),
        hint: row.hint
      })) satisfies FulfillmentRequirement[]
    });
  } catch (error) {
    return handleApiError(error);
  }
}
