# Bloque 4 — Registro de ejecución

**Rama:** `feature/bellaroshe-platform-v2` · **Fecha de cierre:** 2026-08-07
**Propósito:** dejar por escrito cómo se construyó la inteligencia comercial y la asistencia IA sin traicionar las dos reglas duras del plan — **la IA nunca confirma una venta** (regla 9) y **su caída no impide la operación manual** (regla 10) — y qué decisiones las hicieron estructurales en lugar de promesas.

---

## Las migraciones (0043–0044)

| # | Contenido | La decisión que la gobierna |
|---|---|---|
| `0043` | `business_dashboard(desde, hasta, sede)` | UN contrato de lectura admin; todo importe nace del Bloque 2/3, nada se recalcula fuera. Regla 16: la utilidad neta incluye TODOS los gastos registrados y es **NULL** —no cero— cuando algún costo es desconocido (la doctrina de `sale_margins`) |
| `0044` | `ai_interactions` + `content_proposals` | La IA es una asistente con evidencia: propuesta inmutable, estado que avanza en una sola dirección (proposed → confirmed/discarded/failed), enlace a venta **write-once** y solo tras confirmación humana. El contenido de tendencias fluye draft → approved/rejected → published, sin atajos y sin publicación automática |

## Decisiones que definen el bloque

1. **El corazón del intérprete es determinista** (`src/lib/ai/matching.ts`, puro y sin imports). El LLM solo segmenta el habla; las coincidencias salen SIEMPRE del matching contra el catálogo real — por construcción no se puede proponer un SKU inventado. Cada ítem termina como línea clara, **ambigüedad declarada** (decide la persona) o «no encontrado».
2. **Un solo punto de contacto con el proveedor** (`provider.ts`, `@anthropic-ai/sdk`, `claude-opus-5`, salidas estructuradas con zod/v4). La regla 10 vive ahí: sin `ANTHROPIC_API_KEY` no hay excepción sino un resultado — el intérprete y la asesora degradan al camino determinista (`degraded`), la visión responde `unavailable` honesto, y todo queda registrado en la evidencia con su `provider_status`.
3. **La visión es por etapas**, como pide el plan: un producto o grupo ≤ 6. Nadie promete 40 esmaltes de una foto; el prompt exige ceñirse a lo VISIBLE y la etapa acota el máximo. La visión **describe**; qué existe lo decide el matching contra el catálogo.
4. **El asesor es un núcleo único** para todos los canales: recibe la lista cerrada del catálogo disponible y toda recomendación devuelta se valida contra ella (un id inventado se descarta y queda anotado). Hoy lo consumen la vendedora (asistente y conversación); mañana un canal público puede llamarlo sin tocar nada.
5. **El ciclo se cierra en Ventas, no en el asistente.** «Llevar a Ventas» entrega la propuesta SIN precios (el asistente jamás es fuente de precio); la pantalla de Ventas la evalúa con PostgreSQL como cualquier borrador y, al registrar la venta o reserva REAL, confirma cada interacción enlazándola. La regla 9 es visible en los datos: `ai_interactions.sale_id` apunta a lo que una persona ejecutó por `register_sale`.
6. **Tendencias propone; la dueña decide.** `mark_content_published` no llama a ninguna API ni publica nada: registra que un humano publicó él mismo, con su identidad, y solo sobre lo aprobado.
7. **Registro por audio sin servidor de voz**: el dictado lo transcribe el navegador (Web Speech API, es-PE) y el texto viaja como cualquier otro. Sin micrófono o sin soporte, se escribe — el flujo no depende de nada externo.

## Defectos que las pruebas encontraron antes de commitear

- **`normalizeText` borraba las comas antes de segmentar**: «…kit de gel, 3 pestañas» quedaba como un solo ítem. La segmentación ahora parte por puntuación ANTES de normalizar.
- **Las muletillas tapaban la cantidad**: «quiero dos rojos» leía cantidad 1. Los rellenos iniciales se retiran antes de leer el número.
- **`products.template_id` es obligatorio desde el catálogo V2**: el fixture del tablero necesitó su plantilla de atributos (y variante predeterminada activa, exigida por trigger diferido — otra vez la lección de COMMIT).
- **El guion de concurrencia omnicanal no era re-entrante**: una corrida interrumpida dejaba la sede `OMNICONC` y la siguiente chocaba contra el índice único. La purga previa lo corrige, y de paso destapó un `id` ambiguo en el subquery de limpieza que llevaba dormido desde el B3.
- **El helper de login esperaba una ruta exacta** (`/admin/productos`) cuando el destino tras el login varía por rol; las verificaciones de pantalla aceptan ahora cualquier destino del panel. Además `networkidle0` es eterno con las conexiones vivas de Supabase: las esperas son por DOM.
- **Tipos zod v3 vs v4**: el helper de salidas estructuradas del SDK exige la API `zod/v4` (subpath de zod ≥ 3.25). Solo la capa IA la usa; el resto del proyecto sigue en la clásica.

## Cómo se verifica

**pgTAP:** 490 aserciones en 19 archivos — base operada, base virgen reconstruida desde cero y segunda pasada, todo en verde. 0043 verifica la matemática del tablero con importes elegidos a mano (margen 110, contribución 100, utilidad 75, deuda 60, proveedor más conveniente); 0044 demuestra contando ventas que resolver asistencias no crea ninguna, y que la evidencia ni se reescribe ni se borra (ni con service_role).

**Unitaria del intérprete** (`test:ai-matching`): 11 casos puros — pedido claro, ambiguo, inexistente, SKU exacto, cantidades en palabra y cifra, acumulación.

**Integral B4** (`test:block4`), 23 verificaciones sobre contratos reales:

```
tablero ≡ recomputación independiente (ventas, gastos, margen, utilidad,
filtro por sede, 42501 a la vendedora) → batería IA del plan (correcto /
ambiguo / inexistente contra catálogo real; caída registrada como fallo)
→ regla 9 contada: proponer y resolver no crea ventas; register_sale por
una persona; la asistencia queda confirmada y ENLAZADA; las ventas crecen
en exactamente una → tendencias: borrador no publicable, revisado no
re-revisable, publicada con la identidad de quien publicó → la evidencia
de IA no se puede borrar ni con service_role
```

Corre dos veces seguidas (23/23 y 23/23) y sobre la base recién reconstruida (22/22 — el filtro por sede se omite sin ventas previas).

**Pantallas** (build de producción, sesión real, SIN credencial de IA — el entorno exacto de la regla 10): 9/9 en analítica (presets, indicadores, regla 16 en el contrato) y 10/10 en el asistente — dictado→propuesta→Ventas con prefill, foto «no disponible» con evidencia, asesora degradada respondiendo, tendencias generar→aprobar→«ya la publiqué», y el borrador del asesor en el compositor de una conversación real.

**Regresión:** integrales B2 y B3, concurrencia de ventas y omnicanal — todo en verde también tras la reconstrucción.

## Lo que queda fuera, a propósito

- **«Recrea este look» completo** quedó como caso del asesor+visión (misma infraestructura: foto → descripción → matching → recomendación con confirmación), no como pantalla dedicada: el plan lo lista dentro del asesor y la arquitectura ya lo soporta; una pantalla propia sería duplicar el asistente.
- **El chatbot autónomo NO existe** (§41 del B3 sigue vigente): el asesor produce borradores que una persona envía. La arquitectura deja el punto de enchufe (núcleo único + `conversation_id` en la evidencia) para cuando el plan lo autorice.
- **Credencial real de IA**: el entorno local no la tiene y el cierre se hizo así adrede — todo el bloque debe operar degradado. Con `ANTHROPIC_API_KEY` en el entorno del servidor (documentada en `.env.example`, jamás con prefijo público) las mismas rutas suben a `ok` sin tocar código.
