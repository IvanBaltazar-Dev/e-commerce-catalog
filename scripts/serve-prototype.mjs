// Sirve la UX real en 3005 sin compilar rutas al primer clic.
// Ejecutar antes `npm run prototype:build`.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3005"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-prototype" },
});

child.on("exit", (code) => process.exit(code ?? 0));
