"use client";

import { useState } from "react";
import { CatalogBulkImportView } from "@/components/admin/CatalogBulkImportView";
import { CatalogImportView } from "@/components/admin/CatalogImportView";

/**
 * Dos herramientas, una superficie: la carga masiva parte del listado crudo
 * (1,500 filas reales) y deja solo excepciones; la plantilla curada sigue
 * disponible para cargas estructuradas por línea de producto.
 */
export function ImportacionesTabs() {
  const [tab, setTab] = useState<"masiva" | "plantilla">("masiva");
  return (
    <div className="import-flow">
      <div className="bulk-tabs" role="tablist" aria-label="Modo de importación">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "masiva"}
          className={tab === "masiva" ? "bulk-tab bulk-tab--active" : "bulk-tab"}
          onClick={() => setTab("masiva")}
        >
          Carga masiva (listado real)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plantilla"}
          className={tab === "plantilla" ? "bulk-tab bulk-tab--active" : "bulk-tab"}
          onClick={() => setTab("plantilla")}
        >
          Plantilla curada
        </button>
      </div>
      {tab === "masiva" ? <CatalogBulkImportView /> : <CatalogImportView />}
    </div>
  );
}
