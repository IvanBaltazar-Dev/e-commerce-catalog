import { created, handleApiError, HttpError, ok, readJson } from "@/lib/api/http";
import { requireStaff } from "@/lib/auth/admin";
import { createReservationSchema, type Reservation } from "@/lib/admin/sales";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ReservationRow = {
  id: string;
  reservation_number: string;
  branch_id: string;
  status: Reservation["status"];
  customer_name: string;
  customer_phone: string | null;
  expires_at: string;
  total: number;
  created_at: string;
};

export async function GET(request: Request) {
  try {
    const { supabase } = await requireStaff();
    const url = new URL(request.url);
    const status = url.searchParams.get("status");

    let query = supabase
      .from("reservations")
      .select("id, reservation_number, branch_id, status, customer_name, customer_phone, expires_at, total, created_at")
      .order("created_at", { ascending: false })
      .limit(100);

    if (status) query = query.eq("status", status);

    const { data, error } = await query;
    if (error) throw new HttpError(400, "reservations_list_failed", error.message);

    return ok({
      items: (data as ReservationRow[]).map((row) => ({
        id: row.id,
        reservationNumber: row.reservation_number,
        branchId: row.branch_id,
        status: row.status,
        customerName: row.customer_name,
        customerPhone: row.customer_phone,
        expiresAt: row.expires_at,
        total: Number(row.total),
        createdAt: row.created_at
      }))
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const input = await readJson(request, createReservationSchema);
    const { supabase } = await requireStaff();

    // Una reserva NO disminuye on_hand: incrementa reserved. La disponibilidad
    // efectiva es on_hand - reserved, y la valida create_reservation.
    const { data, error } = await supabase.rpc("create_reservation", {
      p_branch_id: input.branchId,
      p_lines: input.lines,
      p_customer: input.customer,
      p_expires_at: input.expiresAt,
      p_client_operation_id: input.clientOperationId,
      p_advance: input.advance ?? null,
      p_notes: input.notes ?? null,
      // La clienta enlazada, cuando la hay. Los campos customer_* siguen siendo
      // la instantánea de cómo se escribió su nombre al reservar.
      p_person_id: input.personId ?? null
    });

    if (error) throw new HttpError(400, "reservation_create_failed", error.message);

    return created(data as Reservation);
  } catch (error) {
    return handleApiError(error);
  }
}
