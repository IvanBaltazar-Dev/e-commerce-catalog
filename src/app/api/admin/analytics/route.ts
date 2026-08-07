import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import type { BusinessDashboard } from "@/lib/admin/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El tablero comercial. Toda la matemática vive en `business_dashboard`
 * (0043): esta ruta valida el rango, transporta el JSON y nada más — un
 * indicador recalculado aquí sería una segunda fuente de verdad.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const url = new URL(request.url);

    const desde = url.searchParams.get("desde");
    const hasta = url.searchParams.get("hasta");
    const sede = url.searchParams.get("sede");

    if ((desde && !DATE_PATTERN.test(desde)) || (hasta && !DATE_PATTERN.test(hasta))) {
      throw new HttpError(400, "invalid_range", "Las fechas deben tener el formato AAAA-MM-DD.");
    }

    const { data, error } = await supabase.rpc("business_dashboard", {
      ...(desde ? { p_from: desde } : {}),
      ...(hasta ? { p_to: hasta } : {}),
      ...(sede ? { p_branch_id: sede } : {})
    });

    if (error) {
      // 22023 es el rango invertido: se devuelve como error de datos, no 500.
      const status = error.code === "22023" ? 400 : 403;
      throw new HttpError(status, "dashboard_failed", error.message);
    }

    return ok({ dashboard: data as BusinessDashboard });
  } catch (error) {
    return handleApiError(error);
  }
}
