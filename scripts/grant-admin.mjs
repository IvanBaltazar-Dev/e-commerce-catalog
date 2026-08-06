// Registra un usuario de Supabase Auth en admin_profiles.
// El usuario debe existir ya en Authentication → Users (lo creas tú en el dashboard).
// Uso local: node scripts/grant-admin.mjs [email] [admin|developer] --env .env.supabase.local
import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, positionals } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "grant-admin"
});
const email = (positionals[0] || "admin@bellaroshe.pe").toLowerCase();
const role = (positionals[1] || "admin").toLowerCase();

if (!new Set(["admin", "developer"]).has(role)) {
  throw new Error("El rol debe ser admin o developer.");
}
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Busca el usuario por email (recorre páginas si hace falta).
let user = null;
for (let page = 1; page <= 20 && !user; page += 1) {
  const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
  if (error) {
    console.error("Error listando usuarios:", error.message);
    process.exit(1);
  }
  user = data.users.find((u) => (u.email || "").toLowerCase() === email);
  if (data.users.length < 200) break;
}

if (!user) {
  console.error(`\n❌ No existe un usuario Auth con email "${email}".`);
  console.error("   Créalo primero en Supabase → Authentication → Users → Add user");
  console.error("   (marca 'Auto Confirm User'), luego vuelve a correr este script.\n");
  process.exit(1);
}

const { error: upErr } = await admin
  .from("admin_profiles")
  .upsert({ id: user.id, role, full_name: role === "developer" ? "Developer Bellaroshé" : "Admin Bellaroshé" }, { onConflict: "id" });

if (upErr) {
  console.error("Error registrando admin_profiles:", upErr.message);
  process.exit(1);
}

console.log(`\n✅ ${email} ahora tiene el rol ${role.toUpperCase()}.`);
console.log(`   UUID: ${user.id}`);
console.log(`   Confirmado: ${user.email_confirmed_at ? "sí" : "NO — actívalo con Auto Confirm o email"}`);
console.log(`   Entra en http://localhost:3000/admin/login\n`);
