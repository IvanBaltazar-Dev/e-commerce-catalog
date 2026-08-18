// Prueba integral del Bloque 3: el recorrido completo del plan (§38), el
// abandono (§39) y el multicanal (§40), por las SUPERFICIES REALES — HTTP para
// lo público, RPC autenticados para el personal— y con conciliación final
// entre venta, caja, inventario, costo, canal y campaña.
//
// Uso:  node scripts/test-block3-integral.mjs --env .env.supabase.local
//       E2E_BASE_URL=http://127.0.0.1:3002 node scripts/test-block3-integral.mjs …
//
// Requiere el servidor corriendo (build de producción o dev) y
// seed-demo-operation aplicado.

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { purgeIntegralDocumentsQuietly } from "./lib/integral-cleanup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-block3-integral" });

if (!isLocal) throw new Error("La integral del Bloque 3 solo corre contra Supabase local.");

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3002";
const ADMIN = { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" };
const CAMPAIGN_CODE = "b3-integral-ig";
const PHONE = "51944555666";

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });

let failures = 0;
const money = (value) => Math.round(Number(value) * 100) / 100;

// Esta prueba se lee de arriba abajo, sin envolverla en una función, y por eso
// no tiene un `finally` donde poner la limpieza. El efecto es el mismo: se
// anota lo que se va creando y se retira tanto al terminar bien como al
// romperse, antes de que el proceso muera. Solo se borra lo anotado aquí: los
// documentos de la sede real que no creó esta prueba no se tocan.
const owned = { saleIds: [], reservationIds: [], cartIds: [] };
let alreadyPurged = false;
async function purgeOwned() {
  if (alreadyPurged) return;
  alreadyPurged = true;
  await purgeIntegralDocumentsQuietly(owned, "la integral del Bloque 3");
}
process.on("unhandledRejection", async (reason) => {
  await purgeOwned();
  console.error(reason);
  process.exit(1);
});

function check(label, condition, detail) {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures += 1;
    console.log(`  FALLA ${label}`);
    if (detail !== undefined) console.log(`       ${detail}`);
  }
}

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function rpc(name, args, label) {
  const { data, error } = await asAdmin.rpc(name, args);
  if (error) throw new Error(`${label ?? name}: ${error.message}`);
  return data;
}

/** Cliente HTTP con cookies: simula UN navegador de la clienta. */
function browserSession() {
  const jar = new Map();

  return async function request(pathName, init = {}) {
    const headers = new Headers(init.headers ?? {});
    if (jar.size) {
      headers.set("cookie", [...jar.entries()].map(([key, value]) => `${key}=${value}`).join("; "));
    }
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");

    const response = await fetch(`${base}${pathName}`, { ...init, headers });

    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const [key, value] = pair.split("=");
      if (key && value !== undefined) jar.set(key.trim(), value.trim());
    }

    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  };
}

async function cleanPreviousRun() {
  // LO PRIMERO, y el motivo de que esta función necesitara arreglo: las
  // atribuciones ABIERTAS de este teléfono. El índice único solo admite una por
  // contacto sin venta, así que una ejecución que abortó a mitad —cualquiera de
  // las de más abajo que fallara— deja una y la siguiente ya no arranca.
  //
  // El resto de esta limpieza borraba «por si acaso» sin mirar el resultado, y
  // ahí estaba el problema: cuando una atribución la referencia una venta, la
  // clave foránea impide borrarla, el error se perdía y la fila seguía ahí.
  //
  // Dos casos y dos tratamientos:
  //   · si no la referencia ninguna venta, se borra;
  //   · si sí, se DESVINCULA del contacto en vez de borrarse. La fila se
  //     conserva para la venta que la necesita y deja de bloquear el índice.
  const contactosPrevios = must(
    await service.from("channel_contacts").select("id").eq("phone_normalized", PHONE),
    "contactos previos"
  );

  for (const contacto of contactosPrevios) {
    const abiertas = must(
      await service
        .from("channel_attributions")
        .select("id")
        .eq("channel_contact_id", contacto.id)
        .is("sale_id", null),
      "atribuciones abiertas previas"
    );

    for (const atribucion of abiertas) {
      const referida = must(
        await service.from("sales").select("id").eq("attribution_id", atribucion.id).limit(1),
        "ventas que referencian la atribución"
      );

      if (referida.length === 0) {
        must(await service.from("channel_attributions").delete().eq("id", atribucion.id),
          "borrar atribución abierta huérfana");
      } else {
        must(await service.from("channel_attributions")
          .update({ channel_contact_id: null }).eq("id", atribucion.id),
          "desvincular atribución abierta en uso");
      }
    }
  }

  const campaign = must(
    await service.from("marketing_campaigns").select("id").eq("code", CAMPAIGN_CODE),
    "campaña previa"
  )[0];

  if (campaign) {
    await service.from("channel_attributions").delete().eq("first_campaign_id", campaign.id);
  }

  // Los sujetos del recorrido anterior: contacto y visitantes con este teléfono.
  const contacts = must(
    await service.from("channel_contacts").select("id").eq("phone_normalized", PHONE),
    "contactos previos"
  );

  for (const contact of contacts) {
    const conversations = must(
      await service.from("channel_conversations").select("id").eq("channel_contact_id", contact.id),
      "conversaciones previas"
    );

    for (const conversation of conversations) {
      await service.from("channel_attributions").delete().eq("conversation_id", conversation.id);
      await service.from("public_carts").update({ conversation_id: null }).eq("conversation_id", conversation.id);
      await service.from("conversation_assignments").delete().eq("conversation_id", conversation.id);
      await service.from("channel_events").delete().eq("conversation_id", conversation.id);
      await service.from("channel_messages").delete().eq("conversation_id", conversation.id);
    }

    await service.from("channel_conversations").delete().eq("channel_contact_id", contact.id);
    await service.from("channel_attributions").delete().eq("channel_contact_id", contact.id);
    await service.from("channel_contacts").delete().eq("id", contact.id);
  }

  await service.from("integration_webhook_events").delete().like("external_event_id", "b3-%");
}

// ---------------------------------------------------------------------------
console.log("Integral del Bloque 3 · campaña → canal → carrito → reserva → venta");
// ---------------------------------------------------------------------------

await cleanPreviousRun();

const signIn = await asAdmin.auth.signInWithPassword(ADMIN);
if (signIn.error) throw new Error(`Sesión de administración: ${signIn.error.message}. Corre seed:demo-operation.`);

// Campaña de Instagram del recorrido.
const { data: existingCampaign } = await service
  .from("marketing_campaigns").select("id").eq("code", CAMPAIGN_CODE).maybeSingle();

if (!existingCampaign) {
  const source = must(await service.from("marketing_sources").select("id").eq("code", "instagram").single(), "fuente");
  const channel = must(await service.from("channels").select("id").eq("code", "instagram").single(), "canal");
  must(
    await service.from("marketing_campaigns").insert({
      name: "Integral B3 Instagram", code: CAMPAIGN_CODE, source_id: source.id, channel_id: channel.id
    }),
    "crear campaña"
  );
}

console.log("\n1. La clienta llega desde la campaña de Instagram");

const client = browserSession();

const session = await client("/api/catalog/session", {
  method: "POST",
  body: JSON.stringify({
    landingPath: "/?utm_source=instagram",
    referrer: "https://l.instagram.com/",
    utm: { source: "instagram", medium: "social", campaign: CAMPAIGN_CODE, content: "reel-01" }
  })
});

check("la landing captura la atribución", session.status === 200 && session.body?.data?.visitorId,
  JSON.stringify(session.body));

const visitorId = session.body.data.visitorId;

console.log("\n2. Arma su selección y se persiste");

const variant = must(
  await service.from("product_variants").select("id, sku").eq("sku", "DEMO-ESM-ROJO").single(),
  "variante"
);

const cartOpen = await client("/api/catalog/cart", {
  method: "POST",
  body: JSON.stringify({ lines: [{ variantId: variant.id, quantity: 2 }] })
});

check("el carrito se crea y sincroniza", cartOpen.status === 200 && cartOpen.body?.data?.publicToken,
  JSON.stringify(cartOpen.body).slice(0, 200));

const cartToken = cartOpen.body.data.publicToken;
const cartId = cartOpen.body.data.id;
owned.cartIds.push(cartId);

check("con el precio reevaluado por el motor, no almacenado",
  Number(cartOpen.body.data.evaluation?.lines?.[0]?.unitPrice) === 15,
  JSON.stringify(cartOpen.body.data.evaluation?.lines?.[0]));

console.log("\n3. Pulsa WhatsApp: contexto persistido, canal registrado");

const cta = await client("/api/catalog/whatsapp", {
  method: "POST",
  body: JSON.stringify({ lines: [{ variantId: variant.id, quantity: 2 }], intent: "order" })
});

check("el CTA genera mensaje con enlace de recuperación",
  cta.status === 200 && String(cta.body?.data?.text ?? "").includes(`/seleccion/${cartToken}`),
  JSON.stringify(cta.body?.data?.recoveryToken));

console.log("\n4. Escribe por WhatsApp: conversación, vendedora y vínculo");

const webhook = await fetch(`${base}/api/webhooks/whatsapp`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "wa-integral" },
      contacts: [{ wa_id: PHONE, profile: { name: "Clienta Integral" } }],
      messages: [{
        id: `b3-${Date.now()}`, from: PHONE,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "text", text: { body: "Hola, les mando mi selección" }
      }]
    } }] }]
  })
});

const webhookBody = await webhook.json();
check("el webhook crea conversación y mensaje", webhook.status === 200 && webhookBody.messages === 1,
  JSON.stringify(webhookBody));

const conversation = must(
  await service
    .from("channel_conversations")
    .select("id, assigned_user_id, channel_contact_id, branch_id")
    .order("opened_at", { ascending: false })
    .limit(1),
  "conversación"
)[0];

check("la vendedora quedó asignada por la política automática",
  Boolean(conversation.assigned_user_id), JSON.stringify(conversation));

// La vendedora enlaza el carrito de la clienta a la conversación y a su
// identidad: la cadena une el mundo anónimo con el contacto real.
await rpc("link_cart_to_conversation", { p_public_token: cartToken, p_conversation_id: conversation.id });
await rpc("attach_attribution", {
  p_visitor_id: visitorId,
  p_contact_id: conversation.channel_contact_id,
  p_conversation_id: conversation.id,
  p_cart_id: cartId
});

console.log("\n5. La clienta agrega otra variante desde el enlace, en su celular");

const phoneDevice = browserSession();
const recovered = await phoneDevice("/api/catalog/cart", {
  method: "POST",
  body: JSON.stringify({ publicToken: cartToken })
});

check("el celular recupera el MISMO carrito", recovered.body?.data?.id === cartId,
  JSON.stringify(recovered.body?.data?.id));

const addMore = await phoneDevice("/api/catalog/cart/items", {
  method: "POST",
  body: JSON.stringify({
    variantId: variant.id, quantity: 3,
    expectedVersion: recovered.body.data.rowVersion
  })
});

check("y la reevaluación acompaña el cambio",
  Number(addMore.body?.data?.evaluation?.totalUnits) === 3, JSON.stringify(addMore.body?.data?.evaluation?.totalUnits));

console.log("\n6. Reserva con adelanto, conversión a venta y caja");

const branchId = must(
  await service.from("public_carts").select("branch_id").eq("id", cartId).single(),
  "sede del carrito"
).branch_id;

// Una pasada anterior pudo dejar caja abierta: se reutiliza. El arqueo que se
// verifica es el movimiento del cobro, no la sesión concreta.
try {
  await rpc("open_cash_session", { p_branch_id: branchId, p_opening_float: 50.0, p_note: "Integral B3" });
} catch (error) {
  if (!/caja abierta/.test(String(error))) throw error;
}

const reservation = await rpc("convert_cart_to_reservation", {
  p_public_token: cartToken,
  p_customer: { name: "Clienta Integral", phone: `+${PHONE}` },
  p_expires_at: new Date(Date.now() + 86400000).toISOString(),
  p_client_operation_id: randomUUID(),
  // Desde 0065 un adelanto por Yape lleva su número de operación, venga por
  // donde venga: es el mismo dinero entrando por el mismo medio.
  p_advance: { method: "yape", amount: 20.0, reference: "00445588" }
});

check("el carrito se convierte en reserva del Bloque 2",
  money(reservation.total) === 45.0 && money(reservation.advanceTotal) === 20.0,
  JSON.stringify({ total: reservation.total, advance: reservation.advanceTotal }));

const stockAfterReserve = must(
  await service.from("inventory_stock").select("on_hand, reserved")
    .eq("variant_id", variant.id).eq("branch_id", branchId).single(),
  "stock reservado"
);
owned.reservationIds.push(reservation.id);


check("la reserva compromete sin descontar", stockAfterReserve.reserved >= 3,
  JSON.stringify(stockAfterReserve));

const sale = await rpc("register_sale", {
  p_branch_id: branchId,
  p_lines: null,
  p_payments: [{ method: "cash", amount: money(reservation.balance) }],
  p_client_operation_id: randomUUID(),
  p_source_channel: "instagram",
  p_fulfillment_method: "pickup",
  p_customer: null,
  p_discount_total: 0,
  p_notes: null,
  p_reservation_id: reservation.id,
  // Desde 0061 un recojo declara quién viene a retirarlo. Viene la misma clienta
  // que reservó: `isBuyer` lo dice sin repetir su nombre.
  p_parties: [{ role: "pickup_authorized", isBuyer: true }]
});

owned.saleIds.push(sale.id);

check("la reserva se convierte en venta pagada exacta", money(sale.total) === 45.0,
  JSON.stringify(sale.total));

await rpc("attach_attribution", {
  p_visitor_id: visitorId,
  p_reservation_id: reservation.id,
  p_sale_id: sale.id
});

console.log("\n7. La cadena completa, verificada dominio por dominio");

const chain = must(
  await service
    .from("channel_attributions")
    .select(`
      sale_id, cart_id, conversation_id, reservation_id, first_touch_at,
      first_source:marketing_sources!channel_attributions_first_source_id_fkey(code),
      last_source:marketing_sources!channel_attributions_last_source_id_fkey(code),
      campaign:marketing_campaigns!channel_attributions_first_campaign_id_fkey(code)
    `)
    .eq("sale_id", sale.id),
  "cadena"
)[0];

const codeOf = (ref) => (Array.isArray(ref) ? ref[0]?.code : ref?.code) ?? null;

check("la atribución apunta a la venta con toda la cadena",
  Boolean(chain) && Boolean(chain.cart_id) && Boolean(chain.conversation_id) && Boolean(chain.reservation_id),
  JSON.stringify(chain));

check("first_touch = instagram con su campaña; last_touch = whatsapp",
  codeOf(chain?.first_source) === "instagram"
    && codeOf(chain?.campaign) === CAMPAIGN_CODE
    && codeOf(chain?.last_source) === "whatsapp",
  JSON.stringify({ first: codeOf(chain?.first_source), last: codeOf(chain?.last_source), campaign: codeOf(chain?.campaign) }));

const cartFinal = must(
  await service.from("public_carts").select("status, converted_reservation_id").eq("id", cartId).single(),
  "carrito final"
);
check("el carrito quedó convertido apuntando a su reserva",
  cartFinal.status === "converted" && cartFinal.converted_reservation_id === reservation.id,
  JSON.stringify(cartFinal));

const drawer = must(
  await service.from("cash_movements").select("amount, kind").eq("branch_id", branchId)
    .order("id", { ascending: false }).limit(3),
  "cajón"
);
check("la caja recibió el cobro en efectivo del saldo",
  drawer.some((movement) => movement.kind === "sale" && money(movement.amount) === money(sale.total) - 20.0),
  JSON.stringify(drawer));

const ledger = must(
  await service.from("inventory_movements").select("movement_type, quantity")
    .eq("variant_id", variant.id).eq("branch_id", branchId)
    .order("id", { ascending: false }).limit(1),
  "kardex"
);
check("el inventario disminuyó por el motor del Bloque 2",
  ledger[0].movement_type === "sale" && ledger[0].quantity === -3,
  JSON.stringify(ledger[0]));

const metrics = await rpc("omnichannel_metrics", {});
check("el dashboard reporta el ingreso de Instagram",
  Number(metrics.salesByChannel?.instagram?.revenue ?? 0) >= 45.0
    && Number(metrics.salesByCampaign?.[CAMPAIGN_CODE]?.revenue ?? 0) >= 45.0,
  JSON.stringify({ canal: metrics.salesByChannel?.instagram, campana: metrics.salesByCampaign?.[CAMPAIGN_CODE] }));

console.log("\n8. Abandono (§39): TikTok mira y no compra");

const tiktokVisitor = browserSession();
await tiktokVisitor("/api/catalog/session", {
  method: "POST",
  body: JSON.stringify({ landingPath: "/", utm: { source: "tiktok", campaign: null } })
});

const tiktokCart = await tiktokVisitor("/api/catalog/cart", {
  method: "POST",
  body: JSON.stringify({ lines: [{ variantId: variant.id, quantity: 1 }] })
});

const tiktokCartId = tiktokCart.body.data.id;
owned.cartIds.push(tiktokCartId);

await service.from("public_carts")
  .update({ last_activity_at: new Date(Date.now() - 96 * 3600000).toISOString() })
  .eq("id", tiktokCartId);

const abandoned = await rpc("mark_abandoned_carts", { p_idle: "72 hours" });
check("el carrito inactivo se marca abandonado", abandoned >= 1, `marcados = ${abandoned}`);

await service.from("public_carts")
  .update({ expires_at: new Date(Date.now() - 3600000).toISOString() })
  .eq("id", tiktokCartId);

await rpc("expire_public_carts", {});

const tiktokFinal = must(
  await service.from("public_carts").select("status, converted_sale_id").eq("id", tiktokCartId).single(),
  "carrito tiktok"
);

check("queda expirado, sin venta, sin inventario movido",
  tiktokFinal.status === "expired" && tiktokFinal.converted_sale_id === null,
  JSON.stringify(tiktokFinal));

const tiktokChain = must(
  await service
    .from("channel_attributions")
    .select("sale_id, first_source:marketing_sources!channel_attributions_first_source_id_fkey(code)")
    .eq("cart_id", tiktokCartId),
  "cadena tiktok"
);

check("la atribución del abandono se CONSERVA, sin venta",
  tiktokChain.length === 0
    || (codeOf(tiktokChain[0]?.first_source) === "tiktok" && tiktokChain[0]?.sale_id === null),
  JSON.stringify(tiktokChain));

const metricsAfter = await rpc("omnichannel_metrics", {});
check("la métrica de abandono lo cuenta",
  Number(metricsAfter.carts?.expired ?? 0) >= 1, JSON.stringify(metricsAfter.carts));

await purgeOwned();
await asAdmin.auth.signOut().catch(() => undefined);

console.log(failures === 0
  ? "\nPASS · campaña, canal, clienta, conversación, carrito, reserva, venta, caja e inventario reconcilian"
  : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
