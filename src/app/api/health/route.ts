import { ok } from "@/lib/api/http";

export const runtime = "nodejs";

export async function GET() {
  return ok({
    service: "bellaroshe-catalog-backend",
    status: "ok"
  });
}
