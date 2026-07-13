// Fuente única de verdad del catálogo (datos del BRIEF_CATALOGO_BELLAROSHE.md).
// Usado por optimize-assets.mjs y build-catalog.mjs.

export const STORE = {
  brand: "Bellaroshé",
  legalName: "Importaciones Bellaroshé",
  tagline: "Catálogo Beauty Premium",
  subtitle: "Esmaltes & Gel · Belleza profesional",
  city: "Lima, Perú",
  whatsapp: "+51 963 463 550",
  whatsappLink: "51963463550",
  updatedLabel: "Julio 2026",
  wholesaleFrom: 3,
  notice:
    "Precios, tonos disponibles y stock se confirman por WhatsApp. Precio por mayor desde 3 unidades.",
};

// lamp: "no" | "si" | "uvled"
// chart: "available" | "consult"
export const PRODUCTS = [
  {
    order: 1,
    folder: "01-masglo-tradicional",
    slug: "masglo-tradicional",
    brand: "Masglo",
    line: "Tradicional",
    presentation: "13.5 ml",
    type: "Esmalte tradicional",
    lamp: "no",
    unit: 11,
    wholesale: 9.5,
    chart: "available",
    description:
      "Línea clásica para manicura tradicional: tonos elegantes, básicos y profesionales con un acabado impecable y duradero.",
  },
  {
    order: 2,
    folder: "02-masglo-gel-evolution-gel-sin-lampara",
    slug: "masglo-gel-evolution",
    brand: "Masglo",
    line: "Gel Evolution",
    presentation: "13.5 ml",
    type: "Efecto gel sin lámpara",
    lamp: "no",
    unit: 15.5,
    wholesale: 14.5,
    chart: "available",
    description:
      "Acabado tipo gel con brillo intenso y secado práctico, sin necesidad de lámpara. Resultado profesional en casa.",
  },
  {
    order: 3,
    folder: "03-masglo-gel-polish-7ml",
    slug: "masglo-gel-polish-7ml",
    brand: "Masglo",
    line: "Gel Polish",
    presentation: "7 ml",
    type: "Gel semipermanente",
    lamp: "si",
    unit: 15,
    wholesale: 14,
    chart: "available",
    description:
      "Gel semipermanente de alta gama: colores sólidos, cobertura perfecta y brillo espejo de larga duración.",
  },
  {
    order: 4,
    folder: "04-masglo-gel-polish-14ml",
    slug: "masglo-gel-polish-14ml",
    brand: "Masglo",
    line: "Gel Polish",
    presentation: "14 ml",
    type: "Gel semipermanente",
    lamp: "uvled",
    unit: 30,
    wholesale: 27.5,
    chart: "available",
    description:
      "Presentación profesional de 14 ml. Máximo rendimiento, pigmentación premium y acabado de salón.",
  },
  {
    order: 5,
    folder: "05-admiss-tradicional",
    slug: "admiss-tradicional",
    brand: "Admiss",
    line: "Tradicional",
    presentation: "10 ml",
    type: "Esmalte tradicional",
    lamp: "no",
    unit: 4.5,
    wholesale: 3.5,
    chart: "available",
    description:
      "Tonos modernos y variados para manicura tradicional. Ideal para venta por color a un excelente precio.",
  },
  {
    order: 6,
    folder: "06-cherimoya-gel-polish-8ml",
    slug: "cherimoya-gel-polish-8ml",
    brand: "Cherimoya",
    line: "Gel Polish",
    presentation: "8 ml",
    type: "Gel semipermanente",
    lamp: "uvled",
    unit: 9,
    wholesale: 7,
    chart: "available",
    description:
      "Presentación compacta para manicura profesional con acabado gel de larga duración y color vibrante.",
  },
  {
    order: 7,
    folder: "07-cherimoya-gel-polish-15ml",
    slug: "cherimoya-gel-polish-15ml",
    brand: "Cherimoya",
    line: "Gel Polish",
    presentation: "15 ml",
    type: "Gel semipermanente",
    lamp: "uvled",
    unit: 12.5,
    wholesale: 11,
    chart: "available",
    description:
      "Presentación de mayor rendimiento para uso frecuente en salón o por manicuristas profesionales.",
  },
  {
    order: 8,
    folder: "08-glam-nails-gel-polish-12ml",
    slug: "glam-nails-gel-polish-12ml",
    brand: "Glam Nails",
    line: "Gel Polish",
    presentation: "12 ml",
    type: "Gel semipermanente",
    lamp: "si",
    unit: 12.5,
    wholesale: 11,
    chart: "consult",
    description:
      "Tonos súper pigmentados con los mejores acabados profesionales. Amplia variedad de colores disponibles.",
  },
  {
    order: 9,
    folder: "09-mystyle-esmalte-en-gel-16ml",
    slug: "mystyle-esmalte-en-gel-16ml",
    brand: "Mystyle",
    line: "Esmalte en Gel",
    presentation: "16 ml",
    type: "Gel semipermanente",
    lamp: "si",
    unit: 11,
    wholesale: 9,
    chart: "available",
    featuredChart: true,
    description:
      "Línea surtida de colores variados, ideal para venta por unidad o set completo. Acabado gel brillante y uniforme.",
  },
  {
    order: 10,
    folder: "10-candy-secret-color-gel-15ml",
    slug: "candy-secret-color-gel-15ml",
    brand: "Candy Secret",
    line: "Color Gel",
    presentation: "15 ml",
    type: "Gel semipermanente",
    lamp: "si",
    unit: 6.5,
    wholesale: 5.5,
    chart: "available",
    description:
      "Tonos pasteles y de tendencia para diseños juveniles y profesionales. Color intenso, moderno y de larga duración.",
  },
  {
    order: 11,
    folder: "11-flower-secret-gel-polish-15ml",
    slug: "flower-secret-gel-polish-15ml",
    brand: "Flower Secret",
    line: "Gel Polish",
    presentation: "15 ml",
    type: "Gel semipermanente",
    lamp: "si",
    unit: 6.5,
    wholesale: 5.5,
    chart: "available",
    description:
      "Tonos femeninos y acabados modernos para manicura profesional, con una excelente relación calidad-precio.",
  },
];

export const PAYMENTS = ["yape", "plin", "bcp", "bbva", "interbank"];

export function lampLabel(lamp) {
  if (lamp === "no") return "No requiere lámpara";
  if (lamp === "uvled") return "Lámpara UV/LED";
  return "Requiere lámpara";
}

export function money(value) {
  return `S/ ${Number(value).toFixed(2).replace(/\.00$/, "")}`;
}
