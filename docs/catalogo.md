# Catálogo, evidencia y revisión

**Corte medido:** 2026-08-17. Los conteos de este documento son fotografías locales fechadas, no constantes del sistema.

## Modelo comercial

- `products` representa una familia o artículo comercial.
- `product_variants` representa cada unidad vendible: tono, talla, presentación, curva, largo u otro eje.
- Marcas, líneas, categorías, plantillas y atributos son diccionarios reutilizables.
- Los tonos viven en una biblioteca contextual por marca/línea y una variante puede apuntar al tono correcto.
- Medios pueden pertenecer al producto o a una variante, nunca a ambos simultáneamente.
- Los estados editoriales son `draft`, `in_review`, `published`, `hidden` e `incomplete`; la lectura pública exige activo y publicado.
- La disponibilidad operativa usa `available`, `sold_out` o `consult`; `consult` no recibe un precio inventado.

## Corte local comprobado

La última reconstrucción certificada aplicó las migraciones `0001`–`0112` y ejecutó 49 archivos con 1.152 comprobaciones pgTAP. El último conteo comercial explícito, medido al cierre de Etapa 2, fue 1.056 productos y 1.578 variantes; no se presenta como conteo vigente. El Universo de Referencia es un volumen independiente y cualquier decisión futura debe volver a medir ambos dominios.

## Fuente de verdad y capas de trabajo

| Capa | Responsabilidad | Puede publicar por sí sola |
| --- | --- | --- |
| Catálogo canónico | Productos, variantes, atributos, precios y medios aprobados | Sí, mediante sus contratos |
| Procedencia | Fuente, snapshot, observación, URL, hash y licencia | No |
| Reconciliación | Coincidencias, contradicciones, alternativas y confianza | No |
| Mesa de revisión | Prioridad, dependencias, eventos, aplazamientos y lotes | No |
| Conocimiento | Sistemas, etapas, clases, roles, reglas y relaciones aprobadas | Solo a través de su gate |
| Grafo/MCP | Lectura y orquestación reconstruible | Nunca escribe directo |

## Mesa de revisión

La única entrada humana es `Catálogo → Revisar`, con tres superficies: Inicio, Revisión y Expediente.

- La prioridad es lexicográfica: riesgo, contradicción, resolubilidad, impacto, relevancia, antigüedad y esfuerzo.
- Cambiar de caso solo lo omite durante la sesión; no lo resuelve.
- “No tengo evidencia suficiente” aplaza con motivo y fecha; conserva el caso abierto.
- Cada problema tiene una identidad de familia y una versión material. Reprocesar la misma evidencia no reabre una decisión.
- `resolve_catalog_review_item_v1` aplica decisión, verdad canónica, evento e impacto en una transacción.
- Los lotes masivos usan un snapshot congelado; un cambio de membresía cancela la aplicación completa.
- Precio faltante no bloquea una decisión de identidad o conocimiento.

El reprocesamiento certificado de Etapa 3 dejó 1.447 trabajos activos: 387 excepciones humanas accionables, 436 deudas automáticas, 527 capturas físicas, 66 esperas externas y 31 bloqueos. Cerró 231 trabajos y preservó la historia. Es un corte del 12 de agosto; debe consultarse la proyección vigente antes de planificar capacidad.

## Identidad de familia frente a identidad de variante

Una coincidencia de marca, línea, categoría y presentación puede confirmar que un registro oficial pertenece a una familia sin demostrar que sea la variante mostrada en pantalla.

Caso de aceptación comprobado: la campaña oficial ADMISS descubrió `ZAC` y su SKU sin reglas por nombre, resolvió por separado familia y variante y contrastó la clasificación oficial de `AJO Y LIMÓN` con la interna. Los apuntes históricos son entrada, no conclusión; la respuesta vigente sale de PostgreSQL y su evidencia.

## Evidencia e imágenes

- Preferir fabricante o marca oficial; después distribuidor autorizado y fuentes secundarias identificadas.
- Conservar URL, fecha, registro externo, SKU/código, hash exacto y perceptual, dimensiones y condiciones de uso.
- Una URL descubierta no es un medio publicable. Debe descargarse, validarse, normalizarse, deduplicarse y aprobarse.
- Nunca usar la imagen de otro tono como relleno. Un color de referencia explícito puede funcionar como fallback visible y marcado.
- La imagen oficial es evidencia de identidad; no demuestra por sí sola compatibilidad técnica ni derechos amplios de reutilización.

## Conocimiento de sistemas y relaciones

El primer vertical profundo es Sistema Acrílico. Modela proceso, etapas, clases, roles esperados, brechas y recomendaciones con evidencia. Sus reglas centrales son:

- un producto puede cubrir una clase o rol sin estar probado como pareja compatible con otro;
- compartir marca solo ayuda a ordenar candidatos;
- una compatibilidad no demostrada se devuelve como `unknown_pair`;
- las brechas físicas permanecen fuera de las aristas afirmativas;
- la proyección de grafo excluye precio y stock y es de solo lectura.

Las colas de captura física y los candidatos oficiales deben consultarse en la base y en [research/catalog-master](../research/catalog-master/README.md), no copiarse a otra tabla manual.

## Flujo de investigación manual

1. Capturar el texto bruto sin decidir.
2. Asignar `case_id` y estado en `manual-intake`.
3. Buscar primero fuentes oficiales y conservar las consultas.
4. Inventariar registros, códigos e imágenes; no promover todavía.
5. Separar identidad de familia, identidad de variante, imagen y relación.
6. Preparar recomendación con contradicciones y alternativas.
7. Aplicar solo mediante el comando autorizado de la Mesa.

Los estados manuales son `CAPTURADO`, `INVESTIGAR`, `LISTO_PARA_DECIDIR`, `APLICADO` y `BLOQUEADO`.

## Próximo foco

El plan vigente es [Inteligencia de Catálogo Bellaroshé](plan-vivo-mcp-inteligencia-catalogo.md). Etapas 2 y 3 están cerradas; ADMISS cubre la primera campaña real marca + fuente, el reprocesamiento de Mesa y la ingesta epistemológica universal hasta `0112`. El 2026-08-17 se autorizó humanamente iniciar Etapa 4, que debe comenzar por sistemas y clases bajo las guardas certificadas. Resolver decisiones, publicar, fijar precio Bellaroshé o modificar inventario sigue fuera de MCP.
