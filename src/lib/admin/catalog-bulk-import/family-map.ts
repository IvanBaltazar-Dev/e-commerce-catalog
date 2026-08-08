// Mapa familia → categoría/plantilla/ejes. Es la traducción DATA-driven de las
// 51 familias del listado real hacia el árbol de categorías y las plantillas
// que la 0049 dejó sembradas. La agrupación en variantes se apoya en estos ejes
// (que corresponden a attribute_definitions con is_variant_axis), nunca en
// reglas globales improvisadas.

import type { BulkAxisCode } from "@/lib/admin/catalog-bulk-import/types";

export type BulkFamilyConfig = {
  /** Valor EXACTO de «Familia propuesta» en el Excel. */
  familia: string;
  rootSlug: string;
  categorySlug: string;
  templateCode: string;
  /**
   * Ejes de variante que esta familia admite, en orden de prioridad de
   * detección. La normalización solo agrupa filas como variantes cuando la
   * diferencia entre descripciones se explica por uno de estos ejes.
   */
  axes: BulkAxisCode[];
  /**
   * true cuando la familia sigue el patrón «la descripción ES el nombre del
   * tono» (ADMISS/MASGLO): filas sin sustantivo de producto se agrupan como
   * tonos del producto base de la marca.
   */
  bareDescriptionIsTone?: boolean;
  /** Nombre del producto agrupador cuando bareDescriptionIsTone aplica. */
  productNoun?: string;
};

export const BULK_FAMILY_MAP: BulkFamilyConfig[] = [
  // --- Uñas, manicure y pedicure -----------------------------------------
  { familia: "Esmaltes tradicionales y gel", rootSlug: "unas", categorySlug: "esmaltes", templateCode: "ESMALTE_TONOS", axes: ["tone", "color", "presentation"], bareDescriptionIsTone: true, productNoun: "Esmalte" },
  { familia: "Bases, tops, brillos y finalizadores", rootSlug: "unas", categorySlug: "bases-y-tops", templateCode: "ESMALTE_TONOS", axes: ["tone", "color", "presentation"] },
  { familia: "Sistema acrílico: polvos y monómeros", rootSlug: "unas", categorySlug: "sistema-acrilico", templateCode: "SISTEMA_UNAS", axes: ["set_name", "color", "presentation"] },
  { familia: "Polygel, gel constructor y soluciones", rootSlug: "unas", categorySlug: "polygel-constructor", templateCode: "SISTEMA_UNAS", axes: ["color", "set_name", "presentation"] },
  { familia: "Soft gel, press gel y adhesivos para uñas", rootSlug: "unas", categorySlug: "soft-gel-adhesivos", templateCode: "SISTEMA_UNAS", axes: ["color", "presentation"] },
  { familia: "Preparadores y adherencia", rootSlug: "unas", categorySlug: "preparadores-adherencia", templateCode: "SISTEMA_UNAS", axes: ["presentation"] },
  { familia: "Remoción y limpieza química", rootSlug: "unas", categorySlug: "remocion-limpieza", templateCode: "SISTEMA_UNAS", axes: ["aroma", "presentation"] },
  { familia: "Press on y uñas decoradas", rootSlug: "unas", categorySlug: "press-on", templateCode: "PRESS_ON_DECORADO", axes: ["set_name", "shape", "color", "presentation"] },
  { familia: "Tips, dual system y uñas para extensión", rootSlug: "unas", categorySlug: "tips-dual-system", templateCode: "PRESS_ON_DECORADO", axes: ["shape", "size_label", "presentation"] },
  { familia: "Decoración y nail art", rootSlug: "unas", categorySlug: "decoracion-nail-art", templateCode: "DECORACION_NAIL_ART", axes: ["color", "set_name", "presentation"] },
  { familia: "Pinceles y herramientas de diseño", rootSlug: "unas", categorySlug: "pinceles-diseno", templateCode: "HERRAMIENTA_BASICA", axes: ["size_label", "color", "presentation"] },
  { familia: "Herramientas de manicure y pedicure", rootSlug: "unas", categorySlug: "herramientas-manicure", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "size_label", "presentation"] },
  { familia: "Limas, buffers y pulido manual", rootSlug: "unas", categorySlug: "limas-buffers", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "presentation"] },
  { familia: "Cuidado de cutícula, manos y pies", rootSlug: "unas", categorySlug: "cuidado-cuticula", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation", "color"] },
  { familia: "Brocas y repuestos de drill", rootSlug: "unas", categorySlug: "brocas-repuestos", templateCode: "ACCESORIO_REPUESTO", axes: ["color", "presentation"] },
  { familia: "Drills, extractores y equipos", rootSlug: "equipos", categorySlug: "tornos", templateCode: "TORNO_ELECTRICO", axes: ["color"] },
  { familia: "Lámparas UV/LED y linternas", rootSlug: "equipos", categorySlug: "lamparas", templateCode: "LAMPARA", axes: ["color"] },
  { familia: "Moldes, práctica y exhibición", rootSlug: "unas", categorySlug: "moldes-exhibicion", templateCode: "ORGANIZACION_APOYO", axes: ["color", "presentation"] },
  { familia: "Recipientes y accesorios de trabajo", rootSlug: "unas", categorySlug: "recipientes-trabajo", templateCode: "ORGANIZACION_APOYO", axes: ["color", "size_label", "presentation"] },

  // --- Cejas y pestañas ---------------------------------------------------
  { familia: "Extensiones profesionales 1x1/volumen", rootSlug: "pestanas", categorySlug: "extensiones-profesionales-v2", templateCode: "EXTENSIONES_PRO", axes: ["lash_length", "size_label", "presentation"] },
  { familia: "Pestañas en tira, banda y magnéticas", rootSlug: "pestanas", categorySlug: "pestanas-en-tira", templateCode: "PESTANA_TIRA", axes: ["set_name", "presentation"] },
  { familia: "Adhesivos, removedores y preparadores", rootSlug: "pestanas", categorySlug: "adhesivos-profesionales", templateCode: "ADHESIVO_PRO", axes: ["color", "presentation"] },
  { familia: "Diseño, tinturación y mapeo de cejas", rootSlug: "pestanas", categorySlug: "cejas-diseno", templateCode: "PRODUCTO_COSMETICO", axes: ["tone", "color", "presentation"] },
  { familia: "Lifting, rizado y laminado", rootSlug: "pestanas", categorySlug: "lifting-laminado", templateCode: "PRODUCTO_COSMETICO", axes: ["presentation"] },
  { familia: "Herramientas y consumibles para pestañas", rootSlug: "pestanas", categorySlug: "herramientas-pestanas", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "presentation"] },
  { familia: "Rizadores de pestañas y repuestos", rootSlug: "pestanas", categorySlug: "rizadores-pestanas", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "presentation"] },

  // --- Cabello y barbería -------------------------------------------------
  { familia: "Accesorios y protección de peluquería", rootSlug: "barberia-cabello", categorySlug: "accesorios-peluqueria", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "presentation"] },
  { familia: "Cepillos y peines", rootSlug: "barberia-cabello", categorySlug: "cepillos-y-peines", templateCode: "HERRAMIENTA_BASICA", axes: ["color", "set_name", "presentation"] },
  { familia: "Coloración y procesos químicos", rootSlug: "barberia-cabello", categorySlug: "coloracion-quimicos", templateCode: "PRODUCTO_COSMETICO", axes: ["tone", "color", "presentation"] },
  { familia: "Tratamiento, lavado y estilizado", rootSlug: "barberia-cabello", categorySlug: "tratamiento-capilar", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation"] },
  { familia: "Planchas, rizadores, secadoras y cepillos eléctricos", rootSlug: "barberia-cabello", categorySlug: "planchas-secadoras", templateCode: "EQUIPO_ELECTRICO", axes: ["color", "presentation"] },
  { familia: "Máquinas de corte y afeitado", rootSlug: "barberia-cabello", categorySlug: "maquinas-de-corte", templateCode: "MAQUINA_CORTE", axes: ["color", "presentation"] },
  { familia: "Tijeras, navajas y herramientas", rootSlug: "barberia-cabello", categorySlug: "tijeras-navajas", templateCode: "HERRAMIENTA_BASICA", axes: ["size_label", "color", "presentation"] },
  { familia: "Desinfección y mantenimiento de máquinas", rootSlug: "barberia-cabello", categorySlug: "desinfeccion-maquinas", templateCode: "PRODUCTO_COSMETICO", axes: ["presentation"] },

  // --- Depilación -----------------------------------------------------------
  { familia: "Ceras depilatorias", rootSlug: "depilacion", categorySlug: "ceras-depilatorias", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation"] },
  { familia: "Cremas depilatorias", rootSlug: "depilacion", categorySlug: "cremas-depilatorias", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation"] },
  { familia: "Bandas y consumibles", rootSlug: "depilacion", categorySlug: "bandas-consumibles", templateCode: "CONSUMIBLE_BASICO", axes: ["presentation"] },
  { familia: "Equipos para cera", rootSlug: "depilacion", categorySlug: "equipos-cera", templateCode: "EQUIPO_ELECTRICO", axes: ["color", "presentation"] },

  // --- Rostro, cuerpo y maquillaje -----------------------------------------
  { familia: "Cuidado facial", rootSlug: "rostro-cuerpo-maquillaje", categorySlug: "cuidado-facial", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation", "color"] },
  { familia: "Cuidado corporal, manos y pies", rootSlug: "rostro-cuerpo-maquillaje", categorySlug: "cuidado-corporal", templateCode: "PRODUCTO_COSMETICO", axes: ["aroma", "presentation", "color"] },
  { familia: "Maquillaje de ojos y rostro", rootSlug: "rostro-cuerpo-maquillaje", categorySlug: "maquillaje", templateCode: "PRODUCTO_COSMETICO", axes: ["tone", "color", "set_name", "presentation"] },
  { familia: "Labios", rootSlug: "rostro-cuerpo-maquillaje", categorySlug: "labios", templateCode: "PRODUCTO_COSMETICO", axes: ["tone", "color", "presentation"] },
  { familia: "Espejos y accesorios personales", rootSlug: "rostro-cuerpo-maquillaje", categorySlug: "espejos-accesorios", templateCode: "ORGANIZACION_APOYO", axes: ["color", "size_label", "presentation"] },

  // --- Higiene y consumibles generales --------------------------------------
  { familia: "Algodón, gasas y wipes", rootSlug: "higiene-consumibles", categorySlug: "algodon-gasas", templateCode: "CONSUMIBLE_BASICO", axes: ["presentation"] },
  { familia: "Campos, toallas y desechables", rootSlug: "higiene-consumibles", categorySlug: "toallas-desechables", templateCode: "CONSUMIBLE_BASICO", axes: ["color", "presentation"] },
  { familia: "Guantes y protección", rootSlug: "higiene-consumibles", categorySlug: "guantes-proteccion", templateCode: "CONSUMIBLE_BASICO", axes: ["size_label", "color", "presentation"] },
  { familia: "Sanitización y esterilización", rootSlug: "higiene-consumibles", categorySlug: "sanitizacion-esterilizacion", templateCode: "CONSUMIBLE_BASICO", axes: ["presentation"] },
  { familia: "Dispensadores y recipientes generales", rootSlug: "higiene-consumibles", categorySlug: "dispensadores", templateCode: "ORGANIZACION_APOYO", axes: ["color", "size_label", "presentation"] },

  // --- Organización, mobiliario y apoyo -------------------------------------
  { familia: "Maletines, neceseres y mochilas", rootSlug: "organizacion-apoyo", categorySlug: "maletines", templateCode: "ORGANIZACION_APOYO", axes: ["color", "size_label", "presentation"] },
  { familia: "Organizadores y carros auxiliares", rootSlug: "organizacion-apoyo", categorySlug: "organizadores", templateCode: "ORGANIZACION_APOYO", axes: ["color", "presentation"] },
  { familia: "Lámparas de mesa e iluminación", rootSlug: "organizacion-apoyo", categorySlug: "lamparas-mesa", templateCode: "EQUIPO_ELECTRICO", axes: ["color", "presentation"] }
];

const CONFIG_BY_FAMILIA = new Map(BULK_FAMILY_MAP.map((config) => [config.familia.toLowerCase(), config]));

/** «Pendiente de clasificación / Revisión manual» no tiene config: fuerza revisión. */
export function bulkFamilyConfig(familia: string | null): BulkFamilyConfig | null {
  if (!familia) return null;
  return CONFIG_BY_FAMILIA.get(familia.trim().toLowerCase()) ?? null;
}

export function bulkFamilyCategoryPath(config: BulkFamilyConfig): string {
  return `${config.rootSlug}/${config.categorySlug}`;
}
