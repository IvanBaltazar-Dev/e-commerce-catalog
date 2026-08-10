import { z } from "zod";
import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const querySchema = z.object({
  q: z.string().trim().min(1).max(80)
});

const createSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  phone: z.string().trim().max(30).optional().nullable(),
  document: z.string().trim().max(20).optional().nullable()
});

/**
 * Buscar clienta desde el mostrador: un solo cuadro para nombre, celular o
 * documento. Quien vende no elige primero en qué campo va a buscar.
 *
 * Asociar una clienta es OPCIONAL y siempre lo será: la venta rápida se cobra
 * sin identificar a nadie. Esto existe para cuando sí hace falta —una reserva,
 * un delivery, una clienta con historial—, no como paso del flujo.
 */
export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const parsed = querySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries())
    );
    if (!parsed.success) {
      throw new HttpError(400, "invalid_query", parsed.error.issues[0]?.message ?? "Consulta inválida.");
    }

    const { data, error } = await supabase.rpc("pos_search_persons", {
      p_query: parsed.data.q,
      p_limit: 8
    });

    if (error) throw new HttpError(500, "person_search_failed", "No se pudo buscar la clienta.");

    return ok(data ?? []);
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Alta rápida desde la venta. Solo el nombre es obligatorio: pedir documento y
 * correo para poder cobrar es la fricción que este rediseño quita. Lo demás se
 * completa después, en la ficha de la clienta.
 */
export async function POST(request: Request) {
  try {
    const input = await readJson(request, createSchema);
    const { supabase, profile } = await requireStaff();

    const { data, error } = await supabase
      .from("persons")
      .insert({
        full_name: input.fullName,
        // La base normaliza el teléfono a su forma canónica; aquí solo se manda
        // lo que se tecleó.
        phone_normalized: input.phone?.trim() || null,
        document_number: input.document?.trim() || null,
        created_by: profile.id,
        created_by_label: profile.full_name
      })
      .select("id, full_name, phone_normalized, document_number")
      .single();

    if (error) throw new HttpError(400, "person_create_failed", error.message);

    return created({
      id: data.id,
      fullName: data.full_name,
      phone: data.phone_normalized,
      document: data.document_number
    });
  } catch (error) {
    return handleApiError(error);
  }
}
