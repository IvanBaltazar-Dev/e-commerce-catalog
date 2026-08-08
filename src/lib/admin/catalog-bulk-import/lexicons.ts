// Léxicos de la normalización. Solo conocimiento verificable: los hex existen
// únicamente para palabras de color estándar (swatch honesto); los tonos de
// fantasía jamás reciben color inventado.

export type ColorEntry = {
  /** Palabra tal como aparece en el Excel (mayúsculas, sin tildes obligatorias). */
  token: string;
  label: string;
  colorFamilyValue: string;
  hex: string | null;
};

export const COLOR_LEXICON: ColorEntry[] = [
  { token: "NEGRO", label: "Negro", colorFamilyValue: "negros-grises", hex: "#1c1c1c" },
  { token: "NEGRA", label: "Negro", colorFamilyValue: "negros-grises", hex: "#1c1c1c" },
  { token: "BLANCO", label: "Blanco", colorFamilyValue: "blancos", hex: "#f5f5f5" },
  { token: "BLANCA", label: "Blanco", colorFamilyValue: "blancos", hex: "#f5f5f5" },
  { token: "ROJO", label: "Rojo", colorFamilyValue: "rojos", hex: "#c0392b" },
  { token: "ROJA", label: "Rojo", colorFamilyValue: "rojos", hex: "#c0392b" },
  { token: "ROSA", label: "Rosa", colorFamilyValue: "rosados", hex: "#e91e63" },
  { token: "ROSADO", label: "Rosado", colorFamilyValue: "rosados", hex: "#f06292" },
  { token: "ROSADA", label: "Rosado", colorFamilyValue: "rosados", hex: "#f06292" },
  { token: "FUCSIA", label: "Fucsia", colorFamilyValue: "rosados", hex: "#d5006d" },
  { token: "AZUL", label: "Azul", colorFamilyValue: "azules", hex: "#1565c0" },
  { token: "CELESTE", label: "Celeste", colorFamilyValue: "azules", hex: "#64b5f6" },
  { token: "VERDE", label: "Verde", colorFamilyValue: "verdes", hex: "#2e7d32" },
  { token: "MORADO", label: "Morado", colorFamilyValue: "morados", hex: "#6a1b9a" },
  { token: "MORADA", label: "Morado", colorFamilyValue: "morados", hex: "#6a1b9a" },
  { token: "LILA", label: "Lila", colorFamilyValue: "morados", hex: "#b39ddb" },
  { token: "VIOLETA", label: "Violeta", colorFamilyValue: "morados", hex: "#7b1fa2" },
  { token: "AMARILLO", label: "Amarillo", colorFamilyValue: "amarillos-dorados", hex: "#f9a825" },
  { token: "AMARILLA", label: "Amarillo", colorFamilyValue: "amarillos-dorados", hex: "#f9a825" },
  { token: "DORADO", label: "Dorado", colorFamilyValue: "amarillos-dorados", hex: "#c9a227" },
  { token: "DORADA", label: "Dorado", colorFamilyValue: "amarillos-dorados", hex: "#c9a227" },
  { token: "NARANJA", label: "Naranja", colorFamilyValue: "naranjas-corales", hex: "#ef6c00" },
  { token: "CORAL", label: "Coral", colorFamilyValue: "naranjas-corales", hex: "#ff7043" },
  { token: "MARRON", label: "Marrón", colorFamilyValue: "marrones", hex: "#6d4c41" },
  { token: "MARRÓN", label: "Marrón", colorFamilyValue: "marrones", hex: "#6d4c41" },
  { token: "CAFE", label: "Café", colorFamilyValue: "marrones", hex: "#5d4037" },
  { token: "BEIGE", label: "Beige", colorFamilyValue: "nude", hex: "#d7ccc8" },
  { token: "NUDE", label: "Nude", colorFamilyValue: "nude", hex: "#e0c3a8" },
  { token: "NATURAL", label: "Natural", colorFamilyValue: "nude", hex: "#e8d5c4" },
  { token: "GRIS", label: "Gris", colorFamilyValue: "negros-grises", hex: "#9e9e9e" },
  { token: "PLATEADO", label: "Plateado", colorFamilyValue: "metalicos", hex: "#b0bec5" },
  { token: "PLATEADA", label: "Plateado", colorFamilyValue: "metalicos", hex: "#b0bec5" },
  { token: "PLATA", label: "Plata", colorFamilyValue: "metalicos", hex: "#b0bec5" },
  { token: "TRANSPARENTE", label: "Transparente", colorFamilyValue: "transparentes", hex: null },
  { token: "TRANS", label: "Transparente", colorFamilyValue: "transparentes", hex: null },
  { token: "CLEAR", label: "Transparente", colorFamilyValue: "transparentes", hex: null },
  { token: "TORNASOL", label: "Tornasol", colorFamilyValue: "multicolor", hex: null },
  { token: "HOLOGRAFICO", label: "Holográfico", colorFamilyValue: "multicolor", hex: null },
  { token: "MULTICOLOR", label: "Multicolor", colorFamilyValue: "multicolor", hex: null },
  { token: "COLORES", label: "Colores surtidos", colorFamilyValue: "multicolor", hex: null },
  { token: "SURTIDO", label: "Surtido", colorFamilyValue: "multicolor", hex: null },
  { token: "PASTEL", label: "Pastel", colorFamilyValue: "multicolor", hex: null },
  { token: "NEON", label: "Neón", colorFamilyValue: "multicolor", hex: null },
  { token: "NEUTROS", label: "Neutros", colorFamilyValue: "nude", hex: null }
];

export const AROMA_LEXICON = [
  "MIEL", "CHOCOLATE", "MANZANA", "ALOE VERA", "GRANADA", "GRANATE", "COCO",
  "FRESA", "LAVANDA", "ROMERO", "MENTA", "EUCALIPTO", "VAINILLA", "ALMENDRA",
  "ARGAN", "ARGÁN", "KERATINA", "COLAGENO", "COLÁGENO", "AGUACATE", "PALTA",
  "LIMON", "LIMÓN", "NARANJA", "MARACUYA", "MARACUYÁ", "DURAZNO", "UVA",
  "CEREZA", "CANELA", "CAFE", "CAFÉ", "AZAHAR", "ROSAS", "TE VERDE", "KIWI",
  "BANANA", "PLATANO", "SANDIA", "SANDÍA", "MELON", "MELÓN", "BABA DE CARACOL"
];

export const SIZE_LEXICON = new Map<string, { value: string; label: string }>([
  ["XS", { value: "xs", label: "XS" }],
  ["S", { value: "s", label: "S" }],
  ["M", { value: "m", label: "M" }],
  ["L", { value: "l", label: "L" }],
  ["XL", { value: "xl", label: "XL" }],
  ["XXL", { value: "xxl", label: "XXL" }],
  ["SMALL", { value: "s", label: "S" }],
  ["MEDIUM", { value: "m", label: "M" }],
  ["LONG", { value: "l", label: "L" }],
  ["LARGE", { value: "l", label: "L" }],
  ["CHICO", { value: "s", label: "S" }],
  ["CHICA", { value: "s", label: "S" }],
  ["MEDIANO", { value: "m", label: "M" }],
  ["MEDIANA", { value: "m", label: "M" }],
  ["GRANDE", { value: "l", label: "L" }]
]);

export const SHAPE_LEXICON = new Map<string, { value: string; label: string }>([
  ["CUADRADA", { value: "cuadrada", label: "Cuadrada" }],
  ["CUADRADO", { value: "cuadrada", label: "Cuadrada" }],
  ["CUADR.", { value: "cuadrada", label: "Cuadrada" }],
  ["CUADR", { value: "cuadrada", label: "Cuadrada" }],
  ["ALMENDRA", { value: "almendra", label: "Almendra" }],
  ["STILETTO", { value: "stiletto", label: "Stiletto" }],
  ["COFFIN", { value: "coffin", label: "Coffin" }],
  ["BALLERINA", { value: "ballerina", label: "Ballerina" }],
  ["OVALADA", { value: "ovalada", label: "Ovalada" }],
  ["OVAL", { value: "ovalada", label: "Ovalada" }],
  ["REDONDA", { value: "redonda", label: "Redonda" }],
  ["FRANCESA", { value: "francesa", label: "Francesa" }],
  ["FRANCESAS", { value: "francesa", label: "Francesa" }]
]);

/** Sustantivos de producto: si la descripción contiene alguno, NO es un tono suelto. */
export const PRODUCT_NOUNS = [
  "ESMALTE", "BASE", "TOP", "GEL", "POLVO", "ACRILICO", "ACRÍLICO", "KIT",
  "PESTAÑA", "PESTANA", "CEJA", "CERA", "CREMA", "ACEITE", "SHAMPOO", "TINTE",
  "GUANTE", "TOALLA", "ALGODON", "ALGODÓN", "LIMA", "BUFFER", "PINCEL", "BROCHA",
  "CEPILLO", "PEINE", "TIJERA", "NAVAJA", "MAQUINA", "MÁQUINA", "PLANCHA",
  "SECADORA", "RIZADOR", "RIZADORA", "LAMPARA", "LÁMPARA", "TORNO", "DRILL",
  "BROCA", "FRESA", "MOLDE", "TIP", "TIPS", "UÑA", "UNA", "UÑAS", "ADORNO",
  "PIGMENTO", "DECORACION", "DECORACIÓN", "STICKER", "REMOVEDOR", "PRIMER",
  "DESHIDRATADOR", "MONOMERO", "MONÓMERO", "LIQUIDO", "LÍQUIDO", "ESPEJO",
  "MALETIN", "MALETÍN", "NECESER", "MOCHILA", "ORGANIZADOR", "CARRITO",
  "DISPENSADOR", "RECIPIENTE", "VASO", "BANDA", "PAPEL", "GORRO", "SUJETADOR",
  "GANCHITO", "GANCHO", "BORLA", "MOTA", "MASAJEADOR", "BOTAPELO", "ALUMINIO",
  "APLICADOR", "HOJA", "NAVAJERO", "TAJADOR", "DIFUSOR", "PEGAMENTO", "ADHESIVO",
  "SERUM", "SÉRUM", "MASCARILLA", "JABON", "JABÓN", "TONICO", "TÓNICO",
  "DELINEADOR", "SOMBRA", "LABIAL", "RUBOR", "ILUMINADOR", "CORRECTOR",
  "MAQUILLAJE", "BLISTER", "CINTA", "PAD", "PARCHE", "ESPONJA", "PIEDRA",
  "PULIDOR", "SEPARADOR", "EMPUJADOR", "CORTAUÑAS", "CORTAUNAS", "ALICATE",
  "SET", "PACK", "ESTUCHE", "CAJA", "EXHIBIDOR", "PRACTICA", "PRÁCTICA",
  "DEDO", "MANO", "SOPORTE", "ATOMIZADOR", "SPRAY", "LOCION", "LOCIÓN",
  "TALCO", "COLONIA", "AGUA", "ACETONA", "CLEANER", "LINTERNA", "FUNDIDOR",
  "OLLA", "CALENTADOR", "DEPILADOR", "RASTRILLO", "BIGOTERA", "HILO", "WIPES",
  "GASA", "CAMPO", "MANDIL", "MASCARILLAS", "GORRA", "TURBANTE", "VINCHA"
];

/** Ruido tipográfico que se limpia antes de cualquier comparación. */
export const NOISE_PATTERNS: Array<[RegExp, string]> = [
  [/[·°º]/g, ""],
  [/\s+/g, " "],
  [/\.{2,}/g, "."],
  [/\s*\/\s*/g, "/"]
];

export const PRESENTATION_PATTERN =
  /\b(?:X\s?\d+\s?(?:UND|PZAS?|PARES|SOBRES|PZA|P|U)?|\d+\s?(?:ML|MTS|MTR|GRS?|G|KG|OZ|UND|PZAS?|PARES|LT|L|W|MM|CM|MTS?)\.?)\b/gi;
