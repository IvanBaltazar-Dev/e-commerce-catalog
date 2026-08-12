import { CatalogIntelligenceView } from "@/components/admin/CatalogIntelligenceView";

/**
 * La ruta histórica se conserva para no romper enlaces ni permisos. La carga
 * deja de ser el centro: ahora vive como una fuente secundaria dentro de la
 * base maestra permanente de enriquecimiento y reconciliación.
 */
export function ImportacionesTabs() {
  return <CatalogIntelligenceView />;
}
