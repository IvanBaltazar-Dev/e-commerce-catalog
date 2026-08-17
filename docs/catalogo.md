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

La última reconstrucción certificada aplicó las migraciones `0001`–`0115` y ejecutó 52 archivos con 1.246 comprobaciones pgTAP. El checkpoint restaurado contiene 1.056 productos y 1.578 variantes; el fixture 4A añade dos referencias oficiales no comerciales, nunca productos vendibles. El Universo de Referencia sigue siendo un volumen independiente y cualquier decisión futura debe volver a medir ambos dominios.

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
- Una nota asociada a una decisión queda con su evento; una nota sin decisión usa el aplazamiento y nunca finge aceptación o rechazo.
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

`0113` formaliza el recorrido sistema→etapa→rol→clase→requisito/capacidad→producto o referencia. Acrílico valida 8 etapas, 16 clases, 16 puentes rol–clase, 8 requisitos y 8 secuencias. Tres requisitos y una transición permanecen en `NEEDS_EVIDENCE`; cuatro cadenas de fuente llegan solo hasta `DERIVED_INFERRED` y no producen hechos canónicos.

`0114` somete las 323 relaciones diferidas a un preview universal inmutable. El corte real produjo 99 membresías, 68 relaciones entre clases, 60 necesidades de evidencia y 96 falsos pares; los 68 pares de relación se condensan en 9 reglas. Ninguna candidata fue aprobada, rechazada o promovida y no se creó trabajo humano por incertidumbre aislada.

`0115` convierte 263 detecciones materiales en 18 decisiones por causa: 9 reglas de clase, 5 correcciones de alcance y 4 retiros de falsos pares. Las 60 necesidades de evidencia quedan como deuda automática. El contrato explica hallazgo, necesidad humana, recomendación, evidencia, impacto y acciones desde backend; evita el 93,16 % de revisión individual y no aplica ninguna decisión.

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

El plan vigente es [Inteligencia de Catálogo Bellaroshé](plan-vivo-mcp-inteligencia-catalogo.md). Etapas 2, 3 y 4A–4D están cerradas; [Etapa 4D](etapa-4d-producto-ux-decisiones.md) dejó aprobada la experiencia con tres decisiones reales. 4E implementará el contrato backend antes de 4F. Resolver decisiones, publicar, fijar precio Bellaroshé o modificar inventario sigue fuera de MCP.
