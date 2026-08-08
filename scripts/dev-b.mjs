// Segundo dev server aislado: puerto 3005 y build en .next-b para no pisar el
// .next de otra sesión de desarrollo activa en la misma carpeta.
import { spawn } from "node:child_process";

const child = spawn("npx", ["next", "dev", "-p", "3005"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_DIST_DIR: ".next-b" }
});
child.on("exit", (code) => process.exit(code ?? 0));
