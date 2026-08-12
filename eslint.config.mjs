import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname
});

// ESLint no lee .gitignore: necesita su propia lista. Sin ella `eslint .`
// recorre la salida de compilación y devuelve miles de hallazgos sobre código
// generado, con lo que `npm run lint` deja de ser una señal utilizable.
// Regla al añadir aquí: si está en .gitignore por ser generado, copiado o
// metadato de herramienta, también va en esta lista.
const eslintConfig = [
  {
    ignores: [
      // Compilación: `.next` y los builds aislados por sesión de desarrollo
      // (.next-a … .next-d, ver scripts/serve-a.mjs). El comodín cubre los
      // que se creen más adelante.
      ".next/**",
      ".next-*/**",
      "out/**",
      "dist/**",
      "coverage/**",
      "node_modules/**",
      // Generados por Next/TypeScript.
      "next-env.d.ts",
      "tsconfig.tsbuildinfo",
      // Metadatos de herramientas. .claude/worktrees guarda copias completas
      // del repo: sin ignorarlo, cada hallazgo se contaría dos veces y con la
      // configuración de otra rama.
      ".claude/**",
      ".serena/**",
      ".agents/**",
      ".codex/**",
      // Material local y salidas de scripts, no código de la aplicación.
      "tmp/**",
      "output/**",
      "outputs/**",
      "backups/**",
      "test-results/**"
    ]
  },
  ...compat.extends("next/core-web-vitals", "next/typescript")
];

export default eslintConfig;
