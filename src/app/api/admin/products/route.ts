import { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError, ok, readJson, created } from "@/lib/api/http";
import { requireAdmin } from "@/lib/auth/admin";
import { createProduct, PRODUCT_SELECT } from "@/lib/catalog/product-service";
import { paginationSchema, productCreateSchema } from "@/lib/catalog/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const adminProductQuerySchema = paginationSchema.extend({
  active: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  // Estado editorial real: con 1,056 productos importados en borrador, un
  // filtro por is_active etiquetado «Publicado» mentía.
  estado: z.enum(["publicado", "borrador", "oculto"]).optional(),
  brandId: z.string().uuid().optional(),
  // Qué falta fotografiar es la pregunta que trae a la dueña a esta pantalla.
  // Se filtra en el contrato porque 1,048 productos sin foto no caben en la
  // página que está mirando.
  foto: z.enum(["con_foto", "solo_respaldo", "sin_foto"]).optional()
});

function parseSearchParams(request: NextRequest) {
  return adminProductQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
}

export async function GET(request: NextRequest) {
  try {
    const { supabase } = await requireAdmin();
    const params = parseSearchParams(request);

    // QUÉ productos y en qué orden lo decide el contrato, no esta ruta. Antes
    // buscaba con `.or(name.ilike, code.ilike, product_type.ilike)` desde aquí:
    // sin índice, sin quitar tildes —«lámpara» no encontraba «lampara»— y con
    // reglas distintas a las del POS y el catálogo. Una superficie de búsqueda
    // sin contrato no puede cumplir una regla que vive en el contrato.
    const { data: busqueda, error: errorBusqueda } = await supabase.rpc("admin_product_search", {
      p_query: params.q ?? null,
      p_estado: params.estado ?? null,
      p_active: params.active ?? null,
      p_brand_id: params.brandId ?? null,
      p_limit: params.limit,
      p_offset: params.offset,
      p_foto: params.foto ?? null
    });

    if (errorBusqueda) {
      throw errorBusqueda;
    }

    const ids: string[] = busqueda?.ids ?? [];
    const total: number = busqueda?.total ?? 0;
    const cobertura = busqueda?.cobertura ?? { con_foto: 0, solo_respaldo: 0, sin_foto: 0 };
    const publicacion = busqueda?.publicacion ?? { publicado: 0, borrador: 0, oculto: 0 };

    if (ids.length === 0) {
      return ok({ items: [], total, cobertura, publicacion, limit: params.limit, offset: params.offset });
    }

    // La forma anidada —marca, categoría, galería— la construye PostgREST, que
    // ya sabe hacerlo. La lista de ids está acotada al tamaño de la página.
    const { data, error } = await supabase.from("products").select(PRODUCT_SELECT).in("id", ids);

    if (error) {
      throw error;
    }

    // El estado fotográfico viene en la misma respuesta que los ids. Pedirlo
    // aparte costaba entre 1,5 y 2,6 s: PostgREST no empuja el filtro por id
    // dentro de una vista y materializaba los 1.051 productos para devolver 8.
    const media: Record<string, unknown> = busqueda?.media ?? {};

    // PostgREST no garantiza el orden de un `in`, y el orden es del contrato.
    const porId = new Map((data ?? []).map((product) => [product.id, product]));

    return ok({
      items: ids
        .map((id) => {
          const product = porId.get(id);
          return product ? { ...product, media_state: media[id] } : undefined;
        })
        .filter(Boolean),
      total,
      cobertura,
      publicacion,
      limit: params.limit,
      offset: params.offset
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { supabase } = await requireAdmin();
    const input = await readJson(request, productCreateSchema);
    const product = await createProduct(supabase, input);

    return created(product);
  } catch (error) {
    return handleApiError(error);
  }
}
