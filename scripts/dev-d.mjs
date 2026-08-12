// Cuarta ranura de desarrollo: puerto 3007 y build en .next-d. Mismo motivo que
// dev-b.mjs y dev-c.mjs — cada sesión que trabaja a la vez en esta carpeta
// necesita su puerto y su carpeta de build, o una recompila lo que la otra está
// sirviendo.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "--turbopack", "-p", "3007"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-d" }
});
child.on("exit", (code) => process.exit(code ?? 0));
