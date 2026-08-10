import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import type { TaxDocumentRequirement } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Qué exige cada comprobante.
 *
 * La pantalla NO lleva estas reglas escritas: las lee de la misma tabla que
 * consulta la base para rechazar una solicitud incompleta. Así, pedirlo antes y
 * prohibirlo después no pueden discrepar, y el día que cambie el umbral de la
 * boleta cambia una fila.
 */

type RequirementRow = {
  kind: TaxDocumentRequirement["kind"];
  tax_id_label: string;
  tax_id_pattern: string;
  tax_id_required_from: number | null;
  requires_name: boolean;
  requires_address: boolean;
  hint: string | null;
  sort_order: number;
};

export async function GET() {
  try {
    const { supabase } = await requireStaff();

    const { data, error } = await supabase
      .from("tax_document_requirements")
      .select("kind, tax_id_label, tax_id_pattern, tax_id_required_from, requires_name, requires_address, hint, sort_order")
      .order("sort_order");

    if (error) throw new HttpError(400, "tax_document_requirements_failed", error.message);

    return ok({
      items: (data as RequirementRow[]).map((row) => ({
        kind: row.kind,
        taxIdLabel: row.tax_id_label,
        taxIdPattern: row.tax_id_pattern,
        // NULL viaja como NULL: `Number(null)` es cero, y cero significa otra
        // cosa —«siempre hace falta»— que es justo lo contrario.
        taxIdRequiredFrom: row.tax_id_required_from === null ? null : Number(row.tax_id_required_from),
        requiresName: row.requires_name,
        requiresAddress: row.requires_address,
        hint: row.hint,
        sortOrder: row.sort_order
      })) satisfies TaxDocumentRequirement[]
    });
  } catch (error) {
    return handleApiError(error);
  }
}
