import { handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import type { CartEvaluation } from "@/lib/catalog/contracts";
import { cartEvaluationSchema } from "@/lib/catalog/validation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await readJson(request, cartEvaluationSchema);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("evaluate_cart_v2", {
      p_lines: input.lines
    });

    if (error) {
      throw new HttpError(400, "cart_evaluation_failed", error.message);
    }

    return ok(data as CartEvaluation);
  } catch (error) {
    return handleApiError(error);
  }
}
