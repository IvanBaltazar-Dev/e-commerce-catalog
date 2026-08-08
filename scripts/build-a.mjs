// Build de producción aislado en .next-a. Ver serve-a.mjs para el porqué.
import { spawn } from "node:child_process";

const child = spawn("npx", ["next", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_DIST_DIR: ".next-a" }
});
child.on("exit", (code) => process.exit(code ?? 0));
