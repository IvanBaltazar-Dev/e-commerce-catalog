# Etapa 2 · ADMISS completo y MCP local

**Cierre:** 2026-08-12

**Estado:** completada; Etapa 3 no iniciada

**Verdad:** PostgreSQL/Supabase; Neo4j es proyección reconstruible

## Alcance ejecutado

La campaña investigó la marca ADMISS desde la raíz oficial registrada `https://admiss.com.co`. El descubrimiento recorrió 11 superficies derivadas de la raíz, incluidos robots, manifiesto para agentes, sitemaps, colecciones y endpoints de catálogo. No hay URLs de productos ni reglas de ZAC/AJO Y LIMÓN codificadas en la reconciliación.

La captura oficial produjo:

| Dato | Total |
| --- | ---: |
| Productos de referencia | 121 |
| Variantes de referencia | 121 |
| Identificadores | 726 |
| Observaciones | 1.134 |
| Precios externos | 121 |
| Referencias remotas de imagen | 197 |
| `REFERENCE_ENRICHED` / `REFERENCE_LIGHT` | 61 / 60 |

Los tipos oficiales fueron 99 `ESMALTES`, 12 `BRILLOS`, 6 `BASES`, 3 `LIQUIDOS` y 1 `LIMAS`. La reconciliación generó 112 candidatas, una contradicción estructural y dejó 8 productos oficiales sin candidata interna. Los 113 casos pendientes continúan como trabajo humano; ningún caso fue aprobado automáticamente.

## Aceptaciones obligatorias

- `ZAC`, SKU `314094`, conserva nombre, presentación de 10 ml, URL e imagen oficiales y quedó como candidata de `Esmalte ADMISS` (`ADM-ESM-CA6EEA`). No se creó una variante comercial.
- `AJO Y LIMÓN`, SKU oficial `310010`, figura como `BASES` en la fuente y como variante de `Esmaltes` internamente. El caso quedó `needs_review` con `classificationContradiction=true`.
- Los conteos protegidos fueron idénticos antes y después: 1.056 productos, 1.578 variantes, 83 precios internos, 6 saldos de inventario y 162 medios comerciales.

## Delta e idempotencia

La primera corrida observó 242 identidades. La segunda, sin cambio material, reutilizó el mismo snapshot y reportó 242 `unchanged`, cero nuevas, cambiadas, ausentes o reaparecidas. No hubo duplicados en identidad externa, observaciones materiales, precios, medios, casos activos, Mesa, nodos ni aristas.

Shopify modifica `updated_at` aun cuando el producto no cambia. Ese valor se conserva en la captura RAW, pero no participa en la huella material. La huella estable comprobada fue `fe2eaacae33eb94b58a188ffa723732c703ea3c0b66e51beb7c76e213c15a902`.

## Grafo y MCP

Graph Projector `v2.2.0` separa referencias, candidatas, contradicciones y coincidencias confirmadas. Tras `sync` y `verify`, PostgreSQL y Neo4j coincidieron en 5.951 nodos, 11.240 aristas y cero divergencias.

MCP v1 expone nueve herramientas STDIO de lectura con entradas acotadas. No ofrece SQL, shell, fetch, Cypher ni mutaciones. Una prueba levantó un proceso nuevo, enumeró la superficie permitida y respondió el estado integral de ADMISS, ZAC, la contradicción AJO Y LIMÓN, Mesa, delta y grafo desde PostgreSQL/Neo4j, sin consultar archivos manuales ni depender de la conversación.

## Verificación final

- reconstrucción completa desde cero: verde en 660,6 s;
- migraciones `0001`–`0107`: verde;
- pgTAP: 44 archivos, 935 pruebas;
- integrales B1–B4, concurrencia, typecheck, lint y build: verde;
- aceptación ADMISS, MCP en proceso nuevo, almacenamiento administrado y Graph Projector: verde;
- auditoría estructural de seguridad: sin violaciones;
- `npm audit`: cero vulnerabilidades.

Riesgos que permanecen: retención/archivo antes de una campaña real cercana a 150.000 referencias, respaldo del RAW local, prueba en staging real, definición futura de cualquier escritura MCP y sustitución del transformador TypeScript experimental si el projector se convierte en servicio continuo.
