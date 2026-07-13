// Optimiza logo + fotos de producto + cartas + logos de pago con sharp.
// Salida: catalog-preview/assets/**  y  public/brand/** (logo para la app).
// Uso: node scripts/optimize-assets.mjs
import sharp from "sharp";
import { readdir, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS, PAYMENTS } from "./catalog-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SRC = "F:\\products\\Bella Roshe\\Catalogo";
const LOGO_SRC = path.join(SRC, "ChatGPT Image 13 jul 2026, 01_42_50 a.m.png");
const PRODUCTS_SRC = path.join(SRC, "imagenes_productos");
const PAY_SRC = path.join(SRC, "metodos_pago");

const OUT = path.join(ROOT, "catalog-preview", "assets");
const PUBLIC_BRAND = path.join(ROOT, "public", "brand");

sharp.cache(false);
sharp.concurrency(1);

async function ensure(dir) {
  await mkdir(dir, { recursive: true });
}

function sizeKb(info) {
  return (info.size / 1024).toFixed(0);
}

async function optimizeLogo() {
  await ensure(path.join(OUT, "brand"));
  await ensure(PUBLIC_BRAND);
  // Logo con transparencia -> recortar borde transparente.
  const base = sharp(LOGO_SRC).trim({ threshold: 10 });
  const meta = await base.metadata();
  console.log(`Logo recortado -> ${meta.width}x${meta.height}`);

  const variants = [
    { name: "logo-hero", width: 760 }, // portada
    { name: "logo", width: 360 }, // topbar / fichas
    { name: "logo-sm", width: 180 }, // usos pequeños
  ];

  for (const v of variants) {
    const png = await sharp(LOGO_SRC)
      .trim({ threshold: 10 })
      .resize({ width: v.width, withoutEnlargement: true })
      .png({ quality: 90, compressionLevel: 9, palette: true })
      .toFile(path.join(OUT, "brand", `${v.name}.png`));
    const webp = await sharp(LOGO_SRC)
      .trim({ threshold: 10 })
      .resize({ width: v.width, withoutEnlargement: true })
      .webp({ quality: 90, alphaQuality: 100 })
      .toFile(path.join(OUT, "brand", `${v.name}.webp`));
    console.log(`  ${v.name}: png ${sizeKb(png)}KB · webp ${sizeKb(webp)}KB`);
  }

  // Copia para la app Next.js
  for (const f of ["logo.png", "logo.webp", "logo-hero.png", "logo-hero.webp", "logo-sm.png"]) {
    await copyFile(path.join(OUT, "brand", f), path.join(PUBLIC_BRAND, f));
  }
  console.log(`  -> copiado a public/brand/`);
}

async function optimizeProducts() {
  for (const p of PRODUCTS) {
    const dir = path.join(PRODUCTS_SRC, p.folder);
    const outDir = path.join(OUT, "products", p.folder);
    await ensure(outDir);

    const all = (await readdir(dir)).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
    const cartaFile = all.find((f) => /carta/i.test(f));
    const fotos = all.filter((f) => !/carta/i.test(f)).sort();

    console.log(`\n${p.folder}  (${fotos.length} fotos${cartaFile ? " + carta" : " · SIN carta"})`);

    let i = 0;
    for (const f of fotos) {
      i += 1;
      const info = await sharp(path.join(dir, f))
        .resize({ width: 1100, height: 1100, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toFile(path.join(outDir, `foto-${i}.webp`));
      console.log(`  foto-${i}.webp  ${sizeKb(info)}KB`);
    }

    if (cartaFile) {
      const carta = await sharp(path.join(dir, cartaFile))
        .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(outDir, "carta.webp"));
      const thumb = await sharp(path.join(dir, cartaFile))
        .resize({ width: 640, height: 640, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toFile(path.join(outDir, "carta-thumb.webp"));
      console.log(`  carta.webp  ${sizeKb(carta)}KB · carta-thumb.webp ${sizeKb(thumb)}KB`);
    }
  }
}

async function optimizePayments() {
  const outDir = path.join(OUT, "pagos");
  await ensure(outDir);
  const files = await readdir(PAY_SRC);
  for (const name of PAYMENTS) {
    const file = files.find((f) => f.toLowerCase().startsWith(name));
    if (!file) {
      console.log(`  (pago no encontrado: ${name})`);
      continue;
    }
    const info = await sharp(path.join(PAY_SRC, file))
      .resize({ width: 240, height: 130, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 88 })
      .toFile(path.join(outDir, `${name}.webp`));
    console.log(`  pago ${name}.webp  ${sizeKb(info)}KB`);
  }
}

console.log("== Optimizando logo ==");
await optimizeLogo();
console.log("\n== Optimizando productos ==");
await optimizeProducts();
console.log("\n== Optimizando medios de pago ==");
await optimizePayments();
console.log("\n✅ Listo. Assets en catalog-preview/assets/ y logo en public/brand/");
