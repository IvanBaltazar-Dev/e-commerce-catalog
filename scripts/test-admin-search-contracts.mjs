/**
 * Las dos búsquedas del admin, por HTTP y con sesión real.
 *
 * 0083 las llevó a contrato: `admin_product_search` y `admin_relation_search`.
 * Comprobarlo en la base no basta — lo que hay que probar es que la RUTA las
 * usa y devuelve lo mismo que la pantalla espera, incluido el ORDEN, que un
 * `in (...)` de PostgREST no conserva.
 *
 * Lo que se afirma:
 *
 *   · «lámpara» y «lampara» encuentran lo mismo. Con el `.or(ilike)` anterior
 *     era imposible: no quitaba tildes.
 *   · El orden que devuelve la ruta es el del contrato, no el que le apetezca
 *     a PostgREST.
 *   · El total es el del conjunto filtrado, no el de la página.
 *   · Un término de dos letras no devuelve medio catálogo.
 *   · Los filtros por estado y por marca siguen funcionando.
 *
 * Uso:  E2E_BASE_URL=http://127.0.0.1:3005 node scripts/test-admin-search-contracts.mjs
 */
import { createClient } from "@supabase/supabase-js";
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";
import { resolveBrowserExecutable } from "./lib/resolve-browser.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "test-admin-search-contracts" });
if (!isLocal) throw new Error("Solo corre contra Supabase local.");

const baseUrl = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3000";
const ADMIN = { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!" };
const service = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

let fallos = 0;
function check(descripcion, condicion, detalle = "") {
  const ok = Boolean(condicion);
  if (!ok) fallos += 1;
  console.log(`  ${ok ? "ok  " : "FALLA"} ${descripcion}${detalle ? ` — ${detalle}` : ""}`);
}

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: await resolveBrowserExecutable(),
  args: ["--no-sandbox"]
});

try {
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(60000);

  console.log("\n0. Entrar al panel");
  // Igual que `signInToPanel`, pero sin exigir una ruta EXACTA: la dueña no
  // aterriza siempre en el mismo sitio y esta prueba no va de eso. Lo que sí se
  // conserva es esperar a `networkidle0`: con `domcontentloaded` se pulsa antes
  // de que React hidrate, el navegador envía el formulario de forma nativa y la
  // redirección no ocurre nunca.
  let entrado = false;
  for (let intento = 1; intento <= 4 && !entrado; intento += 1) {
    await page.goto(`${baseUrl}/admin/login`, { waitUntil: "networkidle0", timeout: 90000 });
    await page.waitForSelector('input[type="email"]');
    await page.$eval('input[type="email"]', (nodo) => { nodo.value = ""; });
    await page.$eval('input[type="password"]', (nodo) => { nodo.value = ""; });
    await page.type('input[type="email"]', ADMIN.email);
    await page.type('input[type="password"]', ADMIN.password);
    await page.click('button[type="submit"]');
    try {
      // El formulario es un componente cliente: si se envía antes de hidratar,
      // el navegador hace un envío nativo y la redirección nunca ocurre.
      await page.waitForFunction(() => window.location.pathname.startsWith("/admin")
        && !window.location.pathname.includes("/login"), { timeout: 25000 });
      entrado = true;
    } catch {
      // Se reintenta: el segundo intento corre sobre una ruta ya compilada.
    }
  }
  check("la dueña entra al panel", entrado);
  if (!entrado) throw new Error("No se pudo iniciar sesión en el panel.");

  /** Llama a la API con la sesión del navegador. */
  async function api(ruta) {
    return page.evaluate(async (url) => {
      const respuesta = await fetch(url, { credentials: "include" });
      return { estado: respuesta.status, cuerpo: await respuesta.json() };
    }, `${baseUrl}${ruta}`);
  }

  console.log("\n1. La tilde deja de importar");
  const conTilde = await api("/api/admin/products?q=l%C3%A1mpara&limit=50");
  const sinTilde = await api("/api/admin/products?q=lampara&limit=50");
  check("«lámpara» responde 200", conTilde.estado === 200, `estado ${conTilde.estado}`);
  check("«lampara» responde 200", sinTilde.estado === 200, `estado ${sinTilde.estado}`);
  check(
    "con y sin tilde encuentran LO MISMO",
    conTilde.cuerpo?.data?.total === sinTilde.cuerpo?.data?.total && conTilde.cuerpo?.data?.total > 0,
    `${conTilde.cuerpo?.data?.total} vs ${sinTilde.cuerpo?.data?.total}`
  );

  console.log("\n2. El orden es el del contrato, no el de PostgREST");
  const { data: esperado, error } = await service.rpc("admin_product_search", {
    p_query: "lampara", p_estado: null, p_active: null, p_brand_id: null, p_limit: 50, p_offset: 0
  });
  if (error) throw new Error(`contrato: ${error.message}`);
  const idsRuta = (sinTilde.cuerpo?.data?.items ?? []).map((p) => p.id);
  check(
    "la ruta devuelve los ids del contrato en su orden",
    JSON.stringify(idsRuta) === JSON.stringify(esperado.ids),
    `${idsRuta.length} ids`
  );

  console.log("\n3. El total es del conjunto, no de la página");
  const pagina = await api("/api/admin/products?q=lampara&limit=3");
  check("la página trae 3 como mucho", (pagina.cuerpo?.data?.items ?? []).length <= 3);
  check(
    "y el total sigue siendo el del conjunto entero",
    pagina.cuerpo?.data?.total === sinTilde.cuerpo?.data?.total,
    `${pagina.cuerpo?.data?.total} vs ${sinTilde.cuerpo?.data?.total}`
  );

  console.log("\n4. Dos letras no devuelven medio catálogo");
  const todos = await api("/api/admin/products?limit=1");
  const dosLetras = await api("/api/admin/products?q=ml&limit=50");
  check(
    "«ml» devuelve muchos menos que el catálogo entero",
    dosLetras.cuerpo?.data?.total < todos.cuerpo?.data?.total,
    `${dosLetras.cuerpo?.data?.total} de ${todos.cuerpo?.data?.total}`
  );

  console.log("\n5. Los filtros siguen en pie");
  const borrador = await api("/api/admin/products?estado=borrador&limit=1");
  const publicado = await api("/api/admin/products?estado=publicado&limit=1");
  check("el filtro por estado separa borrador de publicado",
    borrador.cuerpo?.data?.total !== publicado.cuerpo?.data?.total,
    `borrador ${borrador.cuerpo?.data?.total} · publicado ${publicado.cuerpo?.data?.total}`);
  check("borrador y publicado suman como mucho el catálogo",
    (borrador.cuerpo?.data?.total ?? 0) + (publicado.cuerpo?.data?.total ?? 0) <= (todos.cuerpo?.data?.total ?? 0));

  console.log("\n6. El buscador de relaciones responde por contrato");
  const relTilde = await api("/api/admin/catalog-v2/relations?q=l%C3%A1mpara&scope=all");
  const relSinTilde = await api("/api/admin/catalog-v2/relations?q=lampara&scope=all");
  check("responde 200", relSinTilde.estado === 200, `estado ${relSinTilde.estado}`);
  check("y devuelve productos", (relSinTilde.cuerpo?.data ?? []).length > 0,
    `${(relSinTilde.cuerpo?.data ?? []).length} candidatos`);
  check("con y sin tilde devuelve lo mismo",
    (relTilde.cuerpo?.data ?? []).length === (relSinTilde.cuerpo?.data ?? []).length,
    `${(relTilde.cuerpo?.data ?? []).length} vs ${(relSinTilde.cuerpo?.data ?? []).length}`);
  check("y en el orden del contrato (por nombre)",
    (relSinTilde.cuerpo?.data ?? []).map((p) => p.name).join("|")
      === [...(relSinTilde.cuerpo?.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "es")).map((p) => p.name).join("|"));
} finally {
  await browser.close();
}

console.log(
  fallos === 0
    ? "\nPASS · las dos búsquedas del admin pasan por contrato y devuelven lo que la pantalla espera"
    : `\n${fallos} comprobación(es) fallida(s)`
);
process.exit(fallos === 0 ? 0 : 1);
