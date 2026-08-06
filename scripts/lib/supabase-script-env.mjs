import { readFileSync } from "node:fs";
import path from "node:path";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function parseEnvFile(filePath) {
  return Object.fromEntries(
    readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        const key = line.slice(0, separator).trim();
        let value = line.slice(separator + 1).trim();

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        return [key, value];
      })
  );
}

function parseArgs(argv) {
  const options = {
    envFile: ".env.supabase.local",
    allowRemote: false,
    confirmProject: null,
    positionals: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--allow-remote") {
      options.allowRemote = true;
      continue;
    }

    if (argument === "--env") {
      const value = argv[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("--env requiere una ruta de archivo.");
      }

      options.envFile = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--env=")) {
      options.envFile = argument.slice("--env=".length);
      continue;
    }

    if (argument === "--confirm-project") {
      const value = argv[index + 1];

      if (!value || value.startsWith("--")) {
        throw new Error("--confirm-project requiere el project ref esperado.");
      }

      options.confirmProject = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--confirm-project=")) {
      options.confirmProject = argument.slice("--confirm-project=".length);
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Argumento desconocido: ${argument}`);
    }

    options.positionals.push(argument);
  }

  return options;
}

function projectRef(url, env) {
  if (env.SUPABASE_PROJECT_REF?.trim()) {
    return env.SUPABASE_PROJECT_REF.trim();
  }

  const host = url.hostname.toLowerCase();
  const suffix = ".supabase.co";

  return host.endsWith(suffix) ? host.slice(0, -suffix.length) : null;
}

export function loadSupabaseScriptEnv({ rootDir, scriptName }) {
  const options = parseArgs(process.argv.slice(2));
  const envPath = path.resolve(rootDir, options.envFile);
  let env;

  try {
    env = parseEnvFile(envPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`No se pudo leer ${envPath}: ${detail}`);
  }

  const required = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY"
  ];
  const missing = required.filter((key) => !env[key]?.trim());

  if (missing.length > 0) {
    throw new Error(`Faltan variables en ${envPath}: ${missing.join(", ")}`);
  }

  let url;

  try {
    url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
  } catch {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL no es una URL válida.");
  }

  const local =
    LOCAL_HOSTS.has(url.hostname.toLowerCase()) &&
    url.protocol === "http:" &&
    url.port === "54321";
  const ref = projectRef(url, env);

  if (!local) {
    if (!options.allowRemote) {
      throw new Error(
        `Destino remoto bloqueado (${url.origin}). Usa --allow-remote y --confirm-project=<PROJECT_REF> solo con autorización explícita.`
      );
    }

    if (!ref) {
      throw new Error(
        "No se pudo deducir SUPABASE_PROJECT_REF. Decláralo en el archivo de entorno remoto."
      );
    }

    if (!options.confirmProject || options.confirmProject !== ref) {
      throw new Error(
        `Confirmación remota inválida. Se esperaba --confirm-project=${ref}.`
      );
    }
  }

  console.log(
    `[${scriptName}] Destino: ${local ? "LOCAL" : `REMOTO ${ref}`} · ${url.origin} · env ${envPath}`
  );

  return {
    env,
    envPath,
    isLocal: local,
    positionals: options.positionals,
    projectRef: ref
  };
}
