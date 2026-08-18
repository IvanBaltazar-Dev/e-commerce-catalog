// Deja el entorno local listo para iniciar sesión: propietaria y vendedora con
// perfiles reales y la vendedora asignada a la sede principal.
//
// Uso: node scripts/seed-demo-operation.mjs --env .env.supabase.local
//
// Los productos e inventarios demostrativos quedaron separados de este seed:
// una cuenta local de prueba no debe contaminar el catálogo comercial.

import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({ rootDir: ROOT, scriptName: "seed-demo-operation" });

if (!isLocal) {
  throw new Error("El seed de operación demo solo se ejecuta contra Supabase local.");
}

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const PEOPLE = [
  { email: "demo-admin@local.invalid", password: "Demo-Admin-2026!", role: "admin", name: "Propietaria demo" },
  { email: "demo-seller@local.invalid", password: "Demo-Seller-2026!", role: "seller", name: "Vendedora demo" }
];

function must(result, label) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function ensurePerson({ email, password, role, name }) {
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
  } else {
    const updated = await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true });
    if (updated.error) throw updated.error;
  }

  must(
    await admin.from("admin_profiles").upsert({ id: user.id, role, full_name: name }, { onConflict: "id" }),
    `perfil de ${email}`
  );

  return user.id;
}

await ensurePerson(PEOPLE[0]);
const sellerId = await ensurePerson(PEOPLE[1]);

const branches = must(
  await admin.from("branches").select("id, code, name, is_default").eq("is_active", true),
  "sedes activas"
);
const mainBranch = branches.find((branch) => branch.is_default) ?? branches[0];
if (!mainBranch) throw new Error("No hay ninguna sede activa: revisa la migración 0024.");

// La vendedora solo alcanza las sedes asignadas: sin esta fila, register_sale
// la rechaza con 42501 y la pantalla se queda sin sedes que ofrecer.
must(
  await admin
    .from("staff_branches")
    .upsert({ staff_id: sellerId, branch_id: mainBranch.id, is_primary: true }, { onConflict: "staff_id,branch_id" }),
  "asignación de sede"
);

// Límite de descuento de la vendedora: restricción automática, no aprobación.
must(
  await admin.from("admin_profiles").update({ max_discount_percent: 10 }).eq("id", sellerId),
  "límite de descuento"
);

console.log("Acceso local listo en Supabase.");
console.log(`  Sede            ${mainBranch.name} (${mainBranch.code})`);
console.log(`  Propietaria     ${PEOPLE[0].email} / ${PEOPLE[0].password}`);
console.log(`  Vendedora       ${PEOPLE[1].email} / ${PEOPLE[1].password}`);
