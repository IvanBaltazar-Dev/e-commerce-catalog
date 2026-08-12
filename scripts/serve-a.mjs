// Servidor de producción aislado: puerto 3002 y build en .next-a.
//
// Espejo de dev-b.mjs. Dos sesiones de desarrollo comparten esta carpeta y el
// `.next` por omisión es uno solo: un `next dev` ajeno lo reescribe y deja al
// `next start` de la otra sesión sirviendo un build que ya no existe. Cada una
// con su distDir y el problema desaparece.
//
// Uso: node scripts/serve-a.mjs   (construir antes con npm run build:a)
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3002"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-a" }
});
child.on("exit", (code) => process.exit(code ?? 0));
