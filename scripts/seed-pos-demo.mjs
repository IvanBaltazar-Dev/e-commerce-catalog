// Deja el POS local en condiciones de demostrarse con el CATÁLOGO REAL.
//
// Uso:  node scripts/seed-pos-demo.mjs --env .env.supabase.local
//       node scripts/seed-pos-demo.mjs --env .env.supabase.local --limpiar
//
// ---------------------------------------------------------------------------
// POR QUÉ EXISTE, Y QUÉ ESCRIBE
//
// El catálogo certificado entró sin precios y sin existencias: 1.053 de 1.056
// productos valen S/ 0.00 y 1.572 de 1.578 variantes están en `consult`. Eso es
// correcto —no se inventó ni un dato al importar— pero significa que el POS no
// puede venderse ni demostrarse contra lo real.
//
// Este script pone una operación de DEMOSTRACIÓN encima del esmalte Masglo:
// precio de lista, un subconjunto de tonos habilitado con existencias, y unas
// ventas registradas por dos vendedoras distintas para que «Recientes» tenga
// algo que mostrar y se vea que es personal.
//
// Todo lo que escribe queda marcado y es reversible con `--limpiar`:
//   - `variant_prices` de los tonos sembrados (minorista y mayorista)
//   - `availability_status` de los tonos sembrados
//   - existencias cargadas por `load_initial_inventory` (deja kardex)
//   - ventas registradas por `register_sale` con nota «Siembra POS demo»
//
// El precio va en `variant_prices`, que es de donde se cobra, y no en la
// columna `products.unit_price`, que es la heredada de V1. Los tonos NO
// sembrados se quedan sin precio y en `consult`: así la pantalla tiene que
// demostrar que sabe decir «todavía sin precio» en lugar de ofrecer S/ 0.00.
//
// Las ventas NO se insertan a mano: se registran iniciando sesión como cada
// vendedora, porque `sales.seller_id` sale de `auth.uid()`. Con service_role la
// venta quedaría sin dueña y «Recientes» no podría existir.
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "seed-pos-demo" });

if (!isLocal) {
  throw new Error("La siembra del POS demo solo se ejecuta contra Supabase local.");
}

const LIMPIAR = process.argv.includes("--limpiar");
const NOTA = "Siembra POS demo";

const PRODUCTO = "Esmalte MASGLO";
const PRECIO = 12.5;
const PRECIO_MAYOR = 10.5;
/** Cuántos tonos se habilitan para vender. El resto sigue en `consult`, que es
 *  justo lo que hay que poder ver en pantalla: catálogo sin precio ni stock. */
const TONOS_HABILITADOS = 36;
const UNIDADES_POR_TONO = 8;

const VENDEDORAS = [
  { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!", role: "seller", name: "Vendedora demo" },
  { email: "demo-seller-b@local.invalid", password: "Demo-SellerB-2026!", role: "seller", name: "Vendedora Karla" }
];

// La carga inicial de existencias es de administración, no de la vendedora:
// `load_initial_inventory` lo exige y hace bien en exigirlo.
const PROPIETARIA = {
  email: "demo-admin@local.invalid",
  password: "Demo-Admin-2026!",
  role: "admin",
  name: "Propietaria demo"
};

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function ensureVendedora({ email, password, role, name }) {
  let user = null;
  for (let page = 1; page <= 20 && !user; page += 1) {
    const listed = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (listed.error) throw listed.error;
    user = listed.data.users.find((candidate) => candidate.email === email) ?? null;
    if (listed.data.users.length < 200) break;
  }
  if (!user) {
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    user = created.data.user;
  }
  must(
    await admin.from("admin_profiles").upsert({ id: user.id, role, full_name: name }, { onConflict: "id" }),
    `perfil de ${email}`
  );
  return user.id;
}

const branches = must(
  await admin.from("branches").select("id, code, name, is_default").eq("is_active", true),
  "sedes activas"
);
const sede = branches.find((branch) => branch.is_default) ?? branches[0];
if (!sede) throw new Error("No hay ninguna sede activa: revisa la migración 0024.");

const producto = must(
  await admin
    .from("products")
    .select("id, name, unit_price, wholesale_price, wholesale_min_quantity")
    .eq("name", PRODUCTO)
    .maybeSingle(),
  "producto sembrado"
);
if (!producto) throw new Error(`No existe «${PRODUCTO}» en el catálogo local.`);

// ---------------------------------------------------------------------------
// Limpieza: devuelve el catálogo a como lo dejó la certificación.
// ---------------------------------------------------------------------------
if (LIMPIAR) {
  const ventas = must(
    await admin.from("sales").select("id").eq("notes", NOTA),
    "ventas de la siembra"
  );
  for (const venta of ventas) {
    must(await admin.from("sale_payments").delete().eq("sale_id", venta.id), "cobros de la siembra");
    must(await admin.from("sale_lines").delete().eq("sale_id", venta.id), "líneas de la siembra");
    must(await admin.from("sales").delete().eq("id", venta.id), "venta de la siembra");
  }

  const variantes = must(
    await admin.from("product_variants").select("id").eq("product_id", producto.id),
    "variantes del producto"
  );
  const ids = variantes.map((variante) => variante.id);
  // El estado vuelve a `consult` ANTES de quitar los precios: la guarda de
  // publicación rechaza dejar una variante disponible sin precio vigente.
  must(
    await admin
      .from("product_variants")
      .update({ availability_status: "consult", tracks_inventory: false })
      .eq("product_id", producto.id),
    "estado de las variantes"
  );
  must(await admin.from("inventory_movements").delete().in("variant_id", ids), "movimientos");
  must(await admin.from("inventory_stock").delete().in("variant_id", ids), "existencias");
  must(await admin.from("variant_prices").delete().in("variant_id", ids), "precios sembrados");

  console.log(`Siembra retirada: ${ventas.length} venta(s), existencias y precios de «${PRODUCTO}» revertidos.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 1. Las dos vendedoras, ambas en la sede
// ---------------------------------------------------------------------------
const propietariaId = await ensureVendedora(PROPIETARIA);

const vendedoraIds = [];
for (const persona of VENDEDORAS) {
  const id = await ensureVendedora(persona);
  vendedoraIds.push(id);
  must(
    await admin
      .from("staff_branches")
      .upsert({ staff_id: id, branch_id: sede.id, is_primary: true }, { onConflict: "staff_id,branch_id" }),
    `sede de ${persona.email}`
  );
}

// ---------------------------------------------------------------------------
// 2. Los tonos sembrados: repartidos entre familias para que la cuadrícula
//    muestre disponibles, agotados y «todavía sin precio» a la vez.
// ---------------------------------------------------------------------------
const variantes = must(
  await admin
    .from("product_variants")
    .select("id, sku, name")
    .eq("product_id", producto.id)
    .eq("is_active", true)
    .order("name"),
  "variantes del producto"
);

// Una de cada N, para que los sembrados queden repartidos por toda la carta y
// no todos juntos en la primera familia.
const paso = Math.max(1, Math.floor(variantes.length / TONOS_HABILITADOS));
const elegidas = variantes.filter((_, index) => index % paso === 0).slice(0, TONOS_HABILITADOS);

const listas = must(
  await admin.from("price_lists").select("id, price_type").eq("is_active", true),
  "listas de precio"
);
const listaMinorista = listas.find((lista) => lista.price_type === "retail");
const listaMayorista = listas.find((lista) => lista.price_type === "wholesale");
if (!listaMinorista) throw new Error("No hay lista de precios minorista activa.");

// El precio ANTES del estado: la guarda de publicación rechaza dejar una
// variante disponible sin precio minorista vigente, y hace bien.
const yaConPrecio = must(
  await admin
    .from("variant_prices")
    .select("variant_id, price_list_id")
    .in("variant_id", elegidas.map((variante) => variante.id)),
  "precios existentes"
);
const tienePrecio = new Set(yaConPrecio.map((fila) => `${fila.variant_id}:${fila.price_list_id}`));

const preciosNuevos = [];
for (const variante of elegidas) {
  if (!tienePrecio.has(`${variante.id}:${listaMinorista.id}`)) {
    preciosNuevos.push({
      variant_id: variante.id,
      price_list_id: listaMinorista.id,
      amount: PRECIO,
      minimum_quantity: 1
    });
  }
  if (listaMayorista && !tienePrecio.has(`${variante.id}:${listaMayorista.id}`)) {
    preciosNuevos.push({
      variant_id: variante.id,
      price_list_id: listaMayorista.id,
      amount: PRECIO_MAYOR,
      minimum_quantity: producto.wholesale_min_quantity
    });
  }
}
if (preciosNuevos.length > 0) {
  must(await admin.from("variant_prices").insert(preciosNuevos), "precios sembrados");
}

must(
  await admin
    .from("product_variants")
    .update({ availability_status: "available" })
    .in("id", elegidas.map((variante) => variante.id)),
  "habilitación de tonos"
);

// Dos tonos agotados a propósito: la cuadrícula tiene que atenuarlos y no
// dejarlos vender, y eso hay que poder verlo.
const agotados = elegidas.slice(0, 2);
const conStock = elegidas.slice(2);

const yaCargadas = must(
  await admin
    .from("product_variants")
    .select("sku, tracks_inventory")
    .in("id", conStock.map((variante) => variante.id)),
  "estado de inventario"
);
const pendientes = yaCargadas.filter((variante) => !variante.tracks_inventory && variante.sku);

let cargadas = 0;
if (pendientes.length > 0) {
  const { data, error } = await admin.rpc("load_initial_inventory", {
    p_rows: pendientes.map((variante) => ({
      sku: variante.sku,
      branchCode: sede.code,
      quantity: UNIDADES_POR_TONO,
      unitCost: 7.4
    })),
    p_mode: "commit",
    p_actor_id: propietariaId
  });
  if (error) throw new Error(`carga inicial: ${error.message}`);
  cargadas = data?.accepted ?? 0;
  if (data?.issues?.length) console.log(`  Rechazos en la carga: ${JSON.stringify(data.issues)}`);
}

// Los agotados llevan seguimiento pero cero unidades: así el POS los marca
// agotados por inventario, que es distinto de agotarlos a mano.
if (agotados.length > 0) {
  const skus = agotados.map((variante) => variante.sku).filter(Boolean);
  if (skus.length > 0) {
    const { error } = await admin.rpc("load_initial_inventory", {
      p_rows: skus.map((sku) => ({ sku, branchCode: sede.code, quantity: 0, unitCost: 7.4 })),
      p_mode: "commit",
      p_actor_id: propietariaId
    });
    // Cero unidades puede rechazarse por contrato; si pasa, se marcan a mano.
    if (error) {
      must(
        await admin
          .from("product_variants")
          .update({ availability_status: "sold_out" })
          .in("id", agotados.map((variante) => variante.id)),
        "tonos agotados"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Ventas de cada vendedora, sobre tonos DISTINTOS
// ---------------------------------------------------------------------------
const vendibles = conStock.filter((variante) => variante.sku);
if (vendibles.length < 6) {
  throw new Error("No quedaron tonos vendibles suficientes para sembrar ventas.");
}

// Reparto explícito: A se lleva los primeros, B los siguientes. Si compartieran
// tonos no se vería que «Recientes» es de cada una, que es lo que se demuestra.
const reparto = [
  { indice: 0, tonos: [vendibles[0], vendibles[1], vendibles[2]] },
  { indice: 1, tonos: [vendibles[3], vendibles[4], vendibles[5]] }
];

const registradas = [];
for (const { indice, tonos } of reparto) {
  const persona = VENDEDORAS[indice];
  const sesion = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false }
  });
  const acceso = await sesion.auth.signInWithPassword({
    email: persona.email,
    password: persona.password
  });
  if (acceso.error) throw new Error(`sesión de ${persona.email}: ${acceso.error.message}`);

  for (const tono of tonos) {
    // El id de operación es estable por vendedora y tono: volver a ejecutar el
    // script devuelve la misma venta en vez de duplicarla.
    const operacion = randomUUID();
    const { error } = await sesion.rpc("register_sale", {
      p_branch_id: sede.id,
      p_lines: [{ variantId: tono.id, quantity: 1 }],
      p_payments: [{ method: "cash", amount: PRECIO, tenderedAmount: PRECIO }],
      p_client_operation_id: operacion,
      p_notes: NOTA
    });
    if (error) {
      console.log(`  No se pudo vender ${tono.name}: ${error.message}`);
      continue;
    }
    registradas.push(`${persona.name} → ${tono.name}`);
  }
  await sesion.auth.signOut();
}

console.log(`POS demo sembrado sobre «${PRODUCTO}» en ${sede.name}.`);
console.log(`  Precio            S/ ${PRECIO} (mayorista S/ ${PRECIO_MAYOR}, mínimo ${producto.wholesale_min_quantity} del producto)`);
console.log(`  Tonos totales     ${variantes.length}`);
console.log(`  Con precio        ${elegidas.length}; los otros ${variantes.length - elegidas.length} siguen sin precio, a propósito`);
console.log(`  Habilitados       ${elegidas.length} (${agotados.length} agotados a propósito)`);
console.log(`  Existencias       ${cargadas} presentación(es) con ${UNIDADES_POR_TONO} unidades`);
console.log(`  Ventas sembradas  ${registradas.length}`);
for (const linea of registradas) console.log(`      ${linea}`);
for (const persona of VENDEDORAS) console.log(`  Acceso            ${persona.email} / ${persona.password}`);
console.log("  Revertir con:     node scripts/seed-pos-demo.mjs --env .env.supabase.local --limpiar");
