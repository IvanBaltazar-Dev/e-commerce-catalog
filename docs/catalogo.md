# Catálogo, evidencia y revisión

**Corte medido:** 2026-08-12. Los conteos de este documento son una fotografía local, no constantes del sistema.

## Modelo comercial

- `products` representa una familia o artículo comercial.
- `product_variants` representa cada unidad vendible: tono, talla, presentación, curva, largo u otro eje.
- Marcas, líneas, categorías, plantillas y atributos son diccionarios reutilizables.
- Los tonos viven en una biblioteca contextual por marca/línea y una variante puede apuntar al tono correcto.
- Medios pueden pertenecer al producto o a una variante, nunca a ambos simultáneamente.
- Los estados editoriales son `draft`, `in_review`, `published`, `hidden` e `incomplete`; la lectura pública exige activo y publicado.
- La disponibilidad operativa usa `available`, `sold_out` o `consult`; `consult` no recibe un precio inventado.

## Corte local comprobado

La auditoría previa al plan MCP encontró 1.056 productos, 1.578 variantes, 185 marcas y 253 tonos en la base local. Las migraciones `0001`–`0100` estaban aplicadas y la suite completa alcanzaba 876 comprobaciones pgTAP. Estos números deben volver a medirse antes de citarlos en una decisión futura.

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

El corte del 10 de agosto proyectaba 407 casos revisables, 523 de captura, 233 en espera y 48 completados, además de 352 bloqueados por dependencias. Debe consultarse la proyección vigente antes de planificar capacidad.

## Identidad de familia frente a identidad de variante

Una coincidencia de marca, línea, categoría y presentación puede confirmar que un registro oficial pertenece a una familia sin demostrar que sea la variante mostrada en pantalla.

Ejemplo vigente: el registro oficial Admiss `ZAC`, SKU `314094`, pertenece con alta confianza a la familia interna `Esmalte ADMISS` (`ADM-ESM-CA6EEA`). Eso no lo convierte en el tono interno `AJO Y LIMON`; el tono requiere otra reconciliación. El caso completo está en [apuntes-productos.md](../research/catalog-master/manual-intake/apuntes-productos.md).

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

El plan vigente es [el MCP de inteligencia de catálogo](plan-vivo-mcp-inteligencia-catalogo.md). El piloto recomendado usa Admiss porque ya existe evidencia oficial, múltiples tonos con puntuaciones similares y una separación clara entre familia y variante. La primera versión debe leer y preparar trabajo; la escritura permanece limitada al staging de investigación hasta cerrar los contratos.
