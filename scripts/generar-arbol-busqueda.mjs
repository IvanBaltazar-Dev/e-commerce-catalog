/**
 * El árbol para recorrer la tienda de una vez.
 *
 * La hoja CSV sirve para devolver datos, no para buscar: son 1.416 filas planas
 * y quien la abre no sabe por dónde empezar. Esto ordena lo mismo como está
 * ordenada la tienda —por categoría, luego por marca— y dice de cada producto
 * qué le falta y con qué código encontrarlo en las hojas viejas.
 *
 * Sale una página sola, sin servidor: se abre, se busca, se marca lo encontrado
 * y se imprime si hace falta.
 *
 * Uso: node scripts/generar-arbol-busqueda.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = Object.fromEntries(
  readFileSync(path.join(ROOT, ".env.supabase.local"), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()])
);
const db = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function todas(tabla, select, orden = "id") {
  const filas = [];
  for (let desde = 0; ; desde += 1000) {
    const { data, error } = await db.from(tabla).select(select).order(orden).range(desde, desde + 999);
    if (error) throw error;
    filas.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return filas;
}

const productos = await todas(
  "products",
  "id, code, name, presentation, is_active, categories(name), brands(name)"
);
const variantes = await todas("product_variants", "id, product_id, name, sku, sku_interno, sku_origen, barcode, is_active");
const medios = await todas("product_media", "product_id, variant_id");

const varDe = new Map();
for (const v of variantes) {
  if (!v.is_active) continue;
  if (!varDe.has(v.product_id)) varDe.set(v.product_id, []);
  varDe.get(v.product_id).push(v);
}
const productoDeVariante = new Map(variantes.map((v) => [v.id, v.product_id]));
const conFoto = new Set();
for (const m of medios) {
  const pid = m.product_id ?? productoDeVariante.get(m.variant_id);
  if (pid) conFoto.add(pid);
}

const arbol = new Map();
let pendientes = 0;

for (const p of productos) {
  if (!p.is_active) continue;
  const vs = varDe.get(p.id) ?? [];
  const tieneFoto = conFoto.has(p.id);
  const tieneId = vs.some((v) => v.sku_origen === "OFICIAL_MARCA" || v.barcode);
  if (tieneFoto && tieneId) continue;
  pendientes += 1;

  const categoria = p.categories?.name ?? "Sin categoría";
  const marca = p.brands?.name ?? "Sin marca";
  if (!arbol.has(categoria)) arbol.set(categoria, new Map());
  const porMarca = arbol.get(categoria);
  if (!porMarca.has(marca)) porMarca.set(marca, []);

  // Solo los códigos que una persona reconoce. Los largos —GEN-DEC-ABD9C6-9447E3—
  // los inventó el importador a partir del nombre y no están escritos en ningún
  // sitio: enseñarlos es ruido que hace la fila más difícil de leer, no más
  // fácil de encontrar. Los cortos (OTR117, MAS014) sí salen en sus hojas.
  const codigos = [...new Set(vs.map((v) => v.sku_interno ?? v.sku).filter(Boolean))]
    .filter((c) => /^[A-Z]{2,5}[-]?\d{1,4}$/i.test(c));

  // Los «tonos» de un adorno son «X12 · X12», que es la presentación repetida.
  // Solo se enseñan si dicen algo distinto del nombre y de la presentación.
  const presentacion = (p.presentation ?? "").trim();
  const tonos = [...new Set(vs.map((v) => (v.name ?? "").trim()).filter(Boolean))]
    .filter((t) => t !== presentacion && t.toLowerCase() !== p.name.toLowerCase());

  porMarca.get(marca).push({
    n: p.name,
    p: p.presentation ?? "",
    c: codigos.slice(0, 6),
    mas: Math.max(0, codigos.length - 6),
    t: tonos.length > 8 ? [] : tonos,
    nt: tonos.length,
    f: tieneFoto ? 1 : 0,
    i: tieneId ? 1 : 0
  });
}

const datos = [...arbol]
  .map(([categoria, marcas]) => ({
    categoria,
    total: [...marcas.values()].reduce((a, b) => a + b.length, 0),
    marcas: [...marcas]
      .map(([marca, items]) => ({ marca, items: items.sort((a, b) => a.n.localeCompare(b.n, "es")) }))
      .sort((a, b) => b.items.length - a.items.length || a.marca.localeCompare(b.marca, "es"))
  }))
  .sort((a, b) => b.total - a.total);

const html = plantilla(datos, pendientes);
mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const salida = path.join(ROOT, "outputs", "arbol-busqueda.html");
writeFileSync(salida, html, "utf8");

console.log(`Pendientes: ${pendientes}`);
console.log(`Categorías: ${datos.length}`);
console.log(`\nLas diez primeras:`);
for (const c of datos.slice(0, 10)) console.log(`   ${String(c.total).padStart(4)}  ${c.categoria}`);
console.log(`\n→ ${salida}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function plantilla(datos, pendientes) {
  const secciones = datos.map((cat, ci) => {
    const marcas = cat.marcas.map((m) => {
      const items = m.items.map((it) => {
        const falta = [];
        if (!it.f) falta.push('<span class="f f-foto">falta foto</span>');
        if (!it.i) falta.push('<span class="f f-id">falta código</span>');
        const codigos = it.c.length
          ? `<span class="cod">${it.c.map(esc).join(" · ")}${it.mas ? ` <em>+${it.mas}</em>` : ""}</span>`
          : "";
        const tonos = it.t.length
          ? `<span class="tonos">${it.t.map(esc).join(" · ")}</span>`
          : it.nt > 8
            ? `<span class="tonos"><em>${it.nt} variantes</em></span>`
            : "";
        return `<label class="it">
          <input type="checkbox" class="mk">
          <span class="cuerpo">
            <span class="linea1"><span class="nom">${esc(it.n)}</span>${it.p ? `<span class="pres">${esc(it.p)}</span>` : ""}</span>
            <span class="linea2">${codigos}${falta.join("")}</span>
            ${tonos}
          </span>
        </label>`;
      }).join("");
      return `<div class="marca"><div class="marca-tit">${esc(m.marca)} <span class="marca-n">${m.items.length}</span></div>${items}</div>`;
    }).join("");

    return `<details class="cat"${ci === 0 ? " open" : ""}>
      <summary>
        <span class="cat-nom">${esc(cat.categoria)}</span>
        <span class="cat-prog"><span class="cat-hechos">0</span>/<span class="cat-total">${cat.total}</span></span>
      </summary>
      <div class="cat-cuerpo">${marcas}</div>
    </details>`;
  }).join("");

  return `<title>Qué falta encontrar</title>
<style>
:root{
--ground:#f2eeea;--surface:#fff;--surface-2:#faf7f5;
--tinta:#22141f;--tinta-2:#4b3944;--tinta-3:#77626e;
--rosa:#c9327f;--ciruela:#75325f;--rosa-wash:#fbe7f1;
--linea:#e2d9da;--linea-2:#cdbec4;
--ambar:#9c6a24;--ambar-wash:#f8efdd;
--gris-wash:#eee9ea;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
--ground:#180e14;--surface:#22161e;--surface-2:#2a1d25;
--tinta:#f7eff3;--tinta-2:#dcc8d3;--tinta-3:#ad94a2;
--rosa:#ef79b3;--ciruela:#d7a1c3;--rosa-wash:#3a2030;
--linea:#3b2b35;--linea-2:#533d49;
--ambar:#e0b46c;--ambar-wash:#31240e;
--gris-wash:#2c1f27;
}}
:root[data-theme="dark"]{
--ground:#180e14;--surface:#22161e;--surface-2:#2a1d25;
--tinta:#f7eff3;--tinta-2:#dcc8d3;--tinta-3:#ad94a2;
--rosa:#ef79b3;--ciruela:#d7a1c3;--rosa-wash:#3a2030;
--linea:#3b2b35;--linea-2:#533d49;
--ambar:#e0b46c;--ambar-wash:#31240e;
--gris-wash:#2c1f27;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--tinta-2);
font-family:"Segoe UI",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;margin:0;padding:0 0 60px}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
header{padding:34px 0 16px}
.eyebrow{font-size:10.5px;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;color:var(--rosa);margin-bottom:10px}
h1{font-size:31px;line-height:1.12;font-weight:700;letter-spacing:-0.6px;color:var(--tinta);margin:0 0 8px;text-wrap:balance}
.sub{font-size:16px;color:var(--tinta-3);margin:0}
.barra{position:sticky;top:0;z-index:10;background:var(--ground);
padding:12px 0 12px;border-bottom:1px solid var(--linea);margin-bottom:6px}
.barra-in{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#q{flex:1 1 240px;min-width:0;font:inherit;font-size:15px;padding:10px 13px;
border:1px solid var(--linea-2);border-radius:8px;background:var(--surface);color:var(--tinta)}
#q:focus{outline:2px solid var(--rosa);outline-offset:1px;border-color:var(--rosa)}
.btn{font:inherit;font-size:13.5px;font-weight:600;padding:9px 13px;border-radius:8px;
border:1px solid var(--linea-2);background:var(--surface);color:var(--tinta-2);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--rosa);color:var(--rosa)}
.btn:focus-visible{outline:2px solid var(--rosa);outline-offset:1px}
.marcador{font-size:13.5px;color:var(--tinta-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.marcador b{color:var(--rosa);font-size:16px}
details.cat{background:var(--surface);border:1px solid var(--linea);border-radius:10px;margin-bottom:8px;overflow:hidden}
details.cat summary{cursor:pointer;padding:14px 16px;display:flex;justify-content:space-between;
align-items:center;gap:12px;font-weight:700;color:var(--tinta);list-style:none;background:var(--surface-2)}
details.cat summary::-webkit-details-marker{display:none}
details.cat summary::before{content:"▸";color:var(--rosa);font-size:13px;margin-right:2px;transition:transform .15s}
details.cat[open] summary::before{transform:rotate(90deg)}
.cat-nom{flex:1}
.cat-prog{font-size:13px;font-weight:700;color:var(--tinta-3);font-variant-numeric:tabular-nums;
background:var(--gris-wash);border-radius:999px;padding:3px 11px}
.cat-cuerpo{padding:4px 16px 14px}
.marca{padding:10px 0 2px}
.marca-tit{font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;
color:var(--ciruela);padding:6px 0 6px;border-bottom:1px solid var(--linea);margin-bottom:4px}
.marca-n{color:var(--tinta-3);letter-spacing:0;font-size:11px}
.it{display:grid;grid-template-columns:22px 1fr;gap:10px;padding:9px 0;
border-bottom:1px solid var(--linea);cursor:pointer;align-items:start}
.it:last-child{border-bottom:none}
.it input{width:17px;height:17px;margin:2px 0 0;accent-color:var(--rosa);cursor:pointer}
.it:has(.mk:checked) .cuerpo{opacity:.42;text-decoration:line-through;text-decoration-thickness:1px}
.cuerpo{display:flex;flex-direction:column;gap:3px;min-width:0}
.linea1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.nom{font-weight:600;color:var(--tinta);font-size:15.5px}
.pres{font-size:13px;color:var(--tinta-3)}
.linea2{display:flex;gap:7px;align-items:center;flex-wrap:wrap}
.cod{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:12px;color:var(--tinta-3);
background:var(--gris-wash);border-radius:5px;padding:1px 7px}
.cod em{font-style:normal;opacity:.7}
.f{font-size:10.5px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;border-radius:999px;padding:2px 8px}
.f-foto{color:var(--ambar);background:var(--ambar-wash)}
.f-id{color:var(--rosa);background:var(--rosa-wash)}
.tonos{display:block;font-size:12.5px;color:var(--tinta-3);line-height:1.45}
.tonos em{font-style:italic}
.vacio{padding:30px 16px;text-align:center;color:var(--tinta-3)}
.oculto{display:none !important}
.pie{margin-top:22px;font-size:13.5px;color:var(--tinta-3);text-align:center}
@media(max-width:560px){
h1{font-size:25px}body{font-size:14.5px}
.cat-cuerpo{padding:4px 12px 12px}
.it{grid-template-columns:20px 1fr;gap:8px}
}
@media print{
body{background:#fff;color:#000}
.barra,.pie{display:none}
details.cat{break-inside:avoid;border-color:#999}
details.cat .cat-cuerpo{display:block !important}
}
@media(prefers-reduced-motion:reduce){*{transition:none !important}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Bellaroshé · Inventario</div>
  <h1>Qué falta encontrar</h1>
  <p class="sub">${pendientes.toLocaleString("es-PE")} productos ordenados como está ordenada la tienda. Marque cada uno al encontrarlo.</p>
</header>

<div class="barra"><div class="barra-in">
  <input id="q" type="search" placeholder="Buscar producto, marca o código…" autocomplete="off">
  <button class="btn" id="abrir" type="button">Abrir todo</button>
  <button class="btn" id="cerrar" type="button">Cerrar todo</button>
  <span class="marcador"><b id="hechos">0</b> de ${pendientes.toLocaleString("es-PE")}</span>
</div></div>

<div id="lista">${secciones}</div>
<div class="vacio oculto" id="vacio">No hay nada con ese texto.</div>

<p class="pie">Lo marcado se guarda en este navegador. Si cierra y vuelve, sigue donde lo dejó.</p>
</div>

<script>
(function(){
  var lista=document.getElementById('lista');
  var q=document.getElementById('q');
  var vacio=document.getElementById('vacio');
  var hechos=document.getElementById('hechos');
  var items=[].slice.call(lista.querySelectorAll('.it'));
  var cats=[].slice.call(lista.querySelectorAll('details.cat'));
  var CLAVE='bellaroshe-arbol-v1';

  items.forEach(function(it,i){ it.dataset.i=i; it.dataset.txt=it.textContent.toLowerCase(); });

  var guardado={};
  try{ guardado=JSON.parse(localStorage.getItem(CLAVE)||'{}'); }catch(e){}
  items.forEach(function(it,i){ if(guardado[i]) it.querySelector('.mk').checked=true; });

  function contar(){
    var n=0;
    items.forEach(function(it){ if(it.querySelector('.mk').checked) n++; });
    hechos.textContent=n.toLocaleString('es-PE');
    cats.forEach(function(c){
      var m=0;
      [].slice.call(c.querySelectorAll('.mk')).forEach(function(k){ if(k.checked) m++; });
      var e=c.querySelector('.cat-hechos'); if(e) e.textContent=m;
    });
  }

  lista.addEventListener('change',function(ev){
    if(!ev.target.classList.contains('mk')) return;
    var it=ev.target.closest('.it');
    if(ev.target.checked) guardado[it.dataset.i]=1; else delete guardado[it.dataset.i];
    try{ localStorage.setItem(CLAVE,JSON.stringify(guardado)); }catch(e){}
    contar();
  });

  var t;
  q.addEventListener('input',function(){
    clearTimeout(t);
    t=setTimeout(function(){
      var s=q.value.trim().toLowerCase();
      var visibles=0;
      items.forEach(function(it){
        var ok=!s||it.dataset.txt.indexOf(s)>=0;
        it.classList.toggle('oculto',!ok);
        if(ok) visibles++;
      });
      [].slice.call(lista.querySelectorAll('.marca')).forEach(function(m){
        var hay=[].slice.call(m.querySelectorAll('.it')).some(function(i){return !i.classList.contains('oculto')});
        m.classList.toggle('oculto',!hay);
      });
      cats.forEach(function(c){
        var hay=[].slice.call(c.querySelectorAll('.it')).some(function(i){return !i.classList.contains('oculto')});
        c.classList.toggle('oculto',!hay);
        if(s&&hay) c.open=true;
      });
      vacio.classList.toggle('oculto',visibles>0);
    },140);
  });

  document.getElementById('abrir').addEventListener('click',function(){ cats.forEach(function(c){c.open=true}); });
  document.getElementById('cerrar').addEventListener('click',function(){ cats.forEach(function(c){c.open=false}); });

  contar();
})();
</script>`;
}
