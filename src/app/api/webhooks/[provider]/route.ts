import { NextResponse } from "next/server";
import { adapterFor } from "@/lib/channels/providers";
import { processChannelPayload } from "@/lib/channels/process";
import { stablePayloadId } from "@/lib/channels/adapter";
import { serverEnv } from "@/lib/env/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Borde de integración. La regla crítica: INSERT primero, procesar después.
 * Un webhook repetido —Meta reenvía ante cualquier timeout— muere en el índice
 * único de la base y responde 200 sin repetir trabajo. Un fallo de
 * procesamiento deja el evento en `failed` con reintento programado y responde
 * 200 igualmente: reintentar es NUESTRO trabajo, no del proveedor.
 */

/** Verificación de suscripción de Meta (hub.challenge). */
export async function GET(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const url = new URL(request.url);

  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected =
    provider === "whatsapp"
      ? serverEnv.WHATSAPP_VERIFY_TOKEN
      : serverEnv.META_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "verification_failed" }, { status: 403 });
}

export async function POST(request: Request, context: { params: Promise<{ provider: string }> }) {
  const { provider } = await context.params;
  const adapter = adapterFor(provider);

  if (!adapter) {
    return NextResponse.json({ error: "unknown_provider" }, { status: 404 });
  }

  const rawBody = await request.text();

  const verification = adapter.verifyWebhook(rawBody, request.headers);
  if (!verification.ok) {
    return NextResponse.json({ error: "invalid_signature", reason: verification.reason }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const service = createSupabaseServiceClient();

  // 1) INSERT PRIMERO. La identidad la fabrica el adaptador cuando el
  //    proveedor no la da: el hash del payload es estable entre reenvíos.
  const externalEventId = await stablePayloadId(payload);

  const { data: ingest, error: ingestError } = await service.rpc("ingest_webhook_event", {
    p_provider: adapter.provider,
    p_external_event_id: externalEventId,
    p_payload: payload
  });

  if (ingestError) {
    // Sin evento guardado no hay nada que reintentar: este es el único caso
    // en que se le pide al proveedor que reenvíe.
    return NextResponse.json({ error: "ingest_failed" }, { status: 500 });
  }

  const { eventId, duplicate } = ingest as { eventId: number; duplicate: boolean };

  if (duplicate) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  // 2) RECLAMO CONDICIONAL y procesamiento. Todo lo interno es idempotente:
  //    repetir el procesamiento entero no duplica mensajes ni conversaciones.
  const { data: claimed } = await service.rpc("claim_webhook_event", { p_event_id: eventId });

  if (!claimed) {
    return NextResponse.json({ received: true, claimed: false });
  }

  try {
    const summary = await processChannelPayload(service, adapter, payload);

    if (summary.messages + summary.statuses === 0) {
      await service.rpc("ignore_webhook_event", {
        p_event_id: eventId,
        p_reason: "Sin eventos reconocibles para este adaptador."
      });
    } else {
      await service.rpc("complete_webhook_event", { p_event_id: eventId, p_result: summary });
    }

    return NextResponse.json({ received: true, ...summary });
  } catch (error) {
    await service.rpc("fail_webhook_event", {
      p_event_id: eventId,
      p_error: error instanceof Error ? error.message : "Error de procesamiento.",
      p_retry_in: "5 minutes"
    });

    // 200 a propósito: el evento quedó guardado y el reintento es nuestro.
    return NextResponse.json({ received: true, deferred: true });
  }
}
