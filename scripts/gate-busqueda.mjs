/**
 * Gate de búsqueda — RNF-1.
 *
 * «Toda superficie de búsqueda responde en menos de 3 000 ms EN EL PEOR CASO,
 * con un catálogo de 100 000 productos.» No la mediana: el peor caso. Una
 * búsqueda que va a 200 ms nueve veces y a 6 s la décima es, para quien vende,
 * una búsqueda que se cuelga.
 *
 * Siembra el volumen, mide cada superficie N veces, y falla si el peor caso de
 * cualquiera supera el umbral. Lo que falla imprime su EXPLAIN (ANALYZE,
 * BUFFERS) — la única base admitida para tocar un índice.
 *
 * El sembrado usa prefijo VOLQ- y se retira siempre, pase lo que pase.
 *
 * Uso:  node scripts/gate-busqueda.mjs [--keep] [--skip-seed] [--productos=N]
 *   --keep         no retira el volumen al terminar
 *   --skip-seed    mide sobre el volumen ya sembrado
 *   --productos=N  cuántos productos sembrar (por defecto 100000)
 */
import { createClient } from "@supabase/supabase-js";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate-busqueda",
  allowedFlags: ["--keep", "--skip-seed", /^--productos=\d+$/]
});
if (!isLocal) throw new Error("El gate de búsqueda solo corre contra Supabase local.");

const CONTAINER = "supabase_db_e-commerce-catalog";
const KEEP = process.argv.includes("--keep");
const SKIP_SEED = process.argv.includes("--skip-seed");
const PRODUCTOS = Number(
  (process.argv.find((a) => a.startsWith("--productos=")) ?? "--productos=100000").split("=")[1]
);

/** El umbral del requisito. No es negociable ni configurable a propósito. */
const UMBRAL_MS = 3000;
const CORRIDAS = 5;

const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});
const asAdmin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false }
});

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

function psql(sql, { timeoutMs = 900_000 } = {}) {
  const result = spawnSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t"],
    { input: sql, encoding: "utf8", maxBuffer: 1024 * 1024 * 64, timeout: timeoutMs, env: { ...process.env, MSYS_NO_PATHCONV: "1" } }
  );
  if (result.status !== 0) throw new Error(`psql: ${(result.stderr || result.stdout || "").slice(-1200)}`);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// 1. Volumen
// ---------------------------------------------------------------------------

/**
 * Con los disparadores apagados y los ids materializados una vez.
 *
 * Medido: la versión ingenua tardaba más de diez minutos y no terminaba. Dos
 * razones. `sku like 'VOLQ-%'` no puede usar el índice de SKU, que es sobre
 * `lower(sku)`, así que cada uno de los cuatro DELETE recorría las 200 000
 * variantes. Y el disparador de borrado de `variant_attribute_values` recibe
 * una tabla de transición con las 500 000 filas y reconstruye el documento de
 * variantes que se están borrando de todas formas. Con los ids en una tabla
 * temporal indexada y sin disparadores: 13 segundos.
 */
function limpiarVolumen() {
  psql(`
    begin;
    set local session_replication_role = replica;
    create temporary table volq_ids on commit drop as
      select id from public.product_variants where sku like 'VOLQ-%';
    create index on volq_ids(id);
    delete from public.variant_attribute_values where variant_id in (select id from volq_ids);
    delete from public.variant_prices where variant_id in (select id from volq_ids);
    delete from public.product_variants where id in (select id from volq_ids);
    delete from public.products where code like 'VOLQ-%';
    delete from public.persons where full_name like 'VOLQ Clienta %';
    set local session_replication_role = default;
    commit;
    analyze public.products;
    analyze public.product_variants;
    analyze public.variant_attribute_values;
  `);
}

/**
 * Carga masiva con los disparadores desactivados. A 100 000 productos, validar
 * fila a fila cuesta veinte minutos y no prueba nada que pgTAP no pruebe ya por
 * los contratos reales. Los invariantes se comprueban DESPUÉS, en bloque, y esa
 * parte no se puede saltar: si el volumen es basura, medir sobre él no
 * significa nada.
 */
function sembrarVolumen(cuantos) {
  limpiarVolumen();
  console.log(`Sembrando ${cuantos.toLocaleString("es-PE")} productos…`);
  psql(`
    begin;
    set local session_replication_role = replica;

    create temporary table volq_dims on commit drop as
    select
      array(select id from public.brands where is_active order by id) as brand_ids,
      array(select name from public.brands where is_active order by id) as brand_names,
      array(select id from public.categories order by id) as cat_ids,
      array(select id from public.attribute_templates
            where code in ('PRODUCTO_COSMETICO','CONSUMIBLE_BASICO','HERRAMIENTA_BASICA','PRESS_ON_DECORADO')
            order by code) as tpl_ids,
      (select id from public.price_lists where price_type='retail' and is_active order by code limit 1) as retail_id,
      (select id from public.price_lists where price_type='wholesale' and is_active order by code limit 1) as wholesale_id,
      array['Esmalte','Gel constructor','Lampara UV','Torno profesional','Pincel de detalle',
            'Lima pulidora','Adhesivo de cabina','Pestanas postizas','Base coat','Top coat'] as tipos,
      array['profesional','mate','brillante','de cabina','premium','clasico','intenso','sedoso'] as adjetivos;

    create temporary table volq_opts on commit drop as
    select o.attribute_definition_id as def_id, array_agg(o.id order by o.sort_order, o.id) as ids
    from public.attribute_options o where o.is_active group by o.attribute_definition_id;

    insert into public.products (
      code, slug, brand_id, category_id, template_id, name, presentation, product_type,
      description, unit_price, wholesale_price, wholesale_min_quantity,
      availability, editorial_status, is_active, sort_order)
    select
      'VOLQ-' || lpad(n::text, 6, '0'),
      'volq-' || lpad(n::text, 6, '0'),
      d.brand_ids[1 + (n % array_length(d.brand_ids, 1))],
      d.cat_ids[1 + (n % array_length(d.cat_ids, 1))],
      d.tpl_ids[1 + (n % array_length(d.tpl_ids, 1))],
      d.tipos[1 + (n % array_length(d.tipos, 1))] || ' ' ||
        d.brand_names[1 + (n % array_length(d.brand_names, 1))] || ' ' ||
        d.adjetivos[1 + (n % array_length(d.adjetivos, 1))] || ' ' || lpad(n::text, 6, '0'),
      'Frasco ' || (5 + (n % 20)) || ' ml',
      d.tipos[1 + (n % array_length(d.tipos, 1))],
      'Fila de volumen del gate de busqueda.',
      10 + (n % 40), 8 + (n % 40), 3,
      'available', 'draft', false, 900000 + n
    from generate_series(1, ${cuantos}) n, volq_dims d;

    insert into public.product_variants (
      product_id, sku, name, variant_key, availability_status, is_default, is_active, sort_order)
    select p.id, p.code || '-V' || v, 'Presentacion ' || v, 'presentation=v' || v,
           'available', v = 1, true, v
    from public.products p, generate_series(1, 2) v
    where p.code like 'VOLQ-%';

    insert into public.variant_prices (variant_id, price_list_id, amount, minimum_quantity, is_active)
    select v.id, d.retail_id, 10 + (abs(hashtext(v.sku)) % 40), 1, true
    from public.product_variants v, volq_dims d where v.sku like 'VOLQ-%';

    insert into public.variant_prices (variant_id, price_list_id, amount, minimum_quantity, is_active)
    select v.id, d.wholesale_id, 8 + (abs(hashtext(v.sku)) % 40), 3, true
    from public.product_variants v, volq_dims d where v.sku like 'VOLQ-%';

    insert into public.variant_attribute_values (variant_id, attribute_definition_id, option_id)
    select v.id, ad.id, o.ids[1 + (abs(hashtext(v.sku || ad.code)) % array_length(o.ids, 1))]
    from public.product_variants v
    join public.products p on p.id = v.product_id
    join public.template_attributes ta on ta.template_id = p.template_id
    join public.attribute_definitions ad on ad.id = ta.attribute_definition_id and ad.is_active
    join volq_opts o on o.def_id = ad.id
    where v.sku like 'VOLQ-%' and ad.is_searchable
      and coalesce(ta.scope_override, ad.scope) in ('variant', 'both');

    update public.products set is_active = true, editorial_status = 'published'
    where code like 'VOLQ-%';

    -- Clientas. Sin volumen aquí, comprobar que el buscador de personas usa su
    -- índice no prueba nada: con tres filas, recorrer la tabla ES el plan
    -- correcto y la comprobación pasa o falla por el motivo equivocado.
    insert into public.persons (full_name, phone_normalized, document_number)
    select 'VOLQ Clienta ' || n,
           '519' || lpad(n::text, 8, '0'),
           lpad((40000000 + n)::text, 8, '0')
    from generate_series(1, 20000) n;

    set local session_replication_role = default;
    commit;
  `);

  // Las tres proyecciones que el sembrado masivo no rellena, porque va con los
  // disparadores apagados. En una base real las mantienen los disparadores; aquí
  // se reconstruyen a mano una vez, y con los disparadores apagados también:
  // reconstruir el precio inicial de 100 000 productos con la auditoría y los
  // metadatos del catálogo activos costaba más de diez minutos.
  // Las proyecciones, que el sembrado masivo no rellena porque va con los
  // disparadores apagados. Ya NO hace falta apagar nada para reconstruirlas:
  // desde 0078 viven en sus propias tablas, así que escribirlas no arrastra la
  // pila de reglas de `product_variants`. Cuando el documento era una columna
  // de esa tabla, esto mismo no terminaba en diecisiete minutos.
  console.log("  reconstruyendo variant_search_projection…");
  psql(`select public.rebuild_variant_search_projection();`, { timeoutMs: 1_800_000 });

  console.log("  reconstruyendo variant_search_codes…");
  psql(`select public.rebuild_variant_search_codes();`, { timeoutMs: 1_800_000 });

  console.log("  reconstruyendo product_catalog_projection…");
  psql(`select public.rebuild_product_catalog_search();`, { timeoutMs: 1_800_000 });
  psql(`select public.rebuild_product_catalog_price();`, { timeoutMs: 1_800_000 });

  console.log("  reconstruyendo catalog_facet_presence…");
  psql(`select public.rebuild_catalog_facet_presence();`, { timeoutMs: 1_800_000 });

  console.log("  analizando…");
  psql(`
    analyze public.products;
    analyze public.product_variants;
    analyze public.variant_attribute_values;
    analyze public.variant_prices;
  `);
}

/** Los invariantes que los disparadores desactivados habrían comprobado. */
function verificarVolumen() {
  const salida = psql(`
    set max_parallel_workers_per_gather = 0;
    select invariante || '=' || violaciones from (
      select 'producto activo sin variante predeterminada' as invariante, count(*) as violaciones
      from public.products p where p.code like 'VOLQ-%' and p.is_active
        and not exists (select 1 from public.product_variants v
                        where v.product_id = p.id and v.is_default and v.is_active)
      union all
      select 'variante activa sin SKU', count(*) from public.product_variants v
      where v.sku like 'VOLQ-%' and v.is_active and coalesce(length(trim(v.sku)), 0) = 0
      union all
      select 'variante disponible sin precio minorista', count(*)
      from public.product_variants v join public.products p on p.id = v.product_id
      where p.code like 'VOLQ-%' and v.is_active and v.availability_status = 'available'
        and not exists (select 1 from public.variant_prices vp
                        join public.price_lists pl on pl.id = vp.price_list_id
                        where vp.variant_id = v.id and vp.is_active and vp.validity @> now()
                          and pl.is_active and pl.price_type = 'retail')
      union all
      select 'valor de atributo fuera de la plantilla', count(*)
      from public.variant_attribute_values vav
      join public.product_variants v on v.id = vav.variant_id
      join public.products p on p.id = v.product_id
      where v.sku like 'VOLQ-%'
        and not exists (select 1 from public.template_attributes ta
                        where ta.template_id = p.template_id
                          and ta.attribute_definition_id = vav.attribute_definition_id)
      union all
      select 'variante del volumen sin documento de busqueda', count(*)
      from public.product_variants v
      where v.sku like 'VOLQ-%'
        and not exists (select 1 from public.variant_search_projection p where p.variant_id = v.id)
      union all
      select 'variante del volumen sin sus codigos', count(*)
      from public.product_variants v
      where v.sku like 'VOLQ-%'
        and not exists (select 1 from public.variant_search_codes c where c.variant_id = v.id)
      union all
      select 'producto del volumen sin fila en el catalogo', count(*)
      from public.products p
      where p.code like 'VOLQ-%'
        and not exists (select 1 from public.product_catalog_projection c where c.product_id = p.id)
    ) z order by 1;
  `);

  const violaciones = salida.split("\n").map((l) => l.trim()).filter(Boolean)
    .map((linea) => {
      const [invariante, valor] = linea.split("=");
      return { invariante, valor: Number(valor) };
    })
    .filter((fila) => fila.valor > 0);

  if (violaciones.length > 0) {
    console.error("\nEl volumen sembrado viola invariantes del catálogo:");
    for (const v of violaciones) console.error(`  ✗ ${v.invariante}: ${v.valor}`);
    throw new Error("Medir sobre un volumen inválido no significa nada.");
  }
  console.log("  invariantes del catálogo: en cero ✓");
}

// ---------------------------------------------------------------------------
// 2. Que los planes usen los índices
// ---------------------------------------------------------------------------
// Un tiempo bueno con un plan malo es un tiempo bueno por accidente: cambia el
// volumen o las estadísticas y se cae. Estas comprobaciones fijan el PLAN, no
// el reloj. Si un día el planificador deja de usar el índice trigrama, falla
// aquí con el motivo, en vez de fallar dentro de seis meses con un cronómetro.

const PLANES = [
  {
    nombre: "documento de variante → índice trigrama de la proyección",
    sql: `select count(*) from public.variant_search_projection p
          where p.search_document like '%esmalte%';`,
    espera: "variant_search_projection_trgm_idx"
  },
  {
    nombre: "documento de producto → índice trigrama de la proyección",
    sql: `select count(*) from public.product_catalog_projection p
          where p.search_document like '%esmalte%';`,
    espera: "product_catalog_projection_trgm_idx"
  },
  {
    nombre: "documento de persona → índice trigrama",
    sql: `select count(*) from public.persons p where p.search_document like '%ros%';`,
    espera: "persons_search_document_trgm_idx"
  },
  {
    nombre: "término corto → índice de prefijo de la proyección de códigos",
    sql: `select count(*) from public.variant_search_codes c
          where c.normalized_code like 'r4%';`,
    espera: "variant_search_codes_prefix_idx"
  }
];

function comprobarPlanes() {
  console.log("\nPlanes (que el índice se use, no solo que el reloj salga bien):\n");
  const fallos = [];
  for (const caso of PLANES) {
    let plan = "";
    try {
      plan = psql(`explain (analyze, buffers) ${caso.sql}`);
    } catch (error) {
      fallos.push({ ...caso, motivo: error.message });
      console.log(`✗ ${caso.nombre}: no se pudo planificar`);
      continue;
    }
    const usa = plan.includes(caso.espera);
    if (!usa) fallos.push({ ...caso, plan });
    console.log(`${usa ? "✓" : "✗"} ${caso.nombre}`);
    if (!usa) {
      console.log(`    esperaba «${caso.espera}» y el plan fue:`);
      console.log(plan.split("\n").slice(0, 6).map((l) => `    ${l}`).join("\n"));
    }
  }
  return fallos;
}

// ---------------------------------------------------------------------------
// 3. Mediciones
// ---------------------------------------------------------------------------

async function cronometrar(fn) {
  const tiempos = [];
  for (let i = 0; i < CORRIDAS; i += 1) {
    const inicio = performance.now();
    await fn();
    tiempos.push(Math.round(performance.now() - inicio));
  }
  const ordenados = [...tiempos].sort((a, b) => a - b);
  return { mediana: ordenados[Math.floor(ordenados.length / 2)], peor: ordenados[ordenados.length - 1] };
}

async function medirTodo() {
  const sesion = await asAdmin.auth.signInWithPassword({
    email: "demo-admin@local.invalid",
    password: "Demo-Admin-2026!"
  });
  if (sesion.error) throw new Error(`Sesión admin: ${sesion.error.message}`);

  const sede = must(
    await service.from("branches").select("id").eq("is_default", true).limit(1).single(),
    "sede"
  );
  const productoConTonos = psql(`
    select p.id::text from public.products p
    join public.product_variants v on v.product_id = p.id and v.is_active
    where p.is_active group by p.id order by count(*) desc limit 1;
  `);

  // Los términos cubren las formas en que falla una búsqueda, no solo la fácil.
  const superficies = [
    {
      nombre: "Catálogo público · listado sin término",
      correr: async () => must(await service.rpc("catalog_list_v2", {
        p_page: 1, p_page_size: 24, p_search: null, p_brand_slug: null,
        p_category_path: null, p_availability: null, p_attribute_filters: {}, p_sort: "featured"
      }), "listado"),
      explicar: `select public.catalog_list_v2(1, 24, null, null, null, null, '{}'::jsonb, 'featured');`
    },
    ...[
      ["poco selectivo", "esmalte"],
      ["muy selectivo", "VOLQ-050000"],
      ["por color", "rojo"],
      ["por tipo", "torno"],
      ["con tilde", "lámpara"],
      ["sin tilde", "lampara"],
      ["de dos letras", "ml"]
    ].map(([forma, termino]) => ({
      nombre: `Catálogo público · búsqueda ${forma} («${termino}»)`,
      correr: async () => must(await service.rpc("catalog_list_v2", {
        p_page: 1, p_page_size: 24, p_search: termino, p_brand_slug: null,
        p_category_path: null, p_availability: null, p_attribute_filters: {}, p_sort: "featured"
      }), `búsqueda ${termino}`),
      explicar: `select public.catalog_list_v2(1, 24, '${termino}', null, null, null, '{}'::jsonb, 'featured');`
    })),
    ...[
      ["poco selectivo", "esmalte"],
      ["muy selectivo", "VOLQ-050000"],
      ["por color", "rojo"],
      ["por talla", "mediano"],
      ["por tipo", "torno"],
      ["con tilde", "lámpara"],
      ["sin tilde", "lampara"],
      ["de dos letras", "ml"]
    ].map(([forma, termino]) => ({
      nombre: `POS · buscador ${forma} («${termino}»)`,
      correr: async () => must(await asAdmin.rpc("pos_variant_search", {
        p_branch_id: sede.id, p_query: termino, p_limit: 24
      }), `pos ${termino}`),
      explicar: null
    })),
    {
      nombre: "POS · buscador de clientas («ros»)",
      correr: async () => must(await asAdmin.rpc("pos_search_persons", { p_query: "ros", p_limit: 8 }), "personas"),
      explicar: `select public.pos_search_persons('ros', 8);`
    },
    {
      nombre: "POS · carta de tonos de un producto",
      correr: async () => must(await asAdmin.rpc("pos_product_tones", {
        p_branch_id: sede.id, p_product_id: productoConTonos
      }), "tonos"),
      explicar: null
    },
    {
      nombre: "Existencias · tablero con término («esmalte»)",
      correr: async () => must(await asAdmin.rpc("inventory_board", {
        p_branch_id: sede.id, p_query: "esmalte", p_from: null, p_to: null,
        p_only_reposition: false, p_limit: 50
      }), "tablero"),
      explicar: null
    }
  ];

  console.log(`\nMediciones · ${CORRIDAS} corridas por superficie · umbral ${UMBRAL_MS} ms en el PEOR caso\n`);
  const filas = [];
  for (const superficie of superficies) {
    let resultado;
    try {
      resultado = await cronometrar(superficie.correr);
    } catch (error) {
      console.log(`✗ ${superficie.nombre}: ERROR — ${error.message}`);
      filas.push({ ...superficie, mediana: null, peor: null, pasa: false, error: error.message });
      continue;
    }
    const pasa = resultado.peor <= UMBRAL_MS;
    filas.push({ ...superficie, ...resultado, pasa });
    console.log(
      `${pasa ? "✓" : "✗"} ${superficie.nombre}: peor ${resultado.peor} ms · mediana ${resultado.mediana} ms`
    );
    if (!pasa && superficie.explicar) {
      console.log(`\n--- EXPLAIN (ANALYZE, BUFFERS) — ${superficie.nombre} ---`);
      try {
        console.log(psql(`explain (analyze, buffers) ${superficie.explicar}`));
      } catch (error) {
        console.log(`(no se pudo obtener el plan: ${error.message})`);
      }
      console.log("---\n");
    }
  }
  return filas;
}

// ---------------------------------------------------------------------------

let filas = [];
let fallosDePlan = [];
try {
  if (!SKIP_SEED) sembrarVolumen(PRODUCTOS);
  verificarVolumen();
  fallosDePlan = comprobarPlanes();

  const volumen = psql(`
    select (select count(*) from public.products where is_active and editorial_status='published')
        || ' productos publicados · '
        || (select count(*) from public.product_variants) || ' variantes · '
        || (select count(*) from public.variant_attribute_values) || ' valores de atributo';
  `);
  console.log(`\nVolumen medido: ${volumen}`);

  filas = await medirTodo();
} finally {
  if (!KEEP) {
    console.log("\nRetirando el volumen…");
    try {
      limpiarVolumen();
    } catch (error) {
      console.error(`No se pudo retirar el volumen: ${error.message}`);
    }
  } else {
    console.log("\nVolumen conservado (--keep).");
  }
}

mkdirSync(path.join(ROOT, "test-results"), { recursive: true });
writeFileSync(
  path.join(ROOT, "test-results", "gate-busqueda.md"),
  [
    "# Gate de búsqueda · RNF-1",
    "",
    `Umbral: **${UMBRAL_MS} ms en el peor caso** de ${CORRIDAS} corridas, con ${PRODUCTOS.toLocaleString("es-PE")} productos sembrados.`,
    "",
    "| Superficie | Peor | Mediana | Estado |",
    "|---|---|---|---|",
    ...filas.map((f) =>
      `| ${f.nombre} | ${f.peor ?? "—"} ms | ${f.mediana ?? "—"} ms | ${f.pasa ? "✓" : "✗"} |`
    ),
    ""
  ].join("\n")
);
console.log("Evidencia: test-results/gate-busqueda.md");

const fallos = filas.filter((f) => !f.pasa);
if (fallos.length > 0) {
  console.error(`\n${fallos.length} superficie(s) por encima de ${UMBRAL_MS} ms en el peor caso.`);
}
if (fallosDePlan.length > 0) {
  console.error(`${fallosDePlan.length} consulta(s) no usan el índice que deberían.`);
}
if (fallos.length > 0 || fallosDePlan.length > 0) process.exit(1);

console.log(`\nTODAS las superficies por debajo de ${UMBRAL_MS} ms en el peor caso,`);
console.log("y todas las consultas comprobadas usan su índice.");
