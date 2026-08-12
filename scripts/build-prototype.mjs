// Build de revisión aislado: no comparte artefactos con ningún `next dev`.
import { spawn } from "node:child_process";

const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "build"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_DIST_DIR: ".next-prototype" },
});

child.on("exit", (code) => process.exit(code ?? 0));
