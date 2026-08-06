# Riesgos de la V2 — Bellaroshé

**Bloque 0 · entregable 0.5**
**Rama:** `audit/bellaroshe-v2`
**Fecha:** 2026-08-06

Escala de impacto: **Crítico** (detiene o destruye trabajo) · **Alto** (compromete una entrega) · **Medio** (genera retrabajo) · **Bajo** (molestia acotada).

---

## Riesgos activos

### R-00 · El activo principal no está respaldado en Git — **Crítico**

**Situación.** 115 rutas están sin commitear en el árbol de trabajo: 20 migraciones (6.402 líneas SQL), el modelo V2 completo, el alta guiada, el importador, los pedidos, las pruebas pgTAP y los seeds. El último commit (`4afd01b`) solo llega a `0001`.

**Consecuencia si se materializa.** Un `git checkout`, un `git clean`, un fallo de disco o un `stash` mal aplicado destruye semanas de trabajo. No hay copia remota.

**Mitigación.** Commitear hoy en `audit/bellaroshe-v2` y empujar a `origin`. No hay razón para retrasarlo: la rama está aislada y no toca producción.

**Estado.** Abierto. **Es la primera acción a ejecutar.**

---

### R-12 · `.env` contiene credenciales de producción y Next.js lo carga siempre — **Crítico**

**Situación.** El archivo `.env` del directorio de trabajo apunta a un proyecto **remoto** de Supabase (`https://<project-ref>.supabase.co`) e incluye su `SUPABASE_SERVICE_ROLE_KEY` real. `next dev` lo carga en cada arranque: la propia consola lo anuncia con `Environments: .env.local, .env`.

Hoy no rompe nada porque `.env.local` tiene precedencia y define las tres variables de conexión. La protección es **el orden de precedencia, no una barrera**.

**Consecuencia si se materializa.** Basta con que falte una línea en `.env.local` —o que alguien lo borre, lo renombre o clone el repo sin recrearlo— para que el servidor de desarrollo, el `build` y cualquier ruta administrativa escriban en **producción con service_role**, que ignora RLS. Contradice directamente la regla 1 del plan y el diseño de seguridad del propio proyecto, que en scripts sí exige `--allow-remote` y `--confirm-project`.

Atenuante: `.env` está en `.gitignore` y no se filtró al repositorio. El riesgo es operativo, no de exposición pública.

**Mitigación.**
1. Renombrar `.env` a `.env.remote` —ya está en `.gitignore` y Next.js no lo carga— o vaciarlo dejando solo `PUPPETEER_EXECUTABLE_PATH`, que es lo único de esa lista que no es un secreto.
2. **Rotar la `service_role` del proyecto remoto**, porque estuvo en texto plano en una ruta de desarrollo durante semanas.
3. Considerar extender a la aplicación la misma guarda que ya protege a los scripts: fallar el arranque en desarrollo si `NEXT_PUBLIC_SUPABASE_URL` no es loopback.

**Estado.** Abierto. **Máxima prioridad.**

---

### R-01 · El entorno local no arranca en esta máquina — **Resuelto (2026-08-06)**

**Situación.** `npx supabase start` fallaba porque Windows reserva el rango 54234–54333, que contiene los puertos 54320, 54321 y 54322 que Supabase traía por defecto. Confirmado con `netsh int ipv4 show excludedportrange` y con una prueba de bind directa.

**Resolución.** Se reasignó el stack local a la banda libre `55320-55329` en `supabase/config.toml`: api `55321`, db `55322`, shadow `55320`, studio `55323`, mailpit `55324`, analytics `55328`, pooler `55329`. Se actualizaron `.env.local`, `.env.supabase.local`, `.env.example` y el README.

La guarda de `scripts/lib/supabase-script-env.mjs` dejó de comparar contra un puerto fijo, sin perder fuerza: ahora exige host loopback exacto, protocolo HTTP y ausencia de `SUPABASE_PROJECT_REF` —condición nueva que cierra el caso de un túnel que termina en loopback pero apunta a un proyecto remoto—. `--allow-remote` y `--confirm-project` siguen intactos.

**Verificado.** `db:reset:local`, `typecheck`, `lint` y `test:db` (32 aserciones, PASS) sobre el stack nuevo.

---

### R-02 · Dos modelos de producto vivos en paralelo — **Alto**

**Situación.** El alta V2 escribe simultáneamente las columnas V1 (`src/lib/admin/catalog-v2-service.ts:507-512`) y `ProductForm`, `ProductListView` y el generador de PDF siguen leyéndolas. `product_images` (V1) coexiste con `media_assets` + `product_media` (V2).

**Consecuencia.** Divergencia silenciosa: un precio corregido en `variant_prices` y no en `products.unit_price` produce dos verdades. Toda función nueva hereda la ambigüedad.

**Mitigación.** Migrar los consumidores restantes a V2, verificar cero lecturas V1 y recién entonces emitir la migración de retiro. Ya está previsto en `docs/CATALOG_V2_IMPLEMENTATION.md` §14; falta ejecutarlo antes de construir los Bloques 1–2 encima.

**Estado.** Abierto.

---

### R-03 · Sin auditoría de cambios — **Alto**

**Situación.** No existe tabla de auditoría. En 32 tablas hay tres columnas de autoría: `orders.created_by`, `import_batches.created_by`, `pdf_exports.generated_by`. No se registra quién modificó un producto, un precio o una disponibilidad.

**Consecuencia.** El Bloque 2 exige que las vendedoras registren anulaciones y devoluciones sin aprobación previa, con trazabilidad completa (reglas 7 y 8). Sin auditoría eso es inauditable. Añadirla después, con datos reales, es mucho más caro.

**Mitigación.** Modelar la auditoría en el Bloque 1, antes de la primera venta registrada.

**Estado.** Abierto.

---

### R-04 · La organización no está modelada — **Alto**

**Situación.** No existe `branch_id` en ninguna tabla; `app_role` solo admite `admin` y `developer`.

**Consecuencia.** El plan es explícito: *"aunque inicialmente exista una sede, toda venta, compra, reserva y disponibilidad debe guardar `branch_id`"*. Introducirlo después obliga a migrar cada tabla transaccional y a rehacer las políticas RLS.

**Mitigación.** Crear sedes y roles en la primera migración del Bloque 1, antes de cualquier tabla de operación.

**Estado.** Abierto.

---

### R-05 · Contratos SQL sin verificación de tipos — **Medio**

**Situación.** `catalog_list_v2`, `catalog_product_detail_v2` y `evaluate_cart_v2` devuelven `jsonb`. Los tipos de `src/lib/catalog/contracts.ts` se escriben a mano y no se generan desde el esquema.

**Consecuencia.** Cambiar la forma del JSON en SQL no rompe la compilación: falla en tiempo de ejecución, posiblemente en producción.

**Mitigación.** Generar tipos con `supabase gen types typescript`, o validar la respuesta con Zod en el borde (Zod ya es dependencia). El riesgo crece con cada contrato nuevo de los Bloques 1–3.

**Estado.** Abierto.

---

### R-13 · Los seeds se desincronizan de las migraciones sin que nada lo detecte — **Alto**

**Situación.** Al ejecutar por primera vez `supabase db reset` se comprobó que **la base no se recreaba desde cero**: `supabase/seeds/0002_v2_demo.sql` fallaba con `No se puede publicar: faltan atributos obligatorios del producto` (SQLSTATE 23514). El seed se escribió el 21 de julio; las migraciones `0013` y `0015` añadieron después tres atributos obligatorios a la plantilla de esmalte (`net_content_amount`, `net_content_unit`, `requires_lamp_v2`) y `0014` sumó la dependencia que vuelve obligatoria `lamp_technology` cuando la lámpara se requiere. El producto demo de esmalte nunca los cargó.

**Consecuencia.** Durante aproximadamente dos semanas el entorno local fue irreproducible y nadie lo notó, porque ninguna verificación ejecuta `db reset`. La documentación afirmaba que el comando reconstruía la base; no lo hacía.

**Mitigación.** Corregido en el seed. La causa de fondo persiste: no hay ninguna comprobación que ejecute `db reset` y falle visiblemente. Debe ser el primer paso de cualquier verificación previa a un despliegue, y idealmente parte de CI. Se relaciona con [R-06](#r-06--ninguna-prueba-corre-sin-docker--medio).

**Estado.** Defecto corregido; la brecha de proceso sigue abierta.

---

### R-06 · Ninguna prueba corre sin Docker — **Medio**

**Situación.** 32 aserciones pgTAP y 24 scripts de integración, todos dependientes de Supabase local. Cero pruebas unitarias; no hay Vitest ni Jest.

**Consecuencia.** R-01 dejó el proyecto sin **ninguna** verificación ejecutable. Tampoco hay CI posible sin levantar la infraestructura completa.

**Mitigación.** Añadir un runner unitario para la lógica pura (validaciones, normalización de importación, generador de WhatsApp, formateo) y conservar pgTAP para las reglas de base.

**Estado.** Abierto.

---

### R-07 · Familias comerciales duplicadas entre datos y código — **Medio**

**Situación.** Las ocho familias existen como filas en `attribute_templates` y como arreglo `PRODUCT_TYPES` en `CatalogV2ProductForm.tsx:38-47`, con `templateCodes` y `categorySlugs` escritos a mano.

**Consecuencia.** Registrar cera, maquillaje o polygel exige un despliegue de código, no una carga de datos. Contradice la extensibilidad que el modelo sí ofrece y reintroduce la "condición especial por familia" que el plan prohíbe.

**Mitigación.** Leer las familias desde la base y dejar en código solo lo estrictamente visual (icono, ejemplo).

**Estado.** Abierto.

---

### R-08 · Imágenes de producto sin optimizar — **Medio**

**Situación.** `next/image` se usa en 4 puntos, todos de marca. Las imágenes de producto usan `<img>` crudo en `HomeView`, `ProductView`, `SelectionView` y `ProductListView`.

**Consecuencia.** Sin `srcset`, sin carga diferida, sin WebP/AVIF. Con 1.500 productos y clientas en móvil, es el primer cuello de botella percibido.

**Mitigación.** Migrar a `next/image` y configurar `remotePatterns` para el dominio de Supabase Storage.

**Estado.** Abierto.

---

### R-09 · Infraestructura remota sin documentar ni versionar — **Medio**

**Situación.** No hay `vercel.json` ni `vercel.ts` en el repositorio. No consta el proyecto de Supabase remoto, ni los dominios, ni los respaldos, ni un entorno de prueba, ni un procedimiento de reversión. El plan exige los tres entornos y la reversión (Bloque 5).

**Consecuencia.** Un despliegue fallido no tiene camino de vuelta documentado.

**Mitigación.** Levantar el inventario real de Vercel y Supabase, crear el entorno de prueba y escribir el procedimiento de reversión antes de la primera migración remota.

**Estado.** Abierto. **Este dato no pudo obtenerse desde el repositorio; requiere acceso a las consolas.**

---

### R-10 · Migración de los 1.500 registros reales — **Medio**

**Situación.** El área de importación (`import_batches` / `import_rows` / `import_issues`) está modelada y `commit_approved_import_row` funciona, pero no hay asistente visual, ni corrección masiva, ni conciliación de imágenes. El Excel real vive fuera del repositorio.

**Consecuencia.** El plan prohíbe editar producción a mano para "acomodar" los datos. Sin herramienta de revisión, la tentación de hacerlo es alta.

**Mitigación.** Completar el flujo de revisión antes de la migración definitiva y respetar la secuencia: exportación → lote → normalización → validación → migración de prueba → revisión → migración definitiva.

**Estado.** Abierto.

---

### R-11 · Alcance del Bloque 4 desproporcionado frente a la base — **Bajo hoy, Alto si se adelanta**

**Situación.** El Bloque 4 promete audio, reconocimiento fotográfico, asesor omnicanal y detección de tendencias. La base de ventas, costos y disponibilidad todavía no existe.

**Consecuencia.** Adelantar IA sobre datos incompletos produce recomendaciones sobre productos inexistentes o sin disponibilidad, justo lo que el plan prohíbe.

**Mitigación.** Respetar el orden de bloques. Las reglas 9 y 10 —la IA nunca confirma una venta y su caída no impide operar— deben quedar como restricciones de diseño desde el primer prototipo.

**Estado.** Latente.

---

## Riesgos descartados tras verificación

| Riesgo hipotético | Verificación | Conclusión |
|---|---|---|
| Secretos versionados | `git ls-files \| grep env` → solo `.env.example` y `.env.remote.example`, ambos con marcadores | Descartado |
| `service_role` filtrado al cliente | `grep -rn createSupabaseServiceClient src/` → una sola definición, **cero invocaciones** | Descartado |
| Tablas sin RLS | 32 tablas creadas, 32 con RLS habilitada | Descartado |
| Rutas administrativas sin autorización | 18 rutas bajo `/api/admin/`, todas con `requireAdmin` o `requireDeveloper` | Descartado |
| Precios calculados en el navegador | El cliente solo formatea; `evaluate_cart_v2` revalida en servidor antes de carrito, WhatsApp y pedido | Descartado |
| Catálogo paginado en el navegador | `catalog_list_v2` aplica `offset/limit` y devuelve conteos desde PostgreSQL | Descartado |
| Importador expuesto | Exige rol `developer` **y** `ENABLE_CATALOG_IMPORTS=true`; devuelve 404 si falta cualquiera | Descartado |
| Dependencias abandonadas | Next 15.5.20, React 19.2.7, TS 5.9.3, Node 24.16.0. Único residuo: `pdfkit` sin uso | Descartado |

---

## Orden de atención sugerido

1. ~~**R-00** — commitear y empujar~~ · **Resuelto** el 2026-08-06: `11cf0ee` en `audit/bellaroshe-v2` y `feature/bellaroshe-platform-v2`, ambas en `origin`.
2. ~~**R-01** — desbloquear el entorno local~~ · **Resuelto** el 2026-08-06 con la banda `55320-55329`.
3. **R-12** — sacar las credenciales de producción de `.env` y rotar la `service_role`. **Lo más urgente que queda.**
4. **R-04** y **R-03** — sedes, roles y auditoría en la primera migración del Bloque 1.
5. **R-13** y **R-06** — que `db reset` forme parte de la verificación, no de la buena voluntad.
6. **R-02** — retirar V1 antes de construir la operación comercial encima.
7. **R-07**, **R-05** — durante el Bloque 1.
8. **R-09**, **R-10** — antes del primer despliegue remoto.
9. **R-08** — antes de publicar el catálogo completo.
10. **R-11** — vigilar en cada revisión de alcance.
