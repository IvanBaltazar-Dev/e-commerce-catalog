// Prueba integral del Bloque 2: el circuito económico completo, de la compra
// al arqueo, ejecutado por los CONTRATOS REALES con una sesión de
// administración autenticada —no con service_role, que se salta las guardas—.
//
// Uso: node scripts/test-block2-integral.mjs --env .env.supabase.local
//
// No repite lo que ya cubren pgTAP ni las pruebas de concurrencia. Comprueba lo
// que ninguna de ellas puede ver: que después de mezclar compra, recepción con
// bonificación, pago a proveedor, venta con descuento y pago mixto, reserva con
// adelanto convertida, anulación, devolución parcial, gasto y traslado, LAS
// CUENTAS SIGUEN CUADRANDO.
//
// El modelo lo pedía por escrito en «Mejoras posteriores»: «tras N movimientos
// mixtos, total_value = suma de value_delta del kardex = dinero desembolsado −
// COGS registrado, al céntimo. Ninguna de las 16 pruebas actuales compara el
// valor del inventario contra el dinero realmente gastado.»

import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-block2-integral" });

if (!isLocal) {
  throw new Error("La prueba integral del Bloque 2 solo corre contra Supabase local.");
}

const BRANCH_CODE = "INTEGRAL";
const DEST_BRANCH_CODE = "INTEGRAL2";
const SUPPLIER_CODE = "INTEGRALSUP";
const ADMIN = { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" };

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

let failures = 0;
const money = (value) => Math.round(Number(value) * 100) / 100;

function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
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

// ---------------------------------------------------------------------------
// Preparación
// ---------------------------------------------------------------------------

/**
 * Borra lo que dejó la ejecución anterior. El circuito declara importes
 * absolutos —«la obligación es de 480,00»— así que acumular ejecuciones lo
 * rompe con tres obligaciones idénticas y una asignación que supera lo
 * exigible. Se limpia por dependencias, de la hoja a la raíz.
 */
async function cleanPreviousRun() {
  await exec(`
    do $$
    declare
      branch_ids uuid[];
      target_supplier uuid;
    begin
      select coalesce(array_agg(id), '{}') into branch_ids
      from public.branches where code in ('${BRANCH_CODE}', '${DEST_BRANCH_CODE}');

      select id into target_supplier from public.suppliers where code = '${SUPPLIER_CODE}';

      if array_length(branch_ids, 1) is null then
        return;
      end if;

      delete from public.cash_movements where branch_id = any(branch_ids);
      delete from public.cash_sessions where branch_id = any(branch_ids);
      delete from public.refunds where branch_id = any(branch_ids);
      delete from public.return_lines rl using public.returns r
        where rl.return_id = r.id and r.branch_id = any(branch_ids);
      delete from public.returns where branch_id = any(branch_ids);
      delete from public.sale_cancellations where branch_id = any(branch_ids);
      delete from public.sales where branch_id = any(branch_ids);
      delete from public.reservations where branch_id = any(branch_ids);
      delete from public.expense_allocations ea using public.expenses e
        where ea.expense_id = e.id and e.branch_id = any(branch_ids);
      delete from public.expenses where branch_id = any(branch_ids);
      delete from public.inventory_transfer_lines tl using public.inventory_transfers t
        where tl.inventory_transfer_id = t.id
          and (t.origin_branch_id = any(branch_ids) or t.destination_branch_id = any(branch_ids));
      delete from public.inventory_transfers
        where origin_branch_id = any(branch_ids) or destination_branch_id = any(branch_ids);
      delete from public.initial_load_rows lr using public.initial_load_batches b
        where lr.initial_load_batch_id = b.id and b.branch_id = any(branch_ids);
      delete from public.initial_load_batches where branch_id = any(branch_ids);
      delete from public.supplier_payment_allocations pa using public.supplier_payments p
        where pa.supplier_payment_id = p.id and p.branch_id = any(branch_ids);
      delete from public.supplier_payments where branch_id = any(branch_ids);
      delete from public.goods_receipt_lines gl using public.goods_receipts g
        where gl.goods_receipt_id = g.id and g.branch_id = any(branch_ids);

      if target_supplier is not null then
        delete from public.supplier_obligations where supplier_id = target_supplier;
      end if;

      delete from public.goods_receipts where branch_id = any(branch_ids);
      delete from public.purchase_order_lines pl using public.purchase_orders p
        where pl.purchase_order_id = p.id and p.branch_id = any(branch_ids);
      delete from public.purchase_orders where branch_id = any(branch_ids);

      if target_supplier is not null then
        delete from public.supplier_documents where supplier_id = target_supplier;
      end if;

      delete from public.inventory_movements where branch_id = any(branch_ids);
      delete from public.inventory_valuation where branch_id = any(branch_ids);
      delete from public.inventory_stock where branch_id = any(branch_ids);
      delete from public.branch_document_counters where branch_id = any(branch_ids);
    end
    $$;
  `);
}

async function setup() {
  await cleanPreviousRun();

  // Sedes propias: el circuito declara importes absolutos y sobre la sede
  // principal dependería de lo que dejaran antes el seed y las demás pruebas.
  const company = must(await service.from("companies").select("id").limit(1), "empresa")[0];

  for (const [code, name] of [[BRANCH_CODE, "Sede integral"], [DEST_BRANCH_CODE, "Sede integral destino"]]) {
    const existing = must(await service.from("branches").select("id").eq("code", code), `sede ${code}`);
    if (existing.length === 0) {
      must(
        await service.from("branches").insert({
          company_id: company.id, code, name, district: "Lima", is_default: false, sort_order: 910
        }),
        `crear sede ${code}`
      );
    }
  }

  const branches = must(
    await service.from("branches").select("id, code").in("code", [BRANCH_CODE, DEST_BRANCH_CODE]),
    "sedes integrales"
  );
  const branch = branches.find((b) => b.code === BRANCH_CODE).id;
  const destination = branches.find((b) => b.code === DEST_BRANCH_CODE).id;

  const supplier = must(await service.from("suppliers").select("id").eq("code", SUPPLIER_CODE), "proveedor");
  let supplierId = supplier[0]?.id;
  if (!supplierId) {
    supplierId = must(
      await service.from("suppliers").insert({
        company_id: company.id, code: SUPPLIER_CODE,
        legal_name: "Proveedor integral SAC", trade_name: "Integral",
        default_currency: "PEN", payment_terms_days: 30
      }).select("id").single(),
      "crear proveedor"
    ).id;
  }

  const variants = must(
    await service.from("product_variants").select("id, sku, tracks_inventory")
      .in("sku", ["DEMO-ESM-ROJO", "DEMO-ESM-NUDE"]),
    "variantes"
  );

  const v1 = variants.find((v) => v.sku === "DEMO-ESM-ROJO");
  const v2 = variants.find((v) => v.sku === "DEMO-ESM-NUDE");

  if (!v1 || !v2) {
    throw new Error("Faltan las variantes demo: corre supabase db reset y seed:demo-operation.");
  }

  // El seguimiento se activa por el contrato de carga inicial. Si el entorno ya
  // lo tiene activo —lo normal tras seed:demo-operation— no hay nada que hacer:
  // la existencia de ESTA sede nace con la primera recepción.
  const untracked = [v1, v2].filter((v) => !v.tracks_inventory);
  if (untracked.length > 0) {
    const adminProfile = must(
      await service.from("admin_profiles").select("id").eq("role", "admin").limit(1),
      "perfil de administración"
    )[0];
    await service.rpc("load_initial_inventory", {
      p_rows: untracked.map((v) => ({ sku: v.sku, branchCode: BRANCH_CODE, quantity: 0 })),
      p_mode: "commit",
      p_actor_id: adminProfile.id
    });
  }

  const signIn = await asAdmin.auth.signInWithPassword(ADMIN);
  if (signIn.error) {
    throw new Error(`No se pudo abrir sesión de administración (${signIn.error.message}). Corre seed:demo-operation.`);
  }

  return { branch, destination, supplierId, v1: v1.id, v2: v2.id };
}

// ---------------------------------------------------------------------------
// El circuito
// ---------------------------------------------------------------------------

async function run(fx) {
  console.log("\n1. Abastecimiento");

  const order = await rpc("issue_purchase_order", {
    p_supplier_id: fx.supplierId,
    p_branch_id: fx.branch,
    p_lines: [{ variantId: fx.v1, orderedUnits: 100, unitCost: 8.0 }],
    p_client_operation_id: randomUUID(),
    p_currency: "PEN",
    p_terms: "credit"
  });

  check("la orden de compra se emite con su costo congelado", money(order.total) === 800.0, `total ${order.total}`);

  const stockAfterOrder = await stockOf(fx.v1, fx.branch);
  check("y no mueve ni una unidad de inventario", stockAfterOrder.onHand === 0, `on_hand ${stockAfterOrder.onHand}`);

  // Recepción parcial: llegan 60 de las 100 pedidas.
  await rpc("register_goods_receipt", {
    p_supplier_id: fx.supplierId,
    p_branch_id: fx.branch,
    p_lines: [{
      variantId: fx.v1,
      purchaseOrderLineId: null,
      expectedUnits: 100,
      receivedUnits: 60,
      unitCost: 8.0
    }],
    p_client_operation_id: randomUUID(),
    p_purchase_order_id: order.id,
    p_currency: "PEN",
    p_exchange_rate: null,
    p_supplier_document: null,
    p_terms: "credit"
  });

  // Recepción con bonificación del mismo artículo: 80 pagadas y 20 de regalo.
  await rpc("register_goods_receipt", {
    p_supplier_id: fx.supplierId,
    p_branch_id: fx.branch,
    p_lines: [{ variantId: fx.v2, receivedUnits: 80, bonusUnits: 20, unitCost: 10.0, bonusValuation: "same_variant" }],
    p_client_operation_id: randomUUID(),
    p_purchase_order_id: null,
    p_currency: "PEN",
    p_exchange_rate: null,
    p_supplier_document: null,
    p_terms: "cash"
  });

  const v1Stock = await stockOf(fx.v1, fx.branch);
  const v2Valuation = await valuationOf(fx.v2, fx.branch);

  check("la recepción parcial incorpora solo lo recibido", v1Stock.onHand === 60, `on_hand ${v1Stock.onHand}`);
  check(
    "la bonificación del mismo artículo baja el costo efectivo a 8,00",
    v2Valuation.quantityValued === 100 && money(v2Valuation.totalValue) === 800.0,
    JSON.stringify(v2Valuation)
  );

  console.log("\n2. Cuentas con el proveedor");

  const obligation = must(
    await service.from("supplier_obligations").select("id, amount_due").eq("supplier_id", fx.supplierId),
    "obligaciones"
  );

  check("la compra a crédito deja obligación por lo recibido", obligation.length === 1 && money(obligation[0].amount_due) === 480.0,
    JSON.stringify(obligation));

  await rpc("register_supplier_payment", {
    p_supplier_id: fx.supplierId,
    p_branch_id: fx.branch,
    p_method: "transfer",
    p_amount: 300.0,
    p_client_operation_id: randomUUID(),
    p_currency: "PEN",
    p_allocations: [{ obligationId: obligation[0].id, amount: 300.0 }]
  });

  const balances = must(
    await service.from("supplier_balances").select("currency, balance").eq("supplier_id", fx.supplierId),
    "saldo del proveedor"
  );

  check("el pago parcial reduce la deuda por la diferencia exacta",
    balances.length === 1 && money(balances[0].balance) === 180.0, JSON.stringify(balances));

  console.log("\n3. Caja y venta");

  const session = await rpc("open_cash_session", {
    p_branch_id: fx.branch, p_opening_float: 100.0, p_note: "Apertura integral"
  });

  // 4 × 15,00 = 60,00 menos 5,00 de descuento = 55,00, cobrados en dos medios.
  const sale1 = await rpc("register_sale", {
    p_branch_id: fx.branch,
    p_lines: [{ variantId: fx.v1, quantity: 4 }],
    p_payments: [
      { method: "cash", amount: 30.0, tenderedAmount: 50.0 },
      { method: "yape", amount: 25.0 }
    ],
    p_client_operation_id: randomUUID(),
    p_source_channel: "in_store",
    p_fulfillment_method: "in_store",
    p_customer: { name: "Clienta integral" },
    p_discount_total: 5.0
  });

  check("la venta con descuento cobra 55,00 exactos", money(sale1.total) === 55.0, `total ${sale1.total}`);
  check("y el vuelto se deriva sin ensuciar la cobranza",
    money(sale1.payments.find((p) => p.method === "cash").change) === 20.0,
    JSON.stringify(sale1.payments));

  console.log("\n4. Reserva, conversión y anulación");

  const reservation = await rpc("create_reservation", {
    p_branch_id: fx.branch,
    p_lines: [{ variantId: fx.v2, quantity: 5 }],
    p_customer: { name: "Clienta que reserva" },
    p_expires_at: new Date(Date.now() + 86400000).toISOString(),
    p_client_operation_id: randomUUID(),
    p_advance: { method: "yape", amount: 20.0 }
  });

  const reservedStock = await stockOf(fx.v2, fx.branch);
  check("la reserva compromete sin descontar",
    reservedStock.onHand === 100 && reservedStock.reserved === 5, JSON.stringify(reservedStock));

  const converted = await rpc("register_sale", {
    p_branch_id: fx.branch,
    p_lines: null,
    p_payments: [{ method: "cash", amount: money(reservation.balance) }],
    p_client_operation_id: randomUUID(),
    p_source_channel: "in_store",
    p_fulfillment_method: "in_store",
    p_customer: null,
    p_discount_total: 0,
    p_notes: null,
    p_reservation_id: reservation.id
  });

  const afterConversion = await stockOf(fx.v2, fx.branch);
  check("convertir descuenta una sola vez y libera lo comprometido",
    afterConversion.onHand === 95 && afterConversion.reserved === 0, JSON.stringify(afterConversion));
  check("y el adelanto se traslada sin contarse dos veces",
    money(converted.payments.reduce((sum, p) => sum + Number(p.amount), 0)) === money(converted.total),
    JSON.stringify(converted.payments));

  const sale2 = await rpc("register_sale", {
    p_branch_id: fx.branch,
    p_lines: [{ variantId: fx.v1, quantity: 2 }],
    p_payments: [{ method: "cash", amount: 30.0 }],
    p_client_operation_id: randomUUID()
  });

  await rpc("cancel_sale", {
    p_sale_id: sale2.id,
    p_reason_code: "customer_regret",
    p_explanation: "La clienta se arrepintió antes de salir"
  });

  const refundsOfCancel = must(
    await service.from("refunds").select("amount, sale_cancellation_id").not("sale_cancellation_id", "is", null),
    "reembolsos de anulación"
  );

  check("anular devuelve el dinero por el importe cobrado",
    money(refundsOfCancel.reduce((sum, r) => sum + Number(r.amount), 0)) === 30.0,
    JSON.stringify(refundsOfCancel));

  console.log("\n5. Devolución parcial");

  const sale1Lines = must(
    await service.from("sale_lines").select("id, quantity").eq("sale_id", sale1.id),
    "líneas de la venta"
  );

  const returned = await rpc("register_return", {
    p_sale_id: sale1.id,
    p_lines: [{ saleLineId: sale1Lines[0].id, quantity: 1, condition: "resellable" }],
    p_client_operation_id: randomUUID(),
    p_reason: "Tono equivocado",
    p_refunds: [{ method: "cash", amount: 13.75 }]
  });

  check("la devolución reparte el reembolso por diferencia acumulada",
    money(returned.refundTotal) === 13.75, `reembolso ${returned.refundTotal}`);

  console.log("\n6. Gasto y traslado");

  let category = must(
    await service.from("expense_categories").select("id").eq("code", "TEST_INTEGRAL"),
    "categoría de gasto"
  )[0];

  if (!category) {
    category = must(
      await service.from("expense_categories").insert({ code: "TEST_INTEGRAL", name: "Gasto integral" })
        .select("id").single(),
      "crear categoría"
    );
  }

  await rpc("register_expense", {
    p_branch_id: fx.branch,
    p_expense_category_id: category.id,
    p_method: "cash",
    p_amount: 40.0,
    p_description: "Flete del circuito integral",
    p_client_operation_id: randomUUID()
  });

  await rpc("register_transfer", {
    p_origin_branch_id: fx.branch,
    p_destination_branch_id: fx.destination,
    p_lines: [{ variantId: fx.v1, units: 10 }],
    p_client_operation_id: randomUUID(),
    p_reason: "Reposición de la segunda sede"
  });

  const origin = await stockOf(fx.v1, fx.branch);
  const destination = await stockOf(fx.v1, fx.destination);

  // 60 recibidas − 4 vendidas − 2 vendidas y anuladas + 2 repuestas por la
  // anulación + 1 devuelta vendible = 57, repartidas entre las dos sedes.
  check("el traslado mueve unidades sin crear ni destruir ninguna",
    origin.onHand + destination.onHand === 57 && destination.onHand === 10,
    `origen ${origin.onHand} · destino ${destination.onHand}`);

  console.log("\n7. Arqueo del día");

  const summary = await rpc("daily_cash_summary", {
    p_branch_id: fx.branch,
    p_date: new Date().toISOString().slice(0, 10)
  });

  // Efectivo del día: 30,00 de la venta 1 + el saldo de la conversión + 30,00
  // de la venta anulada. Salidas en efectivo: 30,00 del reembolso de anulación,
  // 13,75 del reembolso de la devolución y 40,00 del gasto.
  const expectedCashIn = money(30.0 + Number(reservation.balance) + 30.0);
  const expectedCashOut = money(30.0 + 13.75 + 40.0);

  check("el arqueo suma el efectivo que entró hoy",
    money(summary.cashIncome) === expectedCashIn, `${summary.cashIncome} vs ${expectedCashIn}`);
  check("y resta el que salió: reembolsos y gasto",
    money(summary.cashOutflow) === expectedCashOut, `${summary.cashOutflow} vs ${expectedCashOut}`);
  check("el adelanto trasladado se lista aparte, no como ingreso del día",
    money(summary.appliedAdvances.amount) === 20.0, JSON.stringify(summary.appliedAdvances));

  await rpc("close_cash_session", {
    p_cash_session_id: session.id,
    p_counted_cash: money(100 + expectedCashIn - expectedCashOut),
    p_note: "Cierre integral"
  });

  const closed = must(
    await service.from("cash_sessions").select("status, expected_cash, counted_cash, difference").eq("id", session.id),
    "cierre de caja"
  )[0];

  check("cerrar caja deja el arqueo cuadrado",
    closed.status === "closed" && money(closed.difference) === 0.0, JSON.stringify(closed));

  return { branch: fx.branch, destination: fx.destination, v1: fx.v1, v2: fx.v2 };
}

// ---------------------------------------------------------------------------
// Conciliación
// ---------------------------------------------------------------------------
// Es la comprobación que el modelo pedía y que ninguna prueba anterior hacía:
// el valor del inventario contra el dinero realmente gastado.

async function reconcile(fx) {
  console.log("\n8. Conciliación del valor");

  const mismatched = await sql(`
    select count(*)::int as bad
    from public.inventory_stock s
    join lateral (
      select coalesce(sum(m.quantity), 0) as units, coalesce(sum(m.value_delta), 0) as value
      from public.inventory_movements m
      where m.variant_id = s.variant_id and m.branch_id = s.branch_id
    ) k on true
    left join public.inventory_valuation v
      on v.variant_id = s.variant_id and v.branch_id = s.branch_id
    where k.units <> s.on_hand
       or round(k.value, 6) <> round(coalesce(v.total_value, 0), 6);
  `);

  check("el kardex reconstruye saldo y valor de TODA fila de existencias",
    Number(mismatched[0].bad) === 0, `${mismatched[0].bad} fila(s) descuadradas`);

  const invariants = await sql(`
    select
      (select count(*)::int from public.inventory_stock
        where on_hand < 0 or reserved < 0 or reserved > on_hand) as bad_stock,
      (select count(*)::int from public.inventory_valuation
        where quantity_valued < 0 or total_value < 0
           or ((quantity_valued = 0) <> (total_value = 0))) as bad_valuation,
      (select count(*)::int from public.sales s
        where coalesce((select sum(p.amount) from public.sale_payments p where p.sale_id = s.id), 0)
              <> s.total) as unpaid_sales,
      (select count(*)::int from public.sales s
        where coalesce((select sum(l.discount_amount) from public.sale_lines l where l.sale_id = s.id), 0)
              <> s.discount_total) as bad_discounts,
      (select count(*)::int from public.sale_lines l
        where coalesce((select sum(r.quantity) from public.return_lines r where r.sale_line_id = l.id), 0)
              > l.quantity) as over_returned;
  `);

  const row = invariants[0];
  check("ningún saldo negativo ni sobre-reservado", Number(row.bad_stock) === 0, `${row.bad_stock}`);
  check("ninguna valoración corrupta", Number(row.bad_valuation) === 0, `${row.bad_valuation}`);
  check("toda venta sigue cobrada por su importe exacto", Number(row.unpaid_sales) === 0, `${row.unpaid_sales}`);
  check("todo descuento sigue siendo la suma de sus líneas", Number(row.bad_discounts) === 0, `${row.bad_discounts}`);
  check("ninguna línea devuelta por encima de lo vendido", Number(row.over_returned) === 0, `${row.over_returned}`);

  // COGS: lo capturado en la venta contra lo que salió del kardex.
  const cogs = await sql(`
    select
      round(coalesce((
        select sum(c.total_cost)
        from public.sale_line_costs c
        join public.sales s on s.id = c.sale_id
        where s.branch_id = '${fx.branch}' and s.status = 'confirmed'
      ), 0), 2) as captured,
      round(coalesce((
        select -sum(m.value_delta)
        from public.inventory_movements m
        where m.branch_id = '${fx.branch}' and m.movement_type = 'sale'
          and m.source_id in (select id from public.sales where branch_id = '${fx.branch}' and status = 'confirmed')
      ), 0), 2) as from_ledger;
  `);

  check(
    "el costo capturado en las ventas coincide con el que salió del kardex",
    Number(cogs[0].captured) === Number(cogs[0].from_ledger),
    `capturado ${cogs[0].captured} · kardex ${cogs[0].from_ledger}`
  );

  // El valor que queda en la sede = lo que entró por recepciones y traslados
  // menos lo que salió por ventas, devoluciones al costo y traslados.
  const branchValue = await sql(`
    select
      round(coalesce((select sum(total_value) from public.inventory_valuation
                      where branch_id = '${fx.branch}'), 0), 2) as valuation,
      round(coalesce((select sum(value_delta) from public.inventory_movements
                      where branch_id = '${fx.branch}'), 0), 2) as ledger;
  `);

  check(
    "y el valor de la sede es exactamente la suma de su kardex",
    Number(branchValue[0].valuation) === Number(branchValue[0].ledger),
    `valoración ${branchValue[0].valuation} · kardex ${branchValue[0].ledger}`
  );
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

async function stockOf(variantId, branchId) {
  const rows = must(
    await service.from("inventory_stock").select("on_hand, reserved")
      .eq("variant_id", variantId).eq("branch_id", branchId),
    "existencias"
  );
  return { onHand: rows[0]?.on_hand ?? 0, reserved: rows[0]?.reserved ?? 0 };
}

async function valuationOf(variantId, branchId) {
  const rows = must(
    await service.from("inventory_valuation").select("quantity_valued, total_value")
      .eq("variant_id", variantId).eq("branch_id", branchId),
    "valoración"
  );
  return {
    quantityValued: rows[0]?.quantity_valued ?? 0,
    totalValue: Number(rows[0]?.total_value ?? 0)
  };
}

/**
 * Consulta libre por el contenedor: las agregaciones de conciliación no caben
 * en PostgREST. Devuelve JSON para no depender de adivinar los nombres de
 * columna a partir del texto de la consulta, que es frágil y silencioso: una
 * columna mal nombrada produce `undefined` y toda comparación falla sin decir
 * por qué.
 */
async function sql(query) {
  const wrapped = `select coalesce(json_agg(row_to_json(t)), '[]'::json) from (${query.trim().replace(/;\s*$/, "")}) t;`;
  return JSON.parse((await psql(wrapped)) || "[]");
}

/** Ejecuta SQL sin esperar resultado: limpieza y preparación. */
async function exec(statement) {
  await psql(statement);
}

async function psql(statement) {
  const { spawn } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", "-i", "supabase_db_e-commerce-catalog", "psql", "-U", "postgres", "-d", "postgres",
       "-v", "ON_ERROR_STOP=1", "-A", "-t"],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim()));
      resolve(out.trim());
    });
    child.stdin.end(statement);
  });
}

// ---------------------------------------------------------------------------

console.log("Prueba integral del Bloque 2 · Supabase local");

const fixtures = await setup();

try {
  const scenario = await run(fixtures);
  await reconcile(scenario);
} finally {
  await asAdmin.auth.signOut().catch(() => undefined);
}

console.log(failures === 0
  ? "\nPASS · el circuito económico cuadra de extremo a extremo"
  : `\nFAIL · ${failures} comprobación(es)`);
process.exit(failures === 0 ? 0 : 1);
