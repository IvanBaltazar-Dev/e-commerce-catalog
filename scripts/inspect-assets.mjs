// Inspección de assets (logo + imágenes de producto) con sharp.
// Uso: node scripts/inspect-assets.mjs
import sharp from "sharp";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const SRC = "F:\\products\\Bella Roshe\\Catalogo";
const LOGO = path.join(SRC, "ChatGPT Image 13 jul 2026, 01_42_50 a.m.png");
const PRODUCTS = path.join(SRC, "imagenes_productos");

function kb(bytes) {
  return (bytes / 1024).toFixed(0);
}

async function inspect(file) {
  try {
    const [meta, st] = await Promise.all([sharp(file).metadata(), stat(file)]);
    return {
      w: meta.width,
      h: meta.height,
      fmt: meta.format,
      alpha: meta.hasAlpha ? "alpha" : "opaque",
      kb: kb(st.size),
    };
  } catch (e) {
    return { error: e.message };
  }
}

const logo = await inspect(LOGO);
console.log("LOGO:", JSON.stringify(logo));

const dirs = (await readdir(PRODUCTS, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && /^\d\d-/.test(d.name))
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  const full = path.join(PRODUCTS, dir);
  const files = (await readdir(full)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  console.log(`\n== ${dir} ==`);
  for (const f of files.sort()) {
    const info = await inspect(path.join(full, f));
    const tag = /carta/i.test(f) ? "[CARTA]" : "[foto] ";
    console.log(`  ${tag} ${f}  ->  ${JSON.stringify(info)}`);
  }
}
