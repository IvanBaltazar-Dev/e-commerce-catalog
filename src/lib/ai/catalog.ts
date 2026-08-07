import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogEntry } from "@/lib/ai/matching";

/**
 * El catálogo que la asistencia puede proponer: SOLO variantes activas de
 * productos activos, con su tono de biblioteca cuando existe. Es la lista
 * cerrada contra la que se puntúa todo — el asesor y el intérprete no pueden
 * recomendar nada que no esté aquí porque nunca ven otra cosa.
 */
export async function loadMatchingCatalog(
  supabase: SupabaseClient,
  options: { onlyAvailable?: boolean } = {}
): Promise<CatalogEntry[]> {
  const { data, error } = await supabase
    .from("product_variants")
    .select(`
      id, sku, name, availability_status, is_active,
      products!inner(
        id, name, availability, is_active,
        brands(name),
        categories(name)
      ),
      color_shades(name)
    `)
    .eq("is_active", true)
    .eq("products.is_active", true)
    .limit(600);

  if (error) {
    throw new Error(`No se pudo cargar el catálogo para la asistencia: ${error.message}`);
  }

  type Row = {
    id: string;
    sku: string | null;
    name: string;
    availability_status: string;
    products: {
      id: string;
      name: string;
      availability: string;
      brands: { name: string } | { name: string }[] | null;
      categories: { name: string } | { name: string }[] | null;
    };
    color_shades: { name: string } | { name: string }[] | null;
  };

  const one = <T,>(value: T | T[] | null): T | null => (Array.isArray(value) ? value[0] ?? null : value);

  const entries = ((data ?? []) as unknown as Row[]).map((row) => {
    const product = row.products;
    // «Disponible» excluye lo agotado; «consult» sigue siendo proponible
    // porque la venta real la valida el Bloque 2 contra stock de verdad.
    const available = row.availability_status !== "sold_out" && product.availability !== "sold_out";
    return {
      variantId: row.id,
      productId: product.id,
      sku: row.sku,
      productName: product.name,
      variantName: row.name,
      shadeName: one(row.color_shades)?.name ?? null,
      brandName: one(product.brands)?.name ?? null,
      categoryName: one(product.categories)?.name ?? null,
      available
    } satisfies CatalogEntry;
  });

  return options.onlyAvailable ? entries.filter((entry) => entry.available) : entries;
}
