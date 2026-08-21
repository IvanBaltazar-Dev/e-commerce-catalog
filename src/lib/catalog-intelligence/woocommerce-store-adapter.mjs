/**
 * Adaptador genérico para la Store API de WooCommerce.
 *
 * Genérico de verdad: no sabe qué es Cherimoya. Lee lo que la plataforma publica
 * y lo entrega literal. Cherimoya es su primera campaña, no su motivo.
 *
 * ── Por qué hacía falta ─────────────────────────────────────────────────────
 *
 * Cherimoya se estaba ingiriendo con lógica pensada para Shopify, y el resultado
 * parecía una fuente pobre:
 *
 *   tono          0%      porque se buscaba partiendo el título por « - »
 *   línea         0%      porque se buscaba en tags con vocabulario de esmalte
 *   acabado       0%      ídem
 *   presentación 40%      porque se buscaba con un regex en el título
 *
 * Pero la Store API publica atributos estructurados. En una sola página de 100
 * fichas aparecen: Medidas, CONTENIDO, Tonos, Contenido, Color, Tipo, Tamaño,
 * Peso, Material de Gabinetes, Material de Puerta, Cantidad, Aroma, Tipo de Piel.
 * «Tonos» trae sus términos (001, 002, 005…) y las variaciones dicen sobre qué
 * eje varían. Nada de eso hacía falta deducirlo del nombre.
 *
 * ── Dos cosas que la API declara y la ingesta anterior ignoraba ─────────────
 *
 *   currency_minor_unit: 2   el precio «1800» son 18,00 y no 1.800. Los precios
 *                            guardados de Cherimoya promedian 2.185 y llegan a
 *                            200.000: son céntimos leídos como soles.
 *
 *   type / variation         un producto «variable» y sus variaciones son cosas
 *                            distintas. Aplanarlas convertiría cada tono en un
 *                            producto suelto.
 */

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reintento solo en lo temporal. Un 404 es una respuesta, no un fallo. */
async function pedir(url, { ua, esperas = [2000, 6000, 15000] } = {}) {
  let ultimo = null;
  for (let intento = 0; intento <= esperas.length; intento += 1) {
    try {
      const r = await fetch(url, { headers: { "user-agent": ua, accept: "application/json" }, signal: AbortSignal.timeout(45000) });
      ultimo = r.status;
      if (r.ok) return { ok: true, status: r.status, cuerpo: await r.text(), cabeceras: r.headers };
      if (r.status === 404 || r.status === 410) return { ok: false, status: r.status, ausente: true };
      if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 429) {
        return { ok: false, status: r.status, permanente: true };
      }
    } catch (e) { ultimo = ultimo ?? String(e?.name ?? e); }
    if (intento < esperas.length) await espera(esperas[intento]);
  }
  return { ok: false, status: ultimo, temporal: true };
}

/**
 * Convierte el precio de unidades menores a la unidad de la moneda.
 * La API lo declara; no se adivina ni se asume 2.
 */
export function precioReal(prices) {
  if (!prices || prices.price === null || prices.price === undefined) return null;
  const crudo = Number(prices.price);
  if (!Number.isFinite(crudo)) return null;
  const escala = Number(prices.currency_minor_unit);
  const divisor = Number.isFinite(escala) ? 10 ** escala : 1;
  return { importe: crudo / divisor, moneda: prices.currency_code ?? null, crudo, escala };
}

/**
 * Los atributos, tal como vienen. Sin interpretar el nombre: eso es una decisión
 * posterior y con regla declarada, no del crawler.
 */
export function atributosLiterales(producto) {
  return (producto.attributes ?? []).map((a) => ({
    nombre: a.name ?? null,
    taxonomia: a.taxonomy ?? null,
    tieneVariaciones: Boolean(a.has_variations),
    terminos: (a.terms ?? []).map((t) => ({ nombre: t.name ?? null, slug: t.slug ?? null })),
  }));
}

/**
 * Descubre el catálogo entero paginando la Store API.
 *
 * El total lo declara la propia API en la cabecera X-WP-Total, así que hay un
 * testigo externo contra el que contrastar sin depender del sitemap.
 */
export async function descubrirCatalogoWooCommerce({ raiz, ua, porPagina = 100, pausaMs = 400, alProgresar = null }) {
  const base = raiz.replace(/\/$/, "");
  const endpoint = (pagina) => `${base}/wp-json/wc/store/v1/products?per_page=${porPagina}&page=${pagina}`;

  const primera = await pedir(endpoint(1), { ua });
  if (!primera.ok) throw new Error(`La Store API no respondió: ${primera.status}`);
  const declarado = Number(primera.cabeceras.get("x-wp-total"));
  const paginasDeclaradas = Math.ceil(declarado / porPagina);

  const productos = [];
  const paginasFallidas = [];
  const vistos = new Set();

  const absorber = (cuerpo, pagina) => {
    const lote = JSON.parse(cuerpo);
    for (const p of lote) {
      // La misma comprobación que el resto del proyecto: contar filas no basta.
      // Si la API repitiera un id entre páginas, aquí se ve.
      if (vistos.has(p.id)) continue;
      vistos.add(p.id);
      productos.push(p);
    }
    return lote.length;
  };

  let n = absorber(primera.cuerpo, 1);
  for (let pagina = 2; pagina <= paginasDeclaradas && n > 0; pagina += 1) {
    await espera(pausaMs);
    const r = await pedir(endpoint(pagina), { ua });
    if (!r.ok) { paginasFallidas.push({ pagina, status: r.status, clase: r.permanente ? "PERMANENT_ERROR" : "TEMPORARY_ERROR_PENDING" }); continue; }
    n = absorber(r.cuerpo, pagina);
    if (alProgresar && pagina % 5 === 0) alProgresar({ pagina, productos: productos.length, declarado });
  }

  return {
    raiz: base,
    capturadoEn: new Date().toISOString(),
    declarado,
    productos,
    paginasFallidas,
    // Productos y variaciones separados desde el origen: aplanarlos aquí sería
    // irreversible más adelante.
    resumen: {
      simples: productos.filter((p) => p.type === "simple").length,
      variables: productos.filter((p) => p.type === "variable").length,
      otros: productos.filter((p) => !["simple", "variable"].includes(p.type)).length,
      conAtributos: productos.filter((p) => (p.attributes ?? []).length > 0).length,
      conVariaciones: productos.filter((p) => (p.variations ?? []).length > 0).length,
      variacionesTotales: productos.reduce((a, p) => a + (p.variations ?? []).length, 0),
      conSku: productos.filter((p) => p.sku).length,
      imagenes: productos.reduce((a, p) => a + (p.images ?? []).length, 0),
      categoriasDistintas: new Set(productos.flatMap((p) => (p.categories ?? []).map((c) => c.id))).size,
      atributosDistintos: new Set(productos.flatMap((p) => (p.attributes ?? []).map((a) => a.name))).size,
    },
  };
}

/**
 * El namespace de ingestión. Existe para nombrar lo que la plataforma publica y
 * MUERE en la frontera: nada de esto entra en catalog_source_predicate_authority.
 * Es exactamente la lección de official.* — si un crawler mete su vocabulario en
 * la autoridad, mañana hay uno por extractor.
 */
export const CAMPOS_DE_INGESTION = [
  "woocommerce.id", "woocommerce.name", "woocommerce.slug", "woocommerce.permalink",
  "woocommerce.sku", "woocommerce.type", "woocommerce.parent", "woocommerce.description",
  "woocommerce.short_description", "woocommerce.categories", "woocommerce.tags",
  "woocommerce.brands", "woocommerce.attributes", "woocommerce.variations",
  "woocommerce.images", "woocommerce.prices", "woocommerce.is_in_stock",
  "woocommerce.stock_availability",
];
