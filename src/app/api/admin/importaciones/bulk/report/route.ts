import { handleApiError, HttpError, ok } from "@/lib/api/http";
import { buildBulkPreview, bulkBatchReport } from "@/lib/admin/catalog-bulk-import/service";
import { requireCatalogImportDeveloper } from "@/lib/auth/catalog-import";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const { supabase } = await requireCatalogImportDeveloper();
    const url = new URL(request.url);
    const batchId = url.searchParams.get("batchId");
    if (!batchId) {
      const batches = await supabase
        .from("import_batches")
        .select("id, source_name, original_file_name, status, total_rows, processed_rows, error_rows, committed_at, created_at, summary")
        .like("source_name", "bulk_catalog_v2:%")
        .order("created_at", { ascending: false })
        .limit(30);
      if (batches.error) throw new HttpError(400, "bulk_batches_read_failed", batches.error.message);
      // error_rows se queda en cero tras un commit exitoso: la señal que la
      // persona necesita ver es cuántas filas siguen en revisión y cuántas
      // incidencias de error siguen abiertas en cada lote.
      const ids = (batches.data ?? []).map((batch) => batch.id);
      const enRevision = new Map<string, number>();
      const issuesAbiertos = new Map<string, number>();
      if (ids.length) {
        const rows = await supabase
          .from("import_rows")
          .select("batch_id, status, import_issues(severity, status)")
          .in("batch_id", ids);
        if (rows.error) throw new HttpError(400, "bulk_batches_rows_read_failed", rows.error.message);
        for (const row of rows.data ?? []) {
          const key = String(row.batch_id);
          if (row.status === "needs_review") enRevision.set(key, (enRevision.get(key) ?? 0) + 1);
          for (const issue of (row.import_issues as Array<{ severity: string; status: string }> | null) ?? []) {
            if (issue.status === "open" && (issue.severity === "error" || issue.severity === "blocking")) {
              issuesAbiertos.set(key, (issuesAbiertos.get(key) ?? 0) + 1);
            }
          }
        }
      }
      return ok({
        batches: (batches.data ?? []).map((batch) => ({
          ...batch,
          en_revision: enRevision.get(String(batch.id)) ?? 0,
          issues_abiertos: issuesAbiertos.get(String(batch.id)) ?? 0
        }))
      });
    }
    if (url.searchParams.get("view") === "preview") {
      return ok(await buildBulkPreview(supabase, batchId));
    }
    return ok(await bulkBatchReport(supabase, batchId));
  } catch (error) {
    return handleApiError(error);
  }
}
