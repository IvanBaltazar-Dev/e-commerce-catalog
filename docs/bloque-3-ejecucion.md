# Bloque 3 — Registro de ejecución

**Rama:** `feature/bellaroshe-platform-v2` · **Fecha de cierre:** 2026-08-07
**Propósito:** dejar por escrito lo que se decidió al construir la capa omnicanal, dónde el plan se mejoró deliberadamente, y qué defectos encontraron las pruebas antes de que llegaran a nadie.

La arquitectura obligatoria se cumplió literal: los canales alimentan una capa omnicanal (canales · conversaciones · mensajes · carritos · atribuciones · asignaciones) que desemboca en reserva/venta, y **todo lo comercial sigue siendo del Bloque 2**. No existe una segunda fuente de verdad para precio, stock, venta ni dinero.

---

## Las migraciones (0035–0042)

| # | Contenido | La decisión que la gobierna |
|---|---|---|
| `0035` | canales, cuentas, contactos, personas, visitante anónimo | Canal como **dato**, no enum; historia de vinculación en tabla propia |
| `0036` | conversaciones, mensajes, eventos | Una capa para todos los canales; mensajes inmutables salvo su ciclo de entrega |
| `0037` | carrito público persistente | **Sin columnas de precio**; versionado optimista; conversión que envuelve al Bloque 2 |
| `0038` | fuentes, campañas, atribución | first-touch inmutable **por trigger**; una cadena por recorrido, cerrada por su venta |
| `0039` | asignación con historial | Round-robin **derivado de la historia**, sin tabla de estado; tomar es condicional |
| `0040` | conexiones, webhooks, métricas | Insert-first; evidencia inmutable; el dinero de las métricas sale de `sales` |
| `0041` | despacho de salientes | La identidad externa se **establece una vez** (nulo → valor): el eco de Meta llega después de encolar |
| `0042` | fusión de identidad en atribución | Cuando la clienta web escribe por WhatsApp, sus dos cadenas convergen en la del primer toque más antiguo |

## Mejoras deliberadas sobre el plan

1. **`persons` existe como tabla.** El plan referenciaba `person_id` sin definir la entidad. Se creó mínima —punto de convergencia, no CRM— con teléfono normalizado único entre personas vigentes y fusión solo administrativa. Un nombre parecido jamás vincula nada.
2. **Un solo libro de eventos.** `channel_events` absorbe los eventos de carrito con origen polimórfico sin FK (el patrón del kardex). Dos libros append-only paralelos eran exactamente la duplicación que el plan prohíbe.
3. **El carrito no guarda ni precio ni modalidad.** El plan pedía almacenar la «modalidad comercial» por línea, pero la modalidad ES consecuencia del precio (la regla mayorista depende de cantidades acumuladas) y el propio plan prohíbe el precio histórico en el carrito. Se guarda variante y cantidad; todo lo demás nace de `evaluate_cart_v2` al leer. Una aserción declara que las columnas de precio **no existen**.
4. **first-touch inmutable por trigger, no por convención.** «No sobrescribir Facebook al entrar por WhatsApp» lo impone la base con un error explícito.

## Defectos que las pruebas encontraron antes de commitear

- **Política RLS con `id` sin calificar** (0036): dentro del `EXISTS`, `id` resolvía contra la tabla del subquery y la política de contactos no encontraba jamás una fila. Toda referencia de política quedó calificada contra la tabla protegida.
- **Visibilidad de snapshot en pgTAP** (0038): una función volátil llamada dentro del mismo `SELECT` que lee su resultado no ve sus propias escrituras. Las llamadas van en sentencia aparte.
- **El ACL por defecto de Supabase concede `SELECT` a `anon` sobre toda tabla nueva.** La RLS ya lo dejaba en cero filas, pero la promesa del carrito es más fuerte: `revoke all` explícito, y la aserción 4 de 0037 lo vigila.
- **Fusión de cadenas de atribución** (encontrado por la integral, corregido en 0042): el recorrido real —web con campaña de Instagram, luego WhatsApp— producía dos cadenas abiertas del mismo ser humano y `attach_attribution` moría contra el índice único. La fusión conserva la cadena del primer toque **más antiguo** (la atribución original que §11 prohíbe destruir), avanza el last-touch al más reciente, coalesce los eslabones y elimina el duplicado, que no puede tener venta por la propia unicidad parcial.
- **El carrito persistente bloqueaba la limpieza de pruebas**: `public_cart_items.variant_id` es restrictiva y el flujo E2E deja la selección en el servidor. Las dos limpiezas la retiran antes de borrar el producto.

## La limitación de TikTok, documentada y no inventada

Su API pública no ofrece conversación de mensajería. El adaptador existe, verifica firma y conserva los webhooks crudos (ignorados con motivo); la atribución de TikTok entra por UTM/QR, que sí existe, y el envío de mensajes devuelve un fallo explícito de plataforma. Nada se fingió.

## Cómo se verifica

**pgTAP:** 432 aserciones en 17 archivos, sobre base virgen **y** operada, dos pasadas seguidas.

**Concurrencia con sesiones reales** (`test:omnichannel-concurrency`): el mismo webhook cinco veces simultáneas → una fila; dos webhooks del mismo contacto → 1 conversación y 2 mensajes; el mismo mensaje externo → 1; dos dispositivos contra el mismo carrito → uno gana y el otro recibe `cart_version_conflict`; dos conversiones → 1 venta; dos vendedoras tomando → exactamente una.

**Integral** (`test:block3`), por las superficies reales (HTTP público + RPC autenticados):

```
campaña Instagram → landing captura UTM → carrito persistido → CTA WhatsApp
→ webhook crea conversación → vendedora asignada (round-robin) → carrito
enlazado → la clienta agrega desde su celular por el enlace → reserva con
adelanto → venta → caja recibe el cobro → inventario baja por el kardex
→ atribución: first=instagram+campaña, last=whatsapp → métricas reportan
el ingreso de Instagram y de la campaña
```

y el **abandono**: TikTok mira, no compra, el carrito expira sin venta, sin inventario y sin ingreso, con la atribución conservada y la métrica contándolo.

**Pantallas** (build de producción, sesión real): las seis rutas renderizan; un webhook simulado aparece en la bandeja, el hilo se abre, la respuesta se envía y queda **en cola visible** al no haber credenciales — jamás en un limbo.

## Criterio de cierre (§50), estado

Todo lo listado quedó operativo: carrito persistente y recuperable entre dispositivos, WhatsApp/Facebook/Instagram integrados al modelo único, TikTok en la medida real de su API, mensajes idempotentes, asignación con historial, first/last touch, campañas y UTM conservadas, cadena carrito→reserva→venta enlazable hasta canal y campaña, métricas sobre ventas reales, RLS y concurrencia probadas, UI administrativa y pública operativas, fallo de proveedor aislado del resto (evento en `failed` con reintento; la tienda sigue), migraciones reconstruyendo desde cero, batería completa en verde, typecheck, lint y build.

**Nota de entorno:** Edge quedó bloqueado a nivel máquina durante el cierre (otra sesión); el generador de PDF y las pruebas de navegador usan el Chrome del propio puppeteer vía `PUPPETEER_EXECUTABLE_PATH` en `.env.local`, opción ya documentada en `.env.example`.
