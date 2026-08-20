/**
 * El árbol para recorrer la tienda, con el campo de respuesta al lado.
 *
 * La hoja CSV sirve para devolver datos, no para buscar: 1.416 filas planas
 * donde quien la abre no sabe por dónde empezar. Esto ordena lo mismo como está
 * ordenada la tienda —categoría, luego marca— y pone junto a cada producto la
 * casilla donde se escribe lo que falta.
 *
 * Un campo por VARIANTE, no por producto, porque cada tono y cada tamaño llevan
 * su propio código de barras. De los 1.017 pendientes, 895 tienen una sola
 * variante: para esos el campo va en la misma línea y no se nota la diferencia.
 * Los 122 restantes abren una casilla por tono.
 *
 * Al final se copian las respuestas y entran por importar-captura.mjs, que
 * valida el dígito de control antes de escribir nada.
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

const productos = await todas("products", "id, code, name, presentation, is_active, categories(name), brands(name)");
const variantes = await todas("product_variants", "id, product_id, name, sku, sku_interno, sku_origen, barcode, barcode_capturado_en, is_active");
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

// Solo los códigos que una persona reconoce. Los largos —GEN-DEC-ABD9C6-9447E3—
// los inventó el importador a partir del nombre y no están escritos en ningún
// envase ni en ninguna hoja: enseñarlos alarga la fila sin ayudar a encontrar
// nada. Los cortos (OTR117, MAS014) sí salen en los papeles de la tienda.
const esReconocible = (c) => /^[A-Z]{2,5}[-]?\d{1,4}$/i.test(c ?? "");

const arbol = new Map();
let pendientes = 0;
let campos = 0;

for (const p of productos) {
  if (!p.is_active) continue;
  const vs = (varDe.get(p.id) ?? []).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "", "es"));
  const tieneFoto = conFoto.has(p.id);
  // «Comprobado» incluye a quien se miró y no traía código: esa variante ya no
  // se busca más. Contarla como pendiente devolvería a la estantería un trabajo
  // que ya se hizo.
  const resuelta = (v) => v.sku_origen === "OFICIAL_MARCA" || v.barcode || v.barcode_capturado_en;
  const tieneId = vs.some(resuelta);
  if (tieneFoto && tieneId) continue;
  pendientes += 1;
  campos += vs.length;

  const categoria = p.categories?.name ?? "Sin categoría";
  const marca = p.brands?.name ?? "Sin marca";
  if (!arbol.has(categoria)) arbol.set(categoria, new Map());
  if (!arbol.get(categoria).has(marca)) arbol.get(categoria).set(marca, []);

  const presentacion = (p.presentation ?? "").trim();
  arbol.get(categoria).get(marca).push({
    n: p.name,
    p: presentacion,
    f: tieneFoto ? 1 : 0,
    // Una variante que ya tiene código no pide otro: se enseña resuelta.
    v: vs.map((v) => ({
      id: v.id,
      // El nombre de variante de un adorno es «X12», que es la presentación
      // repetida. Solo se enseña si dice algo distinto.
      t: (v.name ?? "").trim() === presentacion ? "" : (v.name ?? "").trim(),
      c: esReconocible(v.sku_interno ?? v.sku) ? (v.sku_interno ?? v.sku) : "",
      ok: resuelta(v) ? 1 : 0
    }))
  });
}

const datos = [...arbol]
  .map(([categoria, marcas]) => ({
    categoria,
    total: [...marcas.values()].reduce((a, b) => a + b.length, 0),
    campos: [...marcas.values()].reduce((a, b) => a + b.reduce((x, y) => x + y.v.filter((z) => !z.ok).length, 0), 0),
    marcas: [...marcas]
      .map(([marca, items]) => ({ marca, items: items.sort((a, b) => a.n.localeCompare(b.n, "es")) }))
      .sort((a, b) => b.items.length - a.items.length || a.marca.localeCompare(b.marca, "es"))
  }))
  .sort((a, b) => b.total - a.total);

const porLlenar = datos.reduce((a, c) => a + c.campos, 0);
const html = plantilla(datos, pendientes, porLlenar);

mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
const salida = path.join(ROOT, "outputs", "arbol-busqueda.html");
writeFileSync(salida, html, "utf8");

// La misma lista como CSV, para quien prefiera Excel a la pantalla.
const filasCsv = [];
for (const cat of datos) {
  for (const m of cat.marcas) {
    for (const it of m.items) {
      for (const v of it.v) {
        if (v.ok) continue;
        filasCsv.push({
          "Categoría": cat.categoria,
          "Marca": m.marca,
          "Producto": it.n,
          "Presentación": it.p,
          "Variante": v.t,
          "Código del sistema": v.c,
          "Falta foto": it.f ? "" : "sí",
          "CÓDIGO DE BARRAS": "",
          // Se arrastra sin que nadie la teclee. Es lo único que localiza las
          // 725 variantes cuyo código del sistema es uno de los largos que no
          // se enseñan por ilegibles.
          "Referencia": v.id
        });
      }
    }
  }
}
const cab = Object.keys(filasCsv[0]);
const csvTexto =
  "﻿" +
  [cab.join(","), ...filasCsv.map((f) => cab.map((c) => {
    const s = String(f[c] ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }).join(","))].join("\n") + "\n";
const salidaCsv = path.join(ROOT, "outputs", "respuestas-por-producto.csv");
writeFileSync(salidaCsv, csvTexto, "utf8");

console.log(`Productos pendientes: ${pendientes}`);
console.log(`Casillas por llenar:  ${porLlenar}`);
console.log(`Categorías:           ${datos.length}\n`);
for (const c of datos.slice(0, 8)) console.log(`   ${String(c.total).padStart(4)} prod  ${String(c.campos).padStart(4)} casillas  ${c.categoria}`);
console.log(`\n→ ${salida}  (${(Buffer.byteLength(html) / 1024).toFixed(0)} KB)`);
console.log(`→ ${salidaCsv}  (${filasCsv.length} filas)`);

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

function plantilla(datos, pendientes, porLlenar) {
  const secciones = datos.map((cat, ci) => {
    const marcas = cat.marcas.map((m) => {
      const items = m.items.map((it) => {
        const unica = it.v.length === 1;
        const chips = it.f ? "" : '<span class="f">falta foto</span>';
        const cabecera = `<div class="linea1"><span class="nom">${esc(it.n)}</span>${it.p ? `<span class="pres">${esc(it.p)}</span>` : ""}${chips}</div>`;

        const campo = (v) =>
          v.ok
            ? `<span class="resuelto">ya identificado</span>`
            : `<span class="entrada">
                 <input class="bc" type="text" inputmode="numeric" autocomplete="off"
                        placeholder="código de barras" data-id="${v.id}"
                        data-cod="${esc(v.c)}" data-prod="${esc(it.n)}" data-var="${esc(v.t)}">
                 <button type="button" class="sc" title="No tiene código de barras">s/c</button>
               </span>`;

        if (unica) {
          const v = it.v[0];
          return `<div class="it">
            <div class="izq">${cabecera}<div class="linea2">${v.c ? `<span class="cod">${esc(v.c)}</span>` : ""}</div></div>
            ${campo(v)}
          </div>`;
        }
        const sub = it.v.map((v) => `<div class="sub">
            <span class="sub-nom">${esc(v.t || "—")}${v.c ? ` <span class="cod">${esc(v.c)}</span>` : ""}</span>
            ${campo(v)}
          </div>`).join("");
        return `<div class="it it-multi">
          <div class="izq">${cabecera}<div class="linea2"><span class="nvar">${it.v.length} variantes</span></div></div>
          <div class="subs">${sub}</div>
        </div>`;
      }).join("");
      return `<div class="marca"><div class="marca-tit">${esc(m.marca)} <span class="marca-n">${m.items.length}</span></div>${items}</div>`;
    }).join("");

    return `<details class="cat"${ci === 0 ? " open" : ""}>
      <summary>
        <span class="cat-nom">${esc(cat.categoria)}</span>
        <span class="cat-prog"><span class="cat-hechos">0</span>/<span>${cat.campos}</span></span>
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
--verde:#2f6b45;--verde-wash:#e6f1ea;
--gris-wash:#eee9ea;
}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){
--ground:#180e14;--surface:#22161e;--surface-2:#2a1d25;
--tinta:#f7eff3;--tinta-2:#dcc8d3;--tinta-3:#ad94a2;
--rosa:#ef79b3;--ciruela:#d7a1c3;--rosa-wash:#3a2030;
--linea:#3b2b35;--linea-2:#57404c;
--ambar:#e0b46c;--ambar-wash:#31240e;
--verde:#86c5a0;--verde-wash:#1c2e23;
--gris-wash:#2c1f27;
}}
:root[data-theme="dark"]{
--ground:#180e14;--surface:#22161e;--surface-2:#2a1d25;
--tinta:#f7eff3;--tinta-2:#dcc8d3;--tinta-3:#ad94a2;
--rosa:#ef79b3;--ciruela:#d7a1c3;--rosa-wash:#3a2030;
--linea:#3b2b35;--linea-2:#57404c;
--ambar:#e0b46c;--ambar-wash:#31240e;
--verde:#86c5a0;--verde-wash:#1c2e23;
--gris-wash:#2c1f27;
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--tinta-2);
font-family:"Segoe UI",system-ui,-apple-system,sans-serif;font-size:15px;line-height:1.5;margin:0;padding:0 0 70px}
.wrap{max-width:900px;margin:0 auto;padding:0 16px}
header{padding:32px 0 14px}
.eyebrow{font-size:10.5px;font-weight:700;letter-spacing:2.2px;text-transform:uppercase;color:var(--rosa);margin-bottom:9px}
h1{font-size:30px;line-height:1.12;font-weight:700;letter-spacing:-0.6px;color:var(--tinta);margin:0 0 8px;text-wrap:balance}
.sub{font-size:16px;color:var(--tinta-3);margin:0;max-width:62ch}
.barra{position:sticky;top:0;z-index:10;background:var(--ground);padding:11px 0;border-bottom:1px solid var(--linea);margin-bottom:8px}
.barra-in{display:flex;gap:9px;align-items:center;flex-wrap:wrap}
#q{flex:1 1 220px;min-width:0;font:inherit;font-size:15px;padding:10px 13px;
border:1px solid var(--linea-2);border-radius:8px;background:var(--surface);color:var(--tinta)}
#q:focus{outline:2px solid var(--rosa);outline-offset:1px;border-color:var(--rosa)}
.btn{font:inherit;font-size:13.5px;font-weight:600;padding:9px 13px;border-radius:8px;
border:1px solid var(--linea-2);background:var(--surface);color:var(--tinta-2);cursor:pointer;white-space:nowrap}
.btn:hover{border-color:var(--rosa);color:var(--rosa)}
.btn:focus-visible{outline:2px solid var(--rosa);outline-offset:1px}
.btn-p{background:var(--rosa);border-color:var(--rosa);color:#fff}
.btn-p:hover{opacity:.9;color:#fff}
.marcador{font-size:13.5px;color:var(--tinta-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.marcador b{color:var(--rosa);font-size:16px}
details.cat{background:var(--surface);border:1px solid var(--linea);border-radius:10px;margin-bottom:8px;overflow:hidden}
details.cat summary{cursor:pointer;padding:13px 16px;display:flex;justify-content:space-between;align-items:center;
gap:12px;font-weight:700;color:var(--tinta);list-style:none;background:var(--surface-2)}
details.cat summary::-webkit-details-marker{display:none}
details.cat summary::before{content:"▸";color:var(--rosa);font-size:13px;transition:transform .15s}
details.cat[open] summary::before{transform:rotate(90deg)}
.cat-nom{flex:1}
.cat-prog{font-size:13px;font-weight:700;color:var(--tinta-3);font-variant-numeric:tabular-nums;
background:var(--gris-wash);border-radius:999px;padding:3px 11px}
.cat-cuerpo{padding:2px 16px 14px}
.marca{padding:8px 0 2px}
.marca-tit{font-size:10.5px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:var(--ciruela);
padding:6px 0;border-bottom:1px solid var(--linea);margin-bottom:2px}
.marca-n{color:var(--tinta-3);letter-spacing:0;font-size:11px}
.it{display:flex;gap:14px;justify-content:space-between;align-items:flex-start;
padding:10px 0;border-bottom:1px solid var(--linea);flex-wrap:wrap}
.it:last-child{border-bottom:none}
.it-multi{flex-direction:column;gap:6px}
.izq{flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:2px}
.linea1{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.nom{font-weight:600;color:var(--tinta);font-size:15.5px}
.pres{font-size:13px;color:var(--tinta-3)}
.linea2{display:flex;gap:7px;align-items:center;flex-wrap:wrap;min-height:0}
.cod{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:12px;color:var(--tinta-3);
background:var(--gris-wash);border-radius:5px;padding:1px 7px}
.nvar{font-size:12px;color:var(--tinta-3)}
.f{font-size:10.5px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;
color:var(--ambar);background:var(--ambar-wash);border-radius:999px;padding:2px 8px}
.entrada{display:flex;gap:5px;align-items:center;flex:0 0 auto}
.bc{font:inherit;font-family:Consolas,"SF Mono",Menlo,monospace;font-size:14px;letter-spacing:.4px;
width:190px;padding:7px 10px;border:1px solid var(--linea-2);border-radius:7px;
background:var(--surface);color:var(--tinta);font-variant-numeric:tabular-nums}
.bc::placeholder{font-family:"Segoe UI",system-ui,sans-serif;letter-spacing:0;color:var(--tinta-3);opacity:.75}
.bc:focus{outline:2px solid var(--rosa);outline-offset:1px;border-color:var(--rosa)}
.bc.lleno{border-color:var(--verde);background:var(--verde-wash);color:var(--tinta)}
.bc.dudoso{border-color:var(--ambar);background:var(--ambar-wash)}
.sc{font:inherit;font-size:11.5px;font-weight:700;padding:7px 8px;border-radius:7px;
border:1px solid var(--linea-2);background:var(--surface);color:var(--tinta-3);cursor:pointer}
.sc:hover{border-color:var(--rosa);color:var(--rosa)}
.sc:focus-visible{outline:2px solid var(--rosa);outline-offset:1px}
.resuelto{font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
color:var(--verde);background:var(--verde-wash);border-radius:999px;padding:4px 11px;white-space:nowrap}
.subs{display:flex;flex-direction:column;gap:5px;padding:2px 0 2px 14px;border-left:2px solid var(--linea);margin-left:2px}
.sub{display:flex;gap:12px;justify-content:space-between;align-items:center;flex-wrap:wrap}
.sub-nom{font-size:14px;color:var(--tinta-2)}
.vacio{padding:30px 16px;text-align:center;color:var(--tinta-3)}
.oculto{display:none !important}
.pie{margin-top:20px;font-size:13.5px;color:var(--tinta-3);text-align:center}
dialog{border:1px solid var(--linea-2);border-radius:12px;background:var(--surface);color:var(--tinta-2);
max-width:640px;width:92vw;padding:22px}
dialog::backdrop{background:rgba(20,10,16,.55)}
dialog h2{margin:0 0 6px;font-size:19px;color:var(--tinta)}
dialog p{margin:0 0 12px;font-size:14.5px;color:var(--tinta-3)}
#salida{width:100%;height:220px;font-family:Consolas,"SF Mono",Menlo,monospace;font-size:12.5px;
border:1px solid var(--linea-2);border-radius:8px;padding:10px;background:var(--surface-2);color:var(--tinta-2);resize:vertical}
.dlg-acc{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
@media(max-width:600px){
h1{font-size:24px}body{font-size:14.5px}
.cat-cuerpo{padding:2px 12px 12px}
.it{gap:8px}.izq{flex:1 1 100%}
.bc{width:100%;flex:1}
.entrada{width:100%}
}
@media print{
body{background:#fff;color:#000}
.barra,.pie{display:none}
details.cat{break-inside:avoid;border-color:#999}
.bc{border:1px solid #666;background:#fff}
}
@media(prefers-reduced-motion:reduce){*{transition:none !important}}
</style>

<div class="wrap">
<header>
  <div class="eyebrow">Bellaroshé · Inventario</div>
  <h1>Qué falta encontrar</h1>
  <p class="sub">${pendientes.toLocaleString("es-PE")} productos ordenados como está ordenada la tienda.
     Escriba el código de barras de cada uno en la casilla de la derecha. Si no tiene, pulse <b>s/c</b>.</p>
</header>

<div class="barra"><div class="barra-in">
  <input id="q" type="search" placeholder="Buscar producto, marca o código…" autocomplete="off">
  <button class="btn" id="abrir" type="button">Abrir todo</button>
  <button class="btn" id="cerrar" type="button">Cerrar todo</button>
  <button class="btn btn-p" id="exportar" type="button">Copiar respuestas</button>
  <span class="marcador"><b id="hechos">0</b> de ${porLlenar.toLocaleString("es-PE")}</span>
</div></div>

<div id="lista">${secciones}</div>
<div class="vacio oculto" id="vacio">No hay nada con ese texto.</div>

<p class="pie">Lo escrito se guarda en este navegador. Puede cerrar y seguir otro día.</p>
</div>

<dialog id="dlg">
  <h2>Respuestas</h2>
  <p>Copie todo este texto y péguelo en un archivo. Con eso se cargan al catálogo.</p>
  <textarea id="salida" readonly></textarea>
  <div class="dlg-acc">
    <button class="btn" id="cerrar-dlg" type="button">Cerrar</button>
    <button class="btn btn-p" id="copiar" type="button">Copiar al portapapeles</button>
  </div>
</dialog>

<script>
(function(){
  var lista=document.getElementById('lista'),q=document.getElementById('q'),vacio=document.getElementById('vacio');
  var hechos=document.getElementById('hechos'),dlg=document.getElementById('dlg'),salida=document.getElementById('salida');
  var campos=[].slice.call(lista.querySelectorAll('.bc'));
  var cats=[].slice.call(lista.querySelectorAll('details.cat'));
  var filas=[].slice.call(lista.querySelectorAll('.it'));
  var CLAVE='bellaroshe-respuestas-v1';

  filas.forEach(function(f){ f.dataset.txt=f.textContent.toLowerCase(); });

  var guardado={};
  try{ guardado=JSON.parse(localStorage.getItem(CLAVE)||'{}'); }catch(e){}
  campos.forEach(function(c){ if(guardado[c.dataset.id]) c.value=guardado[c.dataset.id]; });

  // Un código de barras tiene 8, 12 o 13 dígitos. Si no, se avisa en ámbar sin
  // bloquear: quizá está a medio escribir, y frenar a quien va por el producto
  // trescientos es peor que dejarle terminar.
  function pinta(c){
    var v=(c.value||'').trim();
    c.classList.remove('lleno','dudoso');
    if(!v) return;
    if(v.toUpperCase()==='SIN CODIGO'){ c.classList.add('lleno'); return; }
    var d=v.replace(/\\D/g,'');
    c.classList.add((d.length===8||d.length===12||d.length===13)?'lleno':'dudoso');
  }

  function contar(){
    var n=0;
    campos.forEach(function(c){ if((c.value||'').trim()) n++; });
    hechos.textContent=n.toLocaleString('es-PE');
    cats.forEach(function(cat){
      var m=0;
      [].slice.call(cat.querySelectorAll('.bc')).forEach(function(c){ if((c.value||'').trim()) m++; });
      var e=cat.querySelector('.cat-hechos'); if(e) e.textContent=m;
    });
  }

  function guarda(c){
    var v=(c.value||'').trim();
    if(v) guardado[c.dataset.id]=v; else delete guardado[c.dataset.id];
    try{ localStorage.setItem(CLAVE,JSON.stringify(guardado)); }catch(e){}
    pinta(c); contar();
  }

  lista.addEventListener('input',function(ev){ if(ev.target.classList.contains('bc')) guarda(ev.target); });
  lista.addEventListener('click',function(ev){
    if(!ev.target.classList.contains('sc')) return;
    var c=ev.target.previousElementSibling;
    c.value = c.value.trim().toUpperCase()==='SIN CODIGO' ? '' : 'SIN CODIGO';
    guarda(c);
  });

  // Enter salta al siguiente campo: con mil casillas, el ratón sobra.
  lista.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter'||!ev.target.classList.contains('bc')) return;
    ev.preventDefault();
    var vis=campos.filter(function(c){ return c.offsetParent!==null; });
    var i=vis.indexOf(ev.target);
    if(i>=0&&i+1<vis.length) vis[i+1].focus();
  });

  var t;
  q.addEventListener('input',function(){
    clearTimeout(t);
    t=setTimeout(function(){
      var s=q.value.trim().toLowerCase(),vis=0;
      filas.forEach(function(f){
        var ok=!s||f.dataset.txt.indexOf(s)>=0;
        f.classList.toggle('oculto',!ok); if(ok) vis++;
      });
      [].slice.call(lista.querySelectorAll('.marca')).forEach(function(m){
        m.classList.toggle('oculto',![].slice.call(m.querySelectorAll('.it')).some(function(i){return !i.classList.contains('oculto')}));
      });
      cats.forEach(function(c){
        var hay=[].slice.call(c.querySelectorAll('.it')).some(function(i){return !i.classList.contains('oculto')});
        c.classList.toggle('oculto',!hay);
        if(s&&hay) c.open=true;
      });
      vacio.classList.toggle('oculto',vis>0);
    },140);
  });

  document.getElementById('abrir').onclick=function(){ cats.forEach(function(c){c.open=true}); };
  document.getElementById('cerrar').onclick=function(){ cats.forEach(function(c){c.open=false}); };

  function comilla(s){ s=String(s==null?'':s); return /[",\\r\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }

  // La «Referencia» viaja aunque nadie la mire: 725 de las 1.255 casillas son de
  // productos cuyo código del sistema es uno de los largos generados, que no se
  // enseña por ilegible. Sin esta columna, el 58% de lo que se escriba no se
  // podría devolver a su sitio.
  document.getElementById('exportar').onclick=function(){
    var l=['Código del sistema,Producto,Variante,CÓDIGO DE BARRAS,Referencia'];
    campos.forEach(function(c){
      var v=(c.value||'').trim();
      if(!v) return;
      l.push([c.dataset.cod,c.dataset.prod,c.dataset.var,v,c.dataset.id].map(comilla).join(','));
    });
    if(l.length===1){ alert('Todavía no hay ninguna respuesta escrita.'); return; }
    salida.value=l.join('\\n');
    dlg.showModal(); salida.select();
  };
  document.getElementById('cerrar-dlg').onclick=function(){ dlg.close(); };
  document.getElementById('copiar').onclick=function(){
    salida.select();
    var ok=false;
    try{ ok=document.execCommand('copy'); }catch(e){}
    if(navigator.clipboard&&!ok) navigator.clipboard.writeText(salida.value).catch(function(){});
    document.getElementById('copiar').textContent='Copiado';
    setTimeout(function(){ document.getElementById('copiar').textContent='Copiar al portapapeles'; },1600);
  };

  campos.forEach(pinta);
  contar();
})();
</script>`;
}
