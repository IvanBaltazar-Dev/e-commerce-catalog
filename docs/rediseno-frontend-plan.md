# Plan de rediseño de frontend — Bellaroshé

Rama: `feature/bellaroshe-platform-v2`. Sin rama de rediseño.

Dirección: **sistema operativo de retail de belleza**, no software empresarial rosado.
Operación clarísima por dentro, vitrina visual hacia el cliente. Una sola tipografía.
El rosa vuelve a ser acento, no relleno.

---

## 0. Qué encontré en el repo (medido, no supuesto)

| Hecho | Medida | Consecuencia |
|---|---|---|
| `src/app/globals.css` | 5.702 líneas · **805 selectores de clase** | Diseño centralizado: la ventaja del plan es real |
| Capa de tokens | **22 variables**, todas `--br-*`, todas de color | Mucho más delgada de lo que el plan asume |
| Color fuera de tokens | **168 hex distintos en 334 usos** + 68 `rgba()` | ~48 % de las decisiones de color **no** pasan por `:root` |
| Tipografía actual | Poppins + Jost por `@import` de Google Fonts (línea 1) | 35 declaraciones `font-family`: 31 Poppins, 3 Jost, 1 mono |
| Escala tipográfica | **27 tamaños distintos**, con medios píxeles (9,5 / 11,5 / 13,5 / 15,5) | No hay escala; hay acumulación |
| Radios | **17 valores distintos**; 51 usos de `999px` | Todo es píldora |
| Profundidad | 40 `box-shadow` · 13 gradientes | La profundidad viene de sombras, no de superficie+borde |
| Variables fantasma | `--muted`, `--line`, `--surface`, `--surface-2`, `--bg` **se usan y nunca se declaran** (bloque `.ops-*`, líneas 5261–5310) | Intento de tokens anterior, a medio hacer |
| Color quemado en TSX | 42 bloques `style={{}}` · 28 hex en `.tsx` | Fuera del alcance de los tokens; hay que tratarlos aparte |
| Navegación | `Topbar.tsx:18-31`: **12 entradas planas** + 1 condicional | Confirma el diagnóstico de las 13 entradas |
| Pruebas | Puppeteer por **selector de DOM y estructura** | Ver §2.3 |
| Entrada por rol | `LoginForm.tsx:75` ya manda vendedora → `/admin/ventas` | **A2 no hay que evitarlo: ya está resuelto** |
| Entrada de la dueña | `/admin` → redirige a `/admin/productos/nuevo` | La dueña aterriza en un formulario de alta. Ese es el hueco real de A1 |

### Los cuatro archivos de estrés existen y pesan

| Control | Archivo | Líneas |
|---|---|---|
| B1 Nueva venta | `src/components/admin/SalesView.tsx` | 861 |
| F2 Ficha de producto | `src/components/admin/CatalogV2ProductForm.tsx` | 1.168 |
| H1 Analítica | `src/components/admin/AnalyticsView.tsx` | 432 |
| P1 Catálogo público | `HomeView` + `PublicShell` + `ProductView` | 633 (195 selectores `pub-*`) |

---

## 1. Decisiones tomadas (del brief, confirmadas)

1. **Manrope, única familia del sistema.** Panel, POS, catálogo público, ficha, login, nota de venta.
   Sin serif. Ni siquiera en P1. Una campaña editorial futura sería la excepción, no el idioma.
2. **Manrope variable WOFF2 autoalojada.** Fuera el `@import` de Google Fonts.
   Pesos efectivos: 400 texto · 500 controles y datos · 600 botones, etiquetas y títulos de tarjeta · 700 solo KPI/título que lo pida.
3. **Se conservan todos los selectores.** `.pub-addbtn` sigue llamándose `.pub-addbtn`. Cambia lo que significa, no cómo se llama.
4. **No se mueven rutas.** Se rediseña navegación, no URLs. Caja sigue en `/admin/caja`.
5. **No se construye A2.** La vendedora entra a Nueva venta. Su resumen operativo vive dentro de B1.
6. **La Fundación no se da por buena hasta demostrarse** en B1, F2, H1 y P1 a la vez.

---

## 2. Las tres correcciones que el repo obliga a hacer

### 2.1 Fase 0 no es «cambiar tokens». Es **tokenizar**.

Cambiar los 22 `--br-*` mueve, como mucho, la mitad de la interfaz. La otra mitad son 334 hex y
68 `rgba()` escritos dentro de las reglas. Si solo redefinimos variables, el resultado es el peor
posible: **una interfaz mitad nueva y mitad rosa vieja**, que además parece un error de render.

Entonces Fase 0 tiene dos movimientos, no uno:

- **extraer** — recorrer los 334 hex y sustituirlos por token, sección por sección;
- **redefinir** — dar a los tokens los valores nuevos.

Y en ese orden. Primero la app queda **idéntica** pero 100 % tokenizada (commit verificable a ojo:
no debe cambiar nada). Después se cambia el valor de los tokens y cambia todo de golpe.
Esto convierte un salto ciego en dos pasos, cada uno con su propia forma de fallar y de revertirse.

### 2.2 Una sola familia **borra** la jerarquía actual si no la reconstruimos

Hoy la jerarquía se sostiene en el contraste de familia: Poppins titula, Jost narra. Son 31 sitios
donde «esto es un título» significa literalmente «esto es Poppins». Al pasar todo a Manrope,
esos 31 sitios se vuelven texto normal y las pantallas se aplanan.

No es un reemplazar-y-listo. Hay que **recodificar la jerarquía en peso, tamaño y tracking**
antes de retirar Poppins, en el mismo commit. Es el riesgo estético número uno de la decisión
tipográfica, y es exactamente lo que H1 (tablas y números) y F2 (formularios largos) van a delatar.

### 2.3 «Conservar selectores» no alcanza: hay que **no tocar los `.tsx`**

Las pruebas no leen solo nombres, leen estructura y orden:

```
.order-qty button:last-child        .product-step-actions .btn-save
.chip-row .opt-chip                 .product-entity-search button
.topbar-nav .nav-pill               .sale-totals-final b
```

Un `<div>` de más en `SalesView` rompe `test:sales-ui` aunque ninguna clase haya cambiado.
Por eso la regla de contención de Fase 0 es más dura que «no renombrar»:

> **Fase 0 toca exactamente dos archivos** — `src/app/globals.css` y `src/app/layout.tsx` —
> más los binarios nuevos en `public/fonts/`. Ningún otro `.tsx`. Ninguna lógica. Ninguna ruta.

Eso hace la fase revisable de un vistazo y reversible con un `git revert`.

**Guardia automática:** `scripts/gate-selectors.mjs` extrae el inventario de selectores de
`globals.css` y falla si desaparece alguno respecto a la línea base. Se corre antes de cada commit
de rediseño. Es barato y elimina la clase de regresión más probable de todo el proyecto.

---

## 3. Fase 0 — Fundación

### 3.1 Tipografía (primero, porque cambia el ritmo de todo lo demás)

- Manrope variable WOFF2 en `public/fonts/`, cargada con `next/font/local` desde `layout.tsx`,
  `display: "swap"`, subconjunto latino, expuesta como `--font-sans` en `<html>`.
- `globals.css` deja de nombrar familias: `font-family: var(--font-sans)`.
- Se retira el `@import` de la línea 1. Cero conexiones a terceros para texto.
- Los 31 `font-family: "Poppins"` se sustituyen **en el mismo commit** por su equivalente de
  jerarquía (`--fw-semibold` + paso de escala + tracking), no por otra familia.
- Números tabulares donde hay dinero y cantidades: `font-variant-numeric: tabular-nums`.
  Verificar que el archivo de Manrope que descarguemos exponga `tnum`; si no, la propiedad CSS basta.

### 3.2 Tokens

Vocabulario nuevo, en `:root`. Los `--br-*` existentes **se conservan como alias** apuntando a los
nuevos, para no romper los ~430 usos de una sola vez.

**Los valores los fija [rediseno-prototipos-aprobados.md](rediseno-prototipos-aprobados.md) §1–§3, no
este documento.** Aquel se decidió mirando pantallas con Ivan; este solo decide cómo se ejecuta.
El vocabulario es el de los prototipos, verificado extrayendo el CSS de los artifacts:

```
Superficie   --ground #F3EFEB · --surface #FFFFFF · --surface-2 #F8F4F1 · --hover #FBF6F8
Texto        --ink #241621 · --ink-2 #4A3A43 · --ink-3 #6B5A64
Línea        --line #E8E0E3 · --line-2 #DBD0D5
Acento       --rose #D3348A · --rose-deep #B02470 · --rose-wash #FBE9F2
Por función  --plum · --gold (+deep) · --green (+line) · --teal · --clay, cada uno con su wash
Severidad    --crit #C0392B · --imp #CF7C2A · --low #CFA22B
Pesos        400 cuerpo · 500 títulos de pantalla y etiquetas · 600 UI y KPI · 700 una cifra por pantalla
Radio        --r-sm 6–7px (controles) · --r 10px (tarjetas) · --r-pill 999px (solo píldoras deliberadas)
Elevación    borde de 1px; hover 0 6px 20px rgba(36,22,33,.06); sombra fuerte solo en overlays
```

Tres correcciones que este plan traía mal y quedan derogadas:

| Traía el plan | Manda lo aprobado | Por qué |
|---|---|---|
| Radios 8/12/16/20 | **6–7 y 10** | *«sin exceso de curva… sobrio, refinado, corporativo»* |
| 27 tamaños → 8 pasos «sin medios píxeles» | **Se conservan 11.5 / 12.5 / 13.5** | Son valores del pase de refinamiento, no ruido acumulado |
| Título de pantalla en 600 | **500**, 30–40px, −0.012em | *«Quiero elegancia, no que domine»* |

Y una que sobrevive intacta: **el rosa `#D3348A` es exactamente el `--br-pink` actual**. La paleta no
cambia de tono; cambia de dosis.

Regla añadida por el pase de refinamiento: los secundarios van a **12.5–13px con `--ink-2`/`--ink-3`**,
nunca a 11–12px en gris claro. Y `font-variant-numeric: tabular-nums` en **todo** número.

Reglas duras:

- **Los semánticos no son variantes del rosa.** Verde, ámbar, rojo y azul son datos, no decoración.
- **La profundidad viene de fondo → superficie → borde.** `--e-2` se reserva a modales y menús.
  Nada de tarjetas flotando.
- **Las variables fantasma se declaran de verdad.** Ojo: al declarar `--surface`, `--line`, `--muted`
  y `--bg`, el bloque `.ops-*` deja de usar sus fallbacks y **cambia de aspecto al instante**.
  Es lo que queremos, pero hay que mirarlo (Compras y sus tablas).

### 3.3 Primitivas

Se reestilizan sin renombrar: `.input`, `.textarea`, `.field-label`, `.field-hint`, `.page-title`,
`.page-sub`, `.btn-primary`, `.btn-ghost`, `.btn-soft`, `.btn-success`, `.toast`, `.nav-pill`, `.dot`, `.spinner`.

El cambio de fondo: hoy `body` lleva un degradado rosa radial fijo. **Sustituirlo por porcelana
plana es el gesto que más des-rosa la aplicación entera**, y por eso va temprano y se mide.

Jerarquía de botón: una sola acción primaria fuerte por contexto. En B1, *Cobrar* pesa; *Guardar
carrito*, *Vaciar*, *Reservar* y *Agregar cliente* existen sin competir. Hoy `.btn-primary` es
gradiente rosa con sombra rosa de 22 px: eso es lo que hace que todo grite.

### 3.4 Validación: cuatro controles, no cuatro rediseños

Se corren **a la vez**, sobre build de producción y Supabase local sembrada:

| Control | Qué tiene que demostrar |
|---|---|
| B1 Nueva venta | Velocidad operativa: densidad, foco, una primaria clara |
| F2 Ficha de producto | Que 1.168 líneas de formulario siguen legibles y agrupadas |
| H1 Analítica | Que tablas, cifras y jerarquía sobreviven a una sola familia |
| P1 Catálogo público | Que lo visual/editorial no necesita una segunda tipografía |

Infraestructura: ya existe. `scripts/test-responsive-sweep.mjs` barre 12 superficies × 2 viewports
(1440×900 y 375×812) verificando sin overflow horizontal, sin loaders eternos, sin errores de consola
ni de hidratación; y `scripts/shoot-public.mjs` captura el público. Solo hay que ampliarlos con
capturas de las cuatro y guardar el **antes** primero.

### 3.5 Criterios de aceptación de Fase 0

1. `gate-selectors.mjs` verde: **cero selectores perdidos**.
2. `npm run typecheck` · `npm run lint` · `npm run build` verdes.
3. `npm run test:responsive` verde en las 12 superficies × 2 viewports, **con emulación de
   dispositivo móvil**. Regla permanente de Ivan: *ninguna pantalla se aprueba sin emulación móvil*.
   Fijar solo el ancho no cuenta — mide un escritorio estrecho y deja pasar desbordes reales.
4. `npm run test:sales-ui` y `npm run test:product-registration-ui` verdes.
5. Cero hex crudos en `globals.css` fuera del bloque `:root` (se admiten `#fff` y `rgba()` de sombra).
6. Contraste AA en texto sobre las cuatro superficies de control.
7. Capturas antes/después de las cuatro, lado a lado, en `test-results/`.
8. Cero `.tsx` modificados salvo `layout.tsx`.

Los 28 hex quemados en `.tsx` se **inventarían** en Fase 0 y se corrigen en la fase de cada pantalla
—no antes, porque tocarlos rompe la regla de los dos archivos.

### 3.6 Hallazgo: el barrido responsive sub-detecta desbordes

`scripts/test-responsive-sweep.mjs` fija el viewport a 375×812 pero **no activa la emulación de móvil**
(`isMobile`), así que mide una ventana de escritorio estrecha, no un teléfono. Medido sobre
`/admin/analitica`:

| Emulación | scrollWidth | Desborde |
|---|---|---|
| desactivada (lo que hace hoy el barrido) | 375 | 0 px |
| activada | 383 | **8 px** — `select.input` de «Sede» y su etiqueta |

Dos consecuencias, y ninguna es de Fase 0:

1. **Defecto real y previo en H1 Analítica**: el `<select>` de sede desborda en móvil. Estaba en las
   capturas del *antes* (+10 px) y sigue tras 0.1 (+8 px, menos porque Manrope es más estrecha).
   Se arregla en la fase de H1.
2. **Hueco en la puerta de calidad**: mientras el barrido no emule móvil, seguirá dando verde sobre
   desbordes reales. `scripts/shoot-surfaces.mjs` sí emula y por eso los ve.

Endurecer el barrido pondría en rojo una suite hoy verde por un defecto que no toca arreglar todavía:
es una decisión de Ivan, no una consecuencia técnica del rediseño.

---

### 3.7 Fase 0 — resultado

Cerrada en `f3dc9c0` (0.1), `232ead8` (0.2) y `d84b6cf` (0.3).

| Criterio | Estado |
|---|---|
| 1 · Contrato de selectores | ✅ 562 clases y 544 reglas base intactas |
| 2 · typecheck · lint · build | ✅ |
| 3 · Barrido responsive **con emulación móvil** | ✅ 24/24 |
| 4 · Pruebas de UI por selector | ✅ ventas, analítica y alta de productos |
| 5 · Cero hex crudos fuera de `:root` | ⚠️ quedan 70 usos (57 valores) decorativos de una sola pantalla |
| 6 · Contraste AA | ✅ en las cuatro superficies, con `check-contrast.mjs` |
| 7 · Capturas antes/después | ✅ `test-results/redesign/` |
| 8 · Cero `.tsx` salvo `layout.tsx` | ⚠️ una excepción: `AnalyticsView.tsx` (§3.6) |

Los dos criterios con asterisco son deudas conscientes, no descuidos:

- **Los 70 hex restantes** son gradientes de carta, badges del PDF y colores de
  una sola pantalla. Colapsarlos en un token del núcleo habría cambiado el
  aspecto en 0.2, que es justo lo que ese paso prometía no hacer. Se resuelven
  en la fase de su pantalla.
- **La excepción de `AnalyticsView.tsx`** está justificada en §3.6: el defecto
  no se podía arreglar desde CSS porque su causa era que el CSS no llegaba.

Herramientas que deja la fase, y que sirven para todas las siguientes:
`gate-selectors` (contrato), `shoot-surfaces` (capturas con emulación),
`compare-shots` (cuánto cambió, en %) y `check-contrast` (AA sobre superficie real).

**Pendiente heredado**: quedan dos `style={{ gridTemplateColumns }}` en línea
(`AnalyticsView.tsx:106`, `MarketingView.tsx:175`). Hoy no desbordan porque
`.order-tabs` lleva `min-width: 0`, pero son la misma trampa de §3.6.
Y los scripts de UI usan tres nombres distintos para la misma variable de
entorno: `UI_BASE_URL`, `E2E_BASE_URL` y `PRODUCT_REGISTRATION_BASE_URL`.

## 4. S2 — Navegación (después de Fase 0)

Ocho áreas con navegación secundaria dentro de cada una. `Topbar.tsx` pasa de lista plana a
estructura de áreas. **Ninguna URL cambia.**

Implementado en `Topbar.tsx`. Solo se listan pantallas que **existen hoy**; las
del plan original que aún no tienen ruta (Historial, Reservas, Devoluciones,
Reposición, Kardex, Proveedores, Recepciones, Rankings, Tendencias) entran
cuando se construyan, no antes.

```
Ventas       Nueva venta · Caja                    → /admin/ventas · /admin/caja
Inventario   Existencias                           → /admin/inventario
Clientes     Conversaciones · Carritos             → /admin/conversaciones · /admin/carritos
Catálogo     Productos · Catálogo PDF              → /admin/productos · /admin/pdf
             (+ Importaciones si developer y flag) → /admin/importaciones
Compras      Órdenes · Gastos                      → /admin/compras · /admin/gastos
Marketing    Atribución · Campañas · Canales       → /admin/atribucion · /admin/campanas · /admin/canales
Analítica    Tablero                               → /admin/analitica
Asistente                                          → /admin/asistente
```

**Ninguna URL se movió**, comprobado ruta a ruta. El segundo nivel solo aparece
cuando el área tiene más de una pantalla: repetir un área de una sola entrada
es ruido.

Dos cosas que la agrupación destapó:

- **Campañas y canales existían y no eran alcanzables** desde la barra. Ahora sí.
- **`/admin/estructura` no es una pantalla**: es un stub que redirige al alta de
  productos. Se dejó fuera de la barra — ofrecerla sería prometer algo que deja
  al usuario en otro sitio sin explicación.

Resuelto al implementarlo:
- Activo de área **y** de sub-entrada, ambos por `pathname.startsWith`.
- El filtro por rol se mantiene: la vendedora ve Ventas, Inventario, Clientes y Asistente, y su
  caja vive dentro de Ventas.
- Alias y redirecciones: no ahora.

Por qué no mover rutas, con evidencia: seis scripts de prueba navegan a URLs literales
(`/admin/atribucion`, `/admin/ventas`, `/admin/analitica`…). Renombrar rutas convierte un rediseño
en una migración.

**Puerta nueva**: `scripts/check-nav.mjs` comprueba que cada ruta sigue respondiendo donde siempre,
que marca su área, y que la vendedora no ve ni una pantalla administrativa **en ninguno de los dos
niveles**. Las dos rutas que no son pantalla están declaradas como tales, así que la puerta no tiene
rojos crónicos que la gente aprenda a ignorar.

Al implementarlo hubo que tocar `test-sales-ui.mjs`: su aserción leía solo `.topbar-nav .nav-pill`,
y la caja de la vendedora ahora vive en el segundo nivel. **La exigencia no se debilitó** —sigue
pidiendo que vea Ventas, Caja e Inventario y ninguna sección administrativa—, solo mira los dos
niveles. Cuando cambia la arquitectura de información, la prueba que la describía cambia con ella.

---

## 5. Orden de ejecución

```
Fase 0 Fundación
  → S2 Navegación
  → B1 Nueva venta
  → A1 Inicio dueña          (incluye cambiar /admin: hoy cae en /productos/nuevo)
  → D1 Inventario + D2 Reposición
  → F1 Productos + F2 Ficha
  → E1 Compras
  → H1 Analítica
  → resto del panel
  → P1 Catálogo público
```

Inventario y Reposición van temprano a propósito: después de vender, el segundo circuito del negocio
es *se vendió → bajó stock → se agota → hay que reponer → comprar → recibir*. Adelantarlo prueba que
la identidad nueva sirve para mercadería y no solo para dinero.

El catálogo público va casi al final aunque sea el más vistoso: primero el sistema que trabaja,
después la vitrina que vende.

**Tonos, tres velocidades** (se aplica en B1 y F2, no es fase aparte):
sé cuál quiero → búsqueda textual · tengo el producto → escáner · quiero elegir → carta visual.

---

## 6. Lo que este plan NO hace

- No crea A2 Inicio vendedora.
- No cambia rutas, ni lógica, ni contratos de API, ni base de datos.
- No renombra selectores.
- No introduce serif.
- No introduce librería de componentes ni framework CSS.

---

## 7. Aprobaciones — resueltas

1. **Fuente: no hizo falta descargar nada.** Los prototipos aprobados ya traen Manrope autoalojada en
   base64, en los cuatro pesos exactos del plan (400/500/600/700). Se extrajeron a `src/fonts/`
   —55 KB en total— y así lo que renderiza la aplicación es byte a byte lo que Ivan aprobó.
   Comprobada la cobertura de glifos: todo el latín, acentos, `¿¡`, comillas tipográficas y símbolos
   de moneda están presentes. `✓ ✗ → ←` **no** están en Manrope y caen a `'Segoe UI'` — igual que en
   el prototipo aprobado, así que no es una regresión sino el comportamiento aprobado.
2. **La regla de los dos archivos**: aceptada.
3. **El bloque `.ops-*` cambiará de aspecto** al declarar las variables fantasma (§3.2). Aceptado y
   esperado; se mira en Compras al validar.
4. **Radios, rutas y exceso en pago dividido**: decididos, ver
   [rediseno-prototipos-aprobados.md](rediseno-prototipos-aprobados.md) §6.
