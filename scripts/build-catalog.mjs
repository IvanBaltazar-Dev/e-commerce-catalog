// Genera el catálogo premium (catalog-preview/catalogo.html) desde los datos + assets optimizados.
// Uso: node scripts/build-catalog.mjs
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCTS, STORE, PAYMENTS, lampLabel, money } from "./catalog-data.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PREVIEW = path.join(ROOT, "catalog-preview");
const ASSETS = path.join(PREVIEW, "assets");

const wa = (text) => `https://wa.me/${STORE.whatsappLink}?text=${encodeURIComponent(text)}`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function fotosDe(folder) {
  const dir = path.join(ASSETS, "products", folder);
  const files = await readdir(dir);
  const fotos = files.filter((f) => /^foto-\d+\.jpg$/.test(f)).sort();
  const carta = files.includes("carta.jpg");
  return { fotos, carta };
}

const lampIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>`;
const dropIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/></svg>`;
const checkIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;
const waIcon = `<svg viewBox="0 0 32 32" fill="currentColor"><path d="M16 3C9 3 3.5 8.5 3.5 15.5c0 2.4.7 4.6 1.9 6.5L4 29l7.2-1.9c1.8 1 3.9 1.5 6 1.5 7 0 12.5-5.5 12.5-12.5S23 3 16 3zm0 22.7c-1.9 0-3.7-.5-5.3-1.5l-.4-.2-4.3 1.1 1.1-4.2-.2-.4a10 10 0 0 1-1.6-5.5C5.3 9.9 10 5.3 16 5.3s10.7 4.6 10.7 10.2S22 25.7 16 25.7zm5.9-7.6c-.3-.2-1.9-.9-2.2-1s-.5-.2-.7.2-.8 1-1 1.2-.4.3-.7.1a8.2 8.2 0 0 1-2.4-1.5 9 9 0 0 1-1.7-2.1c-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.3.3-.6s.1-.4 0-.6-.7-1.7-1-2.3c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.4-1.2 1.2-1.2 2.9s1.2 3.4 1.4 3.6c.2.3 2.5 3.8 6 5.3.8.4 1.5.6 2 .7.8.3 1.6.2 2.2.1.7-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5s-.3-.2-.6-.4z"/></svg>`;

function chip(icon, label, tone = "") {
  return `<span class="chip ${tone}">${icon}<span>${esc(label)}</span></span>`;
}

function coverPage() {
  const msg = `Hola ${STORE.brand}, vi su catálogo premium. Deseo cotizar productos al por mayor desde ${STORE.wholesaleFrom} unidades.`;
  return `
  <section class="page cover">
    <div class="cover-frame"></div>
    <div class="cover-glow glow-1"></div>
    <div class="cover-glow glow-2"></div>
    <div class="cover-inner">
      <div class="cover-logo">
        <img src="assets/brand/logo-hero.webp" alt="${esc(STORE.brand)}" />
      </div>
      <div class="orn"><i></i><span>&#10022;</span><i></i></div>
      <div class="cover-titles">
        <h1 class="cover-title">${esc(STORE.tagline)}</h1>
        <p class="cover-subtitle">${esc(STORE.subtitle)}</p>
      </div>
      <div class="cover-signals">
        <div class="signal"><span class="signal-k">Venta</span><span class="signal-v">Por mayor y menor</span></div>
        <div class="signal"><span class="signal-k">Precio mayor</span><span class="signal-v">Desde ${STORE.wholesaleFrom} unidades</span></div>
        <div class="signal"><span class="signal-k">Variedad</span><span class="signal-v">Set completo de tonos</span></div>
      </div>
      <a class="cover-cta" href="${wa(msg)}">${waIcon}<span>Cotizar por mayor · ${esc(STORE.whatsapp)}</span></a>
      <p class="cover-updated">Catálogo actualizado · ${esc(STORE.updatedLabel)} · ${esc(STORE.city)}</p>
    </div>
  </section>`;
}

function introPage() {
  const brands = [...new Set(PRODUCTS.map((p) => p.brand))];
  return `
  <section class="page intro">
    <div class="intro-top">
      <img class="intro-mini-logo" src="assets/brand/logo-sm.webp" alt="${esc(STORE.brand)}" />
      <span class="intro-eyebrow">Categoría</span>
    </div>
    <div class="intro-hero">
      <h2 class="intro-title">Esmaltes</h2>
      <p class="intro-lead">Una selección premium de esmaltes tradicionales y gel semipermanente de las mejores marcas, con tonos profesionales, acabados de salón y precios especiales por mayor.</p>
    </div>
    <div class="intro-brands">
      ${brands.map((b) => `<span class="brand-tag">${esc(b)}</span>`).join("")}
    </div>
    <div class="intro-stat">
      <span><b>${PRODUCTS.length}</b><small>líneas</small></span><i></i>
      <span><b>${brands.length}</b><small>marcas</small></span><i></i>
      <span><small>Tonos</small><b class="stat-word">Profesionales</b></span>
    </div>
    <div class="intro-note">
      <div class="note-card">
        ${checkIcon}
        <div><strong>Precio por mayor desde ${STORE.wholesaleFrom} unidades.</strong><span>Combina productos y tonos para alcanzar el mayor.</span></div>
      </div>
      <div class="note-card">
        ${dropIcon}
        <div><strong>Set completo de colores.</strong><span>Consulta la carta de tonos disponible en cada línea.</span></div>
      </div>
    </div>
  </section>`;
}

function galleryHtml(p, fotos) {
  const dir = `assets/products/${p.folder}`;
  const extras = fotos.slice(1, 4);
  const thumbs = extras
    .map((f) => `<div class="thumb"><img src="${dir}/${f}" alt="" /></div>`)
    .join("");
  return `
    <div class="gallery">
      <div class="gallery-main">
        <div class="gallery-halo"></div>
        <img src="${dir}/${fotos[0]}" alt="${esc(p.brand)} ${esc(p.line)}" />
        <span class="gallery-index">${String(p.order).padStart(2, "0")}</span>
      </div>
      ${extras.length ? `<div class="gallery-thumbs">${thumbs}</div>` : ""}
    </div>`;
}

function chartBlock(p, hasCarta) {
  if (p.chart === "available" && hasCarta) {
    return `
      <div class="chart chart-available">
        <div class="chart-thumb"><img src="assets/products/${p.folder}/carta-thumb.jpg" alt="Carta de colores ${esc(p.brand)}" /></div>
        <div class="chart-body">
          <span class="chart-tag">${checkIcon} Carta de colores disponible</span>
          <p>Elige tonos surtidos, set completo o códigos específicos.</p>
          <span class="chart-next">Carta completa en la página siguiente &rarr;</span>
        </div>
      </div>`;
  }
  const msg = `Hola ${STORE.brand}, estoy revisando ${p.brand} ${p.line} ${p.presentation}. ¿Me envían los colores disponibles?`;
  return `
    <div class="chart chart-consult">
      <div class="chart-body">
        <span class="chart-tag consult">${dropIcon} Amplia variedad de tonos</span>
        <p>Revisa la selección disponible para esta línea.</p>
        <a class="link-wa" href="${wa(msg)}">Ver tonos disponibles →</a>
      </div>
    </div>`;
}

function productPage(p, fotos, hasCarta) {
  const msg = `Hola ${STORE.brand}, me interesa ${p.brand} ${p.line} ${p.presentation}. ¿Me envías colores disponibles y precio por mayor desde ${STORE.wholesaleFrom} unidades?`;
  const lampTone = p.lamp === "no" ? "chip-ok" : "chip-gold";
  return `
  <section class="page product">
    <header class="p-head">
      <div>
        <span class="p-eyebrow">${esc(p.brand)}</span>
        <h3 class="p-name">${esc(p.line)}</h3>
      </div>
      <span class="p-present">${esc(p.presentation)}</span>
    </header>
    <div class="p-stage"><div class="p-body">
      <div class="p-left">
        ${galleryHtml(p, fotos)}
      </div>
      <div class="p-right">
        <div class="chips">
          ${chip(dropIcon, p.type)}
          ${chip(lampIcon, lampLabel(p.lamp), lampTone)}
          ${chip(checkIcon, "Disponible", "chip-ok")}
        </div>
        <p class="p-desc">${esc(p.description)}</p>
        <div class="price-card">
          <div class="price-col">
            <span class="price-k">Precio unidad</span>
            <span class="price-v">${money(p.unit)}</span>
          </div>
          <div class="price-div"></div>
          <div class="price-col price-major">
            <span class="price-k">Precio mayor</span>
            <span class="price-v">${money(p.wholesale)}</span>
          </div>
        </div>
        ${chartBlock(p, hasCarta)}
        <a class="btn-wa" href="${wa(msg)}">${waIcon}<span>Elegir tonos y cotizar</span></a>
      </div>
    </div></div>
    <footer class="p-foot">
      <img src="assets/brand/logo-sm.webp" alt="" />
      <span>${esc(STORE.legalName)}</span>
      <span class="dot">•</span>
      <span>wa.me/${STORE.whatsappLink}</span>
      <span class="p-num">${String(p.order).padStart(2, "0")} / ${String(PRODUCTS.length).padStart(2, "0")}</span>
    </footer>
  </section>`;
}

function cartaPage(p) {
  const msg = `Hola ${STORE.brand}, vi la carta de colores de ${p.brand} ${p.line} ${p.presentation}. Mi selección de tonos y cantidades es:`;
  return `
  <section class="page carta">
    <header class="p-head">
      <div>
        <span class="p-eyebrow">${esc(p.brand)} &middot; ${esc(p.presentation)}</span>
        <h3 class="p-name">Carta de colores</h3>
      </div>
      <span class="p-present">${esc(p.line)}</span>
    </header>
    <div class="c-stage">
      <figure class="c-figure">
        <img src="assets/products/${p.folder}/carta.jpg" alt="Carta de colores ${esc(p.brand)} ${esc(p.line)}" />
      </figure>
    </div>
    <div class="c-actions">
      <p class="c-hint">Elige <b>tonos surtidos</b>, <b>set completo</b> o <b>códigos específicos</b> &mdash; indícanos los tonos y la cantidad y te confirmamos stock y precio final.</p>
      <a class="btn-wa" href="${wa(msg)}">${waIcon}<span>Cotizar mi selección</span></a>
    </div>
    <footer class="p-foot">
      <img src="assets/brand/logo-sm.webp" alt="" />
      <span>${esc(STORE.legalName)}</span>
      <span class="dot">•</span>
      <span>Carta de colores &middot; ${esc(p.brand)} ${esc(p.line)}</span>
      <span class="p-num">${String(p.order).padStart(2, "0")} · Tonos</span>
    </footer>
  </section>`;
}

function closingPage() {
  const msg = `Hola ${STORE.brand}. Busco accesorios e insumos para uñas. ¿Qué opciones tienen disponibles?`;
  const pagos = PAYMENTS.map(
    (n) => `<div class="pay"><img src="assets/pagos/${n}.webp" alt="${n}" /></div>`
  ).join("");
  return `
  <section class="page closing">
    <div class="cover-glow glow-1"></div>
    <div class="closing-inner">
      <img class="closing-logo" src="assets/brand/logo.webp" alt="${esc(STORE.brand)}" />
      <h2 class="closing-title">Completa tu selección</h2>
      <p class="closing-lead">Accesorios, insumos y novedades para uñas, seleccionados para profesionales y emprendedoras. Consulta variedad, precios y tonos disponibles.</p>
      <a class="btn-wa big" href="${wa(msg)}">${waIcon}<span>Descubrir más productos</span></a>
      <p class="closing-phone">${esc(STORE.whatsapp)} · ${esc(STORE.city)}</p>

      <div class="pay-block">
        <span class="pay-title">Medios de pago</span>
        <div class="pay-row">${pagos}</div>
      </div>

      <p class="closing-note">${esc(STORE.notice)}</p>
    </div>
  </section>`;
}

async function build() {
  const productPages = [];
  for (const p of PRODUCTS) {
    const { fotos, carta } = await fotosDe(p.folder);
    productPages.push(productPage(p, fotos, carta));
    if (p.chart === "available" && carta) productPages.push(cartaPage(p));
  }

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(STORE.legalName)} · ${esc(STORE.tagline)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500&family=Jost:wght@300;400;500;600&family=Poppins:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
${css()}
</style>
</head>
<body>
<main class="catalog">
${coverPage()}
${introPage()}
${productPages.join("\n")}
${closingPage()}
</main>
</body>
</html>`;

  await writeFile(path.join(PREVIEW, "catalogo.html"), html, "utf8");
  const cartas = productPages.length - PRODUCTS.length;
  console.log(
    `✅ catalogo.html generado (${PRODUCTS.length} productos, ${cartas} cartas, ${productPages.length + 3} páginas).`
  );
}

function css() {
  return String.raw` 
:root{
  --porcelain:#fff9fc; --pearl:#fdf3f8; --blush:#faedf4; --blush2:#f4dce8;
  --pink:#e84c9a; --pink-strong:#d53183; --berry:#a80d5c; --berry-deep:#8a0b4b;
  --plum:#4b1535; --plum-ink:#3a0f28; --plum-soft:#8a6076;
  --gold:#b89a61; --gold-light:#e4cf9c; --gold-soft:#f0e4c8;
  --wa:#25d366; --wa-dark:#12a150;
  --serif:'Playfair Display',Georgia,serif;
  --sans:'Jost','Poppins',system-ui,-apple-system,Segoe UI,sans-serif;
  --shadow-soft:0 18px 50px -18px rgba(120,15,70,.45);
  --shadow-card:0 12px 34px -16px rgba(120,15,70,.35);
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#efe3ea}
body{font-family:var(--sans);color:var(--plum-ink);-webkit-font-smoothing:antialiased}
img{display:block;max-width:100%}
.catalog{display:flex;flex-direction:column;align-items:center;gap:22px;padding:26px 12px}

/* ---------- PÁGINA A4 ---------- */
.page{
  position:relative;width:210mm;min-height:297mm;background:var(--porcelain);
  overflow:hidden;box-shadow:0 30px 80px -30px rgba(74,21,53,.55);
  border-radius:6px;
}
@media print{
  @page{size:A4;margin:0}
  html,body{background:#fff}
  .catalog{gap:0;padding:0}
  .page{width:210mm;height:297mm;min-height:0;box-shadow:none;border-radius:0;break-after:page;page-break-after:always}
}

/* ---------- PORTADA ---------- */
.cover{
  background:
    radial-gradient(120% 80% at 50% -10%, #ffffff 0%, var(--pearl) 40%, var(--blush) 100%);
  display:flex;align-items:center;justify-content:center;
}
.cover-frame{position:absolute;inset:12mm;border:1.5px solid rgba(184,154,97,.55);border-radius:10px;pointer-events:none}
.cover-frame::after{content:"";position:absolute;inset:5px;border:1px solid rgba(184,154,97,.28);border-radius:7px}
.cover-glow{position:absolute;border-radius:50%;filter:blur(70px);opacity:.55;pointer-events:none}
.glow-1{width:420px;height:420px;background:radial-gradient(circle,rgba(232,76,154,.55),transparent 70%);top:-90px;right:-70px}
.glow-2{width:360px;height:360px;background:radial-gradient(circle,rgba(216,169,79,.45),transparent 70%);bottom:-80px;left:-60px}
.cover-inner{position:relative;z-index:2;text-align:center;padding:0 24mm;display:flex;flex-direction:column;align-items:center}
.cover-legal{font-family:var(--sans);letter-spacing:.42em;text-transform:uppercase;font-size:12px;font-weight:500;color:var(--berry);margin-bottom:10px}
.cover-logo{filter:drop-shadow(0 20px 40px rgba(168,13,92,.35))}
.cover-logo img{width:330px;margin:0 auto}
.cover-titles{margin-top:6px}
.cover-title{font-family:var(--serif);font-weight:600;font-size:44px;line-height:1.05;color:var(--plum);letter-spacing:.5px}
.cover-subtitle{font-family:var(--sans);font-weight:300;letter-spacing:.28em;text-transform:uppercase;font-size:12.5px;color:var(--plum-soft);margin-top:12px}
.orn{display:flex;align-items:center;justify-content:center;gap:14px;color:var(--gold);font-size:15px;margin:16px 0 6px}
.orn i{width:52px;height:1px;background:linear-gradient(90deg,transparent,var(--gold))}
.orn i:last-child{transform:scaleX(-1)}
.cover-signals{display:flex;gap:14px;margin:30px 0 26px}
.signal{background:rgba(255,255,255,.7);border:1px solid rgba(184,154,97,.35);border-radius:14px;padding:12px 16px;min-width:120px;backdrop-filter:blur(4px)}
.signal-k{display:block;font-size:9.5px;letter-spacing:.22em;text-transform:uppercase;color:var(--berry);font-weight:600}
.signal-v{display:block;font-family:var(--serif);font-size:15px;color:var(--plum);margin-top:4px}
.cover-cta{display:inline-flex;align-items:center;gap:10px;background:linear-gradient(135deg,var(--wa),var(--wa-dark));color:#fff;text-decoration:none;font-weight:500;font-size:15px;padding:14px 26px;border-radius:999px;box-shadow:0 14px 30px -10px rgba(18,161,80,.6)}
.cover-cta svg{width:22px;height:22px}
.cover-updated{margin-top:22px;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--plum-soft)}

/* ---------- INTRO / ESMALTES ---------- */
.intro{position:relative;isolation:isolate;padding:24mm 22mm;display:flex;flex-direction:column;
  background:
    radial-gradient(70% 42% at 92% 45%,rgba(232,76,154,.1),transparent 72%),
    radial-gradient(100% 60% at 100% 0%,var(--blush) 0%,var(--porcelain) 55%);}
.intro>*{position:relative;z-index:1}
.intro::after{
  content:"";position:absolute;z-index:0;right:-13mm;top:116mm;width:128mm;height:104mm;
  border-radius:52mm 0 0 52mm;
  background-image:
    linear-gradient(90deg,rgba(255,249,252,.98) 0%,rgba(255,249,252,.48) 22%,rgba(255,249,252,.1) 58%,rgba(255,249,252,.04) 100%),
    url('assets/products/10-candy-secret-color-gel-15ml/foto-1.jpg');
  background-size:cover;background-position:center;
  box-shadow:inset 0 0 0 1px rgba(184,154,97,.14),0 28px 60px -46px rgba(74,21,53,.48);
  opacity:.76;filter:saturate(.78) contrast(.94);
  pointer-events:none;
}
.intro-top{display:flex;align-items:center;justify-content:space-between}
.intro-mini-logo{width:66px}
.intro-eyebrow{font-size:12px;letter-spacing:.4em;text-transform:uppercase;color:var(--berry);font-weight:600}
.intro-hero{margin-top:20mm}
.intro-title{font-family:var(--serif);font-size:96px;line-height:.9;color:var(--plum);font-weight:600;letter-spacing:-1px}
.intro-title::first-letter{color:var(--berry)}
.intro-lead{max-width:150mm;margin-top:18px;font-size:16px;line-height:1.7;color:var(--plum-soft);font-weight:300}
.intro-brands{display:flex;flex-wrap:wrap;gap:10px;margin-top:26px}
.brand-tag{font-family:var(--serif);font-size:15px;color:var(--berry);border:1px solid rgba(184,154,97,.5);border-radius:999px;padding:7px 16px;background:rgba(255,255,255,.6)}
.intro-stat{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:34px;max-width:142mm}
.intro-stat span{min-height:72px;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:12px 15px;background:rgba(255,255,255,.86);border:1px solid rgba(184,154,97,.3);border-radius:14px;box-shadow:0 12px 26px -22px rgba(74,21,53,.46);backdrop-filter:blur(4px)}
.intro-stat b{font-family:var(--serif);color:var(--berry);font-size:28px;line-height:.95;font-weight:600}
.intro-stat b.stat-word{font-size:19px;letter-spacing:-.02em}
.intro-stat small{margin-top:7px;font-family:var(--sans);font-size:12px;line-height:1;text-transform:uppercase;letter-spacing:.16em;color:var(--plum-soft);font-weight:600}
.intro-stat i{display:none}
.intro-note{margin-top:auto;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding-top:28px}
.note-card{display:flex;gap:12px;align-items:flex-start;background:#fff;border:1px solid rgba(184,154,97,.28);border-radius:16px;padding:16px 18px;box-shadow:var(--shadow-card)}
.note-card svg{width:22px;height:22px;color:var(--berry);flex:none;margin-top:2px}
.note-card strong{display:block;font-weight:600;font-size:14px;color:var(--plum)}
.note-card span{display:block;font-size:12.5px;color:var(--plum-soft);margin-top:3px;line-height:1.5}

/* ---------- FICHA DE PRODUCTO ---------- */
.product{padding:16mm 15mm 12mm;display:flex;flex-direction:column;
  background:linear-gradient(180deg,var(--porcelain),#fff 60%);}
.p-head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid rgba(184,154,97,.35);padding-bottom:14px}
.p-eyebrow{font-size:12px;letter-spacing:.32em;text-transform:uppercase;color:var(--berry);font-weight:600}
.p-name{font-family:var(--serif);font-size:40px;color:var(--plum);font-weight:600;line-height:1;margin-top:6px}
.p-present{font-family:var(--serif);font-size:20px;color:var(--gold);font-style:italic}
.p-stage{flex:1;display:flex;align-items:center;min-height:0}
.p-body{display:grid;grid-template-columns:1fr 1fr;gap:28px;width:100%;align-items:start}

.gallery{display:flex;flex-direction:column;gap:12px}
.gallery-main{position:relative;background:linear-gradient(160deg,#fff,var(--blush));border-radius:22px;border:1px solid rgba(184,154,97,.25);aspect-ratio:4/5;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:var(--shadow-soft)}
.gallery-halo{position:absolute;width:70%;height:70%;background:radial-gradient(circle,rgba(232,76,154,.28),transparent 70%);filter:blur(30px)}
.gallery-main img{position:relative;width:100%;height:100%;object-fit:cover}
.gallery-index{position:absolute;top:12px;left:14px;font-family:var(--serif);font-size:15px;color:#fff;background:linear-gradient(135deg,var(--berry),var(--pink));width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 14px -4px rgba(168,13,92,.6)}
.gallery-thumbs{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:10px}
.thumb{aspect-ratio:1/1;border-radius:13px;overflow:hidden;border:1px solid rgba(184,154,97,.3);background:#fff}
.thumb img{width:100%;height:100%;object-fit:cover}

.p-right{display:flex;flex-direction:column}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--plum);background:#fff;border:1px solid rgba(184,154,97,.4);border-radius:999px;padding:6px 12px}
.chip svg{width:14px;height:14px;color:var(--berry)}
.chip-ok{color:var(--wa-dark);border-color:rgba(18,161,80,.35)}
.chip-ok svg{color:var(--wa-dark)}
.chip-gold{color:#8a6a1f;border-color:rgba(184,154,97,.6);background:linear-gradient(180deg,#fff,var(--gold-soft))}
.chip-gold svg{color:var(--gold)}
.p-desc{margin-top:16px;font-size:14.5px;line-height:1.65;color:var(--plum-soft);font-weight:300}

.price-card{
  margin-top:20px;display:grid;grid-template-columns:.82fr 1.18fr;gap:10px;
  align-items:stretch;padding:8px;background:linear-gradient(145deg,var(--pearl),var(--blush));
  border:1px solid rgba(184,154,97,.28);border-radius:22px;color:var(--plum-ink);
  box-shadow:0 16px 34px -24px rgba(74,21,53,.5),inset 0 1px 0 rgba(255,255,255,.92);
}
.price-col{display:flex;flex-direction:column;justify-content:center;min-height:92px;padding:15px 14px;border-radius:16px}
.price-k{font-family:var(--sans);font-size:10px;line-height:1.2;letter-spacing:.12em;text-transform:uppercase;font-weight:600;white-space:nowrap}
.price-v{font-family:var(--sans);font-size:25px;line-height:1;font-weight:600;letter-spacing:-.045em;margin-top:9px;font-variant-numeric:tabular-nums;white-space:nowrap}
.price-card>.price-col:first-child{background:rgba(255,255,255,.82);border:1px solid rgba(184,154,97,.2);color:var(--plum-soft)}
.price-card>.price-col:first-child .price-k{color:var(--plum-soft)}
.price-card>.price-col:first-child .price-v{color:var(--plum);font-weight:500}
.price-div{display:none}
.price-major{
  position:relative;isolation:isolate;overflow:hidden;padding-right:58px;
  background:linear-gradient(110deg,#98166f 0%,#b51d7b 52%,#d02a8b 100%);
  color:#fff;border:1px solid rgba(228,207,156,.16);
  box-shadow:0 12px 24px -16px rgba(152,22,111,.58),inset 0 1px 0 rgba(255,255,255,.16);
}
.price-major::before{content:"";position:absolute;z-index:-1;inset:auto -36px -78px auto;width:144px;height:144px;border-radius:50%;background:rgba(255,255,255,.055)}
.price-major::after{
  content:"";position:absolute;right:42px;top:27px;width:7px;height:24px;border-radius:3px 3px 4px 4px;
  background:linear-gradient(180deg,rgba(228,207,156,.72) 0 20%,rgba(255,255,255,.72) 20% 100%);
  box-shadow:12px 4px 0 -1px rgba(255,255,255,.55),24px 1px 0 -1px rgba(228,207,156,.72);
  transform:rotate(-3deg);opacity:.78;
}
.price-major .price-k{position:relative;color:#fff;opacity:.82}
.price-major .price-v{position:relative;color:#fff;font-size:28px;font-weight:650;text-shadow:0 1px 10px rgba(58,15,40,.16)}

.chart{margin-top:16px;display:flex;gap:14px;background:#fff;border:1px solid rgba(184,154,97,.3);border-radius:16px;padding:14px;box-shadow:var(--shadow-card)}
.chart-thumb{flex:none;width:74px;height:74px;border-radius:12px;overflow:hidden;border:1px solid rgba(184,154,97,.3)}
.chart-thumb img{width:100%;height:100%;object-fit:cover}
.chart-body{display:flex;flex-direction:column;gap:4px;justify-content:center}
.chart-tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--wa-dark)}
.chart-tag svg{width:15px;height:15px}
.chart-tag.consult{color:var(--berry)}
.chart-body p{font-size:12px;color:var(--plum-soft);line-height:1.45}
.link-wa{font-size:12px;font-weight:600;color:var(--pink-strong);text-decoration:none}
.chart-consult{background:linear-gradient(180deg,#fff,var(--blush))}

.btn-wa{margin-top:20px;display:flex;align-items:center;justify-content:center;gap:10px;background:linear-gradient(135deg,var(--wa),var(--wa-dark));color:#fff;text-decoration:none;font-weight:600;font-size:15.5px;padding:15px;border-radius:14px;box-shadow:0 14px 30px -12px rgba(18,161,80,.7)}
.btn-wa svg{width:22px;height:22px}
.btn-wa.big{padding:17px 34px;font-size:17px;margin-top:8px}

.p-foot{display:flex;align-items:center;gap:9px;margin-top:16px;padding-top:12px;border-top:1px solid rgba(184,154,97,.3);font-size:10.5px;letter-spacing:.08em;color:var(--plum-soft)}
.p-foot img{width:26px}
.p-foot .dot{opacity:.5}
.p-foot .p-num{margin-left:auto;font-family:var(--serif);color:var(--berry);font-size:12px}

.chart-next{font-size:12px;font-weight:600;color:var(--pink-strong)}

/* ---------- PÁGINA DE CARTA DE COLORES ---------- */
.carta{padding:16mm 15mm 12mm;display:flex;flex-direction:column;background:linear-gradient(180deg,var(--pearl),#fff 55%)}
.c-stage{flex:1;display:flex;align-items:center;justify-content:center;padding:18px 0;min-height:0}
.c-figure{position:relative;display:flex;max-width:100%;max-height:100%;border-radius:18px;overflow:hidden;border:1px solid rgba(184,154,97,.45);box-shadow:var(--shadow-soft);background:#fff;padding:10px}
.c-figure::after{content:"";position:absolute;inset:4px;border:1px solid rgba(184,154,97,.25);border-radius:12px;pointer-events:none}
.c-figure img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;border-radius:10px}
.c-actions{display:flex;flex-direction:column;gap:12px;padding-top:6px}
.c-hint{font-size:13px;line-height:1.6;color:var(--plum-soft);text-align:center;max-width:150mm;margin:0 auto}
.c-hint b{color:var(--berry);font-weight:600}
.carta .btn-wa{margin-top:0;max-width:150mm;width:100%;align-self:center}

/* ---------- CIERRE ---------- */
.closing{display:flex;align-items:center;justify-content:center;text-align:center;
  background:radial-gradient(120% 80% at 50% 0%, #fff 0%, var(--pearl) 45%, var(--blush) 100%);}
.closing-inner{position:relative;z-index:2;padding:0 26mm;display:flex;flex-direction:column;align-items:center;max-width:170mm}
.closing-logo{width:150px;filter:drop-shadow(0 16px 30px rgba(168,13,92,.3))}
.closing-title{font-family:var(--serif);font-size:34px;color:var(--plum);font-weight:600;margin-top:18px;line-height:1.15}
.closing-lead{font-size:15px;line-height:1.7;color:var(--plum-soft);font-weight:300;margin-top:14px}
.closing-phone{margin-top:14px;font-size:13px;letter-spacing:.12em;color:var(--berry);font-weight:600}
.pay-block{margin-top:34px;width:100%}
.pay-title{font-size:12px;letter-spacing:.34em;text-transform:uppercase;color:var(--plum-soft)}
.pay-row{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:16px}
.pay{background:#fff;border:1px solid rgba(184,154,97,.3);border-radius:12px;padding:12px 16px;height:58px;display:flex;align-items:center;box-shadow:var(--shadow-card)}
.pay img{max-height:34px;width:auto}
.closing-note{margin-top:32px;font-size:12px;color:var(--plum-soft);line-height:1.6;border-top:1px solid rgba(184,154,97,.3);padding-top:16px}
`;
}

await build();
