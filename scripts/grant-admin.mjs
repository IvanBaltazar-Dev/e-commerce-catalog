// Registra un usuario de Supabase Auth como administrador en admin_profiles.
// El usuario debe existir ya en Authentication → Users (lo creas tú en el dashboard).
// Uso: node scripts/grant-admin.mjs [email]   (por defecto admin@bellaroshe.pe)
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    })
);

const email = (process.argv[2] || "admin@bellaroshe.pe").toLowerCase();
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
  .upsert({ id: user.id, role: "admin", full_name: "Admin Bellaroshé" }, { onConflict: "id" });

if (upErr) {
  console.error("Error registrando admin_profiles:", upErr.message);
  process.exit(1);
}

console.log(`\n✅ ${email} ahora es ADMIN.`);
console.log(`   UUID: ${user.id}`);
console.log(`   Confirmado: ${user.email_confirmed_at ? "sí" : "NO — actívalo con Auto Confirm o email"}`);
console.log(`   Entra en http://localhost:3000/admin/login\n`);
