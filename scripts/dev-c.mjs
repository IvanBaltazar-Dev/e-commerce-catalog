// Tercer dev server aislado: puerto 3006 y build en .next-c. Mismo motivo que
// dev-b.mjs — dos sesiones de desarrollo trabajando a la vez en esta carpeta se
// pisan el .next y una recompila lo que la otra está sirviendo. Con tres
// ranuras (dev, dev:b, dev:c) caben tres sin negociar puerto ni carpeta.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--turbopack", "-p", "3006"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-c" }
});
child.on("exit", (code) => process.exit(code ?? 0));
