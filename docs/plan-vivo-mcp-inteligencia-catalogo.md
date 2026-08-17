# Bellaroshé · Plan vivo de Inteligencia de Catálogo

**Versión:** 1.7 · Etapa 4B universal `0114` cerrada
**Última actualización:** 2026-08-17
**Fuente de verdad:** PostgreSQL/Supabase
**Estado:** Etapas 0–3, 4A y 4B completadas; 323 relaciones clasificadas en preview; contrato humano 4C en curso

Este documento dirige la construcción de la Inteligencia de Catálogo Bellaroshé. MCP es un adaptador de acceso; no es el sistema ni contiene lógica de negocio exclusiva.

## 1. Regla comercial invariable

La investigación puede observar, comparar, sugerir y preparar decisiones. Nunca puede convertir por sí sola una novedad oficial en un producto vendible Bellaroshé.

Un producto oficial suficientemente completo puede alcanzar `LISTO_PARA_DECISION_COMERCIAL`. Después una persona decide si Bellaroshé lo venderá y, solo entonces, define cantidad, precio Bellaroshé y publicación.

No se inventan stock, precio interno, identidad, variante, imagen, relación, compatibilidad ni estado fiscal.

## 2. Decisiones cerradas

- El sistema se llama **Inteligencia de Catálogo Bellaroshé**.
- MCP es una interfaz intercambiable sobre contratos de dominio.
- PostgreSQL/Supabase continúa como única fuente de verdad.
- Neo4j Community comienza en la Etapa 1.
- Neo4j es derivado, sincronizable y completamente reconstruible.
- El grafo representa conocimiento canónico y conocimiento en construcción, siempre separados semánticamente.
- Graph Projector se construye en Etapa 1; no habrá Cypher disperso en scripts de investigación.
- MCP v1 será local mediante STDIO.
- No se usa una API de IA. Codex investiga y orquesta con las herramientas disponibles.
- Las campañas de investigación se lanzan manualmente desde Codex; no hay CDC ni scheduler distribuido.
- Se priorizan niveles gratuitos: Supabase Free se conserva.
- Neo4j comienza local y, cuando haga falta continuidad, pasa a Community autohospedado en VPS.
- Evidencia RAW pesada no infla PostgreSQL ni Git: se conservan metadata, hash y referencia a almacenamiento local administrado.
- Next.js y Supabase no se migran ahora.
- Vercel Hobby no se considera hosting comercial definitivo; es un riesgo de despliegue que debe resolverse antes de producción comercial.
- Cloudflare y VPS no se construyen todavía. La aplicación solo preserva portabilidad mediante configuración y límites claros.
- No se implementa GraphRAG todavía.
- El sistema distingue **Universo de Referencia**, **Catálogo Bellaroshé** e **Inventario Bellaroshé**. Conocer, vender y tener existencias son estados distintos.
- Un producto externo conocido puede existir sin `products.id` ni `product_variants.id`; descubrirlo nunca crea una ficha comercial.
- La unidad de investigación es marca + fuente, no fila de Excel. El mismo staging y la misma reconciliación atienden lotes y universo; no habrá un segundo importador ni una segunda Mesa.
- El Universo de Referencia crece de forma relevante y justificable, no mediante crawling global indiscriminado.

## 3. Arquitectura aprobada

```text
Codex / Claude / futuro agente
              │
              ▼
        MCP local STDIO
              │
              ▼
Contratos de dominio Bellaroshé
              │
              ▼
 PostgreSQL / Supabase
 memoria · evidencia · decisiones · verdad
              │
              ├──────────► Catálogo · Revisar
              │
              ▼
       Graph Projector
              │
              ▼
      Neo4j Community
 conocimiento navegable, derivado y reconstruible
```

Ni MCP ni Neo4j reciben autoridad para saltarse los contratos. No se exponen herramientas genéricas como `run_cypher`, `write_node` o `write_relationship`.

### Tres dominios que nunca se mezclan

```text
UNIVERSO DE REFERENCIA          producto externo conocido con evidencia
          ↓ reconciliación
CATÁLOGO BELLAROSHÉ            decisión comercial; products/product_variants
          ↓ operación
INVENTARIO BELLAROSHÉ           cantidad física por variante y sede
```

El universo puede contener decenas o cientos de miles de identidades aunque Bellaroshé venda una fracción. El modelo no fija esos volúmenes como límites. Familias, plantillas, atributos y ejes siguen siendo datos genéricos para uñas, pestañas, maquillaje, piel, cabello, barbería, equipos, herramientas, consumibles, accesorios, repuestos y futuros rubros.

La identidad externa tendrá entidades explícitas de producto y variante de referencia, con nombres finales coherentes con el esquema. No se usará `products` como depósito de descubrimientos ni se aceptará una relación polimórfica improvisada para ocultar el hueco de integridad.

## 4. Ciclo permanente de investigación

```text
research_run
    ↓
fuentes
    ↓
delta
    ↓
observaciones
    ↓
reconciliación
    ↓
Mesa solo si hace falta
    ↓
hechos canónicos
    ↓
graph sync
    ↓
Neo4j crece
```

Cada ejecución conserva baseline, alcance, consultas, resultados, errores y huellas. Una segunda ejecución idéntica no duplica observaciones, candidatos, trabajos ni nodos.

Ante un lote nuevo, identidad contrasta primero contra el catálogo comercial y el Universo de Referencia. Una coincidencia exacta se reutiliza, una probable se valida y solo lo desconocido o contradictorio vuelve a investigación. Las filas se agrupan primero por marca, identificadores, familia y proveedor; nunca se compara el universo completo en memoria ni se investiga fila por fila.

La cadena `catalog_sources → catalog_source_snapshots → catalog_source_records` se conserva. `content_hash` evita snapshots repetidos. La autoridad se evalúa por dato: sitemap para descubrir, ficha para identidad/presentación, carta para tonos, ficha técnica para propiedades, manual para procesos y proveedor para oferta/costo/disponibilidad externa.

## 5. Separación semántica del grafo

### Capa canónica

Solo hechos aprobados o materializados: productos, variantes, marcas, categorías, tonos, proveedores, clases, sistemas, etapas, roles, membresías y relaciones aprobadas.

Cada nodo derivado conserva identificador PostgreSQL estable, por ejemplo `Product.pg_id`, más versión del projector y fingerprint de la proyección.

`Product` y `Variant` representan exclusivamente catálogo Bellaroshé. `ReferenceProduct` y `ReferenceVariant` representan identidad externa conocida y no implican adopción. `IdentityCandidate`, `IdentityContradiction` e `IdentityMatch` conservan la señal con su estado y evidencia antes de enlazar ambos dominios; el grafo nunca convierte esa señal en inventario o publicación.

### Capa de evidencia y conocimiento en construcción

Fuentes, snapshots, observaciones, conjuntos de evidencia, candidatos de producto/relación/sistema/etapa, contradicciones y estado de revisión.

Una candidata se representa como entidad de candidata enlazada a su evidencia; nunca reutiliza el mismo tipo de arista que una relación canónica. Toda consulta comercial filtra explícitamente la capa canónica.

### RAW pesado

Neo4j y PostgreSQL guardan referencia, tipo, tamaño, hash, fecha, URL y estado. El payload grande vive en almacenamiento local administrado y después podrá migrarse a almacenamiento de objetos sin cambiar contratos.

Eliminar Neo4j no pierde conocimiento: `graph rebuild` lo reconstruye desde PostgreSQL y las referencias aprobadas.

## 6. Roadmap

```text
ETAPA 0  Checkpoint reproducible
   ↓
ETAPA 1  Memoria + Universo de Referencia + Graph Projector + Neo4j Community
   ↓
ETAPA 2  ADMISS completo + grafo + MCP local
   ↓
ETAPA 3  Reprocesar Mesa + sincronización
   ↓
ETAPA 4  Conocimiento masivo
   ↓
ETAPA 5  Comando único + decisión comercial
```

Solo las dos primeras etapas funcionales se detallan ahora. Las demás conservan objetivo y criterio de frontera.

## 7. Etapa 0 · Checkpoint reproducible

No es una etapa funcional. Su objetivo es asegurar que el estado actual se puede preservar, reconstruir, probar y explicar antes de añadir Neo4j.

### Trabajo autorizado

1. revisar `git status` y separar cambios por responsabilidad;
2. asegurar migraciones `0001`–`0100`, pruebas, Mesa y documentación canónica;
3. excluir de Git volcados RAW, fuentes capturadas, derivados y binarios regenerables;
4. conservar un manifiesto de archivos locales con tamaño y SHA-256;
5. sustituir rutas absolutas por argumentos, variables de entorno o rutas relativas administradas;
6. ejecutar reconstrucción desde cero y gates actuales;
7. crear commits de checkpoint con límites comprensibles;
8. registrar resultados y detenerse.

### Criterio de salida

- árbol de trabajo limpio;
- migraciones `0001`–`0100` versionadas y aplicables desde cero;
- pruebas de la Mesa versionadas;
- documentación canónica y este plan versionados;
- evidencia pesada fuera de Git con manifiesto verificable;
- cero rutas absolutas obligatorias en el pipeline reutilizable;
- pgTAP, seguridad, typecheck, lint, enriquecimiento y reconstrucción requeridos en verde;
- commits y riesgos restantes registrados.

### Resultado

Etapa cerrada el 2026-08-12. El repositorio reconstruye desde cero las migraciones `0001`–`0100`, restaura el catálogo investigado, repone la semilla operativa y ejecuta todos los gates del checkpoint.

Commits del checkpoint:

| Commit | Responsabilidad |
| --- | --- |
| `9d59409` | procedencia, contratos, migraciones `0085`–`0100`, Mesa y pruebas |
| `abc1936` | autenticación, inventario y superficies administrativas |
| `01d80a6` | almacenamiento administrado, reconstrucción y pipeline reproducible |
| `c197dd3` | consolidación de la documentación canónica |

Evidencia de reconstrucción y calidad:

| Gate | Resultado |
| --- | --- |
| Reconstrucción completa `gate:rebuild` | dos ejecuciones consecutivas en verde: 456,9 s y 469,1 s |
| Migraciones + pgTAP | `0001`–`0100`; 42 archivos y 876 pruebas en verde |
| Restauración controlada | 1.056 productos, 1.578 variantes, 69 proveedores y 12.520 registros de fuente |
| Seguridad | 0 tablas sin RLS, baseline deliberado 31/31 y 16/16, 0 funciones inseguras, 0 secretos cliente |
| Enriquecimiento | 0 bloqueos; 323 candidatos de relación permanecen informativos |
| Búsqueda a escala | 100.007 productos, 201.578 variantes y 500.930 valores; peor caso 1.456 ms |
| Typecheck, lint y build | en verde dentro de ambas reconstrucciones |
| Backup/restore | dump completo restaurado en base limpia; 129 tablas y conteos críticos coincidentes |

Los RAW y derivados pesados permanecen fuera de Git. Un manifiesto versionado valida 41 archivos de investigación (24.559.298 bytes), el SQL de reconstrucción y el dump completo mediante tamaño y SHA-256. El árbol queda limpio al registrar este cierre. Etapa 1 no se inició.

## 8. Etapa 1 · Memoria + Universo de Referencia + Graph Projector + Neo4j Community

### Objetivo

Construir simultáneamente la memoria permanente de investigación, la identidad externa reutilizable y la fundación reproducible del grafo. Primero se audita el modelo existente y se agrega la estructura mínima con integridad explícita; no se crea un crawler global.

### Memoria

Cerrar contratos para:

- `research_run`, alcance y baseline;
- alcance de marca + fuente y estado persistente de cada fuente;
- estado de fuente: nueva, cambiada, caída o recuperada;
- identidad externa de producto y variante capaz de existir sin identidad interna;
- observaciones inmutables y procedencia sobre producto/variante interno, producto/variante de referencia, clase, sistema, etapa o relación;
- delta entre ejecuciones;
- precio externo histórico sobre producto o variante de referencia, separado de precio Bellaroshé;
- evidencia, candidato, contradicción y decisión;
- clasificación del trabajo: deuda automática, espera externa, captura física o excepción humana.

Solo la excepción humana compite por atención inmediata en la Mesa.

### Identidad de referencia

El modelo final adaptará los nombres al esquema, pero debe expresar como mínimo:

- producto y variante externos, identificadores por fuente, fingerprint, `first_seen`, `last_seen` y presencia/ausencia;
- estados persistentes e idempotentes equivalentes a descubierto, observado, coincidente interno, candidato nuevo, listo para decisión comercial, adoptado, rechazado, ausente de fuente, reaparecido, conflicto de identidad, necesita investigación y necesita captura física;
- transiciones validadas, sin convertir un estado de investigación en estado comercial;
- nivel `REFERENCE_LIGHT` para cobertura masiva: marca, nombre, códigos, familia/tipo, línea, presentación, eje básico, URL, source record, huellas, fechas, estado, precio opcional y referencias remotas de imagen;
- nivel `REFERENCE_ENRICHED` para artículos relevantes: atributos, tono, acabado, medios validados, manuales, fichas técnicas, procesos, sistemas, etapas, relaciones, compatibilidades y evidencia adicional;
- promoción a enriquecido cuando entra en un lote, se evalúa comercialmente, completa un sistema, aparece como novedad, presenta señales útiles o exige reconciliación.

`LISTO_PARA_DECISION_COMERCIAL` requiere identidad estable, marca, familia/tipo, producto vs. variante entendido, presentación, atributos esenciales, evidencia, ninguna contradicción bloqueante e imagen válida o deuda explícita. No requiere stock, precio Bellaroshé ni publicación.

Las imágenes ligeras pueden permanecer como URL + source record + hash si existe. Solo se descargan y normalizan cuando el producto entra en un lote, es candidato comercial, requiere validación o será publicado. Nunca se reutiliza la foto de otra variante.

### Neo4j

- instancia local de Neo4j Community;
- driver oficial y configuración mediante entorno;
- constraints e índices mínimos;
- módulo único `Graph Projector`;
- estado y métricas de cada proyección;
- `graph status`, `graph sync`, `graph verify` y `graph rebuild`, con nombres finales coherentes con el repositorio;
- proyección incremental y reconstrucción completa;
- validación de faltantes, huérfanos, duplicados, referencias inválidas y versión desactualizada.

Evaluar si `catalog_research_runs` puede registrar la proyección. Crear una tabla separada solo si el ciclo de vida realmente difiere. El registro mínimo conserva research run origen, projector version, inicio/fin, estado, conteos, errores, fingerprint y verificación.

### Primera proyección

Canónico:

- marcas, productos, variantes, categorías y tonos;
- sistemas, etapas, roles y clases;
- membresías aprobadas y relaciones canónicas.

Evidencia, si la separación queda demostrada:

- fuentes, productos/variantes de referencia, observaciones, conjuntos de evidencia y candidatas de relación;
- `ReferenceProduct -[:OBSERVED_AT]→ Source` y `ReferenceProduct -[:MATCHES]→ Product` cuando proceda;
- membresías de referencia en clases y etapas solo cuando la evidencia lo permita.

Las secuencias de proceso se expresan entre clases y mediante membresías. No se materializan combinaciones base × color × acabado ni otras explosiones de aristas.

### Consultas de validación

- productos sin clase, sistema o etapa;
- variantes sin tono cuando corresponde;
- marcas o productos sin fuente/evidencia;
- observaciones incompatibles y atributos contradictorios;
- productos por sistema/etapa/rol;
- etapas sin cobertura comercial;
- alternativas y productos que cubrirían un hueco.
- productos oficiales de una marca que Bellaroshé no trabaja;
- referencias que coinciden con una fila de proveedor o ya estaban conocidas;
- novedades desde la última corrida, contradicciones y referencias ausentes durante meses;
- referencias que completarían un sistema parcialmente vendido.

### Métricas y escala

Cada `research_run` reporta referencias conocidas, nuevas, cambiadas, coincidentes internas, no coincidentes, listas para decisión, ligeras y enriquecidas; además marcas con cobertura, marcas sin fuente y ratio de cobertura. Cada lote reporta `match_internal`, `match_reference`, `new_reference`, `needs_research` y `needs_physical_capture`.

La resolución ocurre en PostgreSQL mediante identificadores, fingerprints, normalización, índices, candidatos acotados y paginación. No se carga el universo completo en Node, no hay N+1 y la similitud textual no es el primer identificador. El gate existente de 100.000 productos y más de 200.000 variantes se conserva y se amplía con volumen de referencia sintético antes de escalar fuentes.

### Criterio de salida

Desde una base reconstruida:

```text
PostgreSQL → graph rebuild → Neo4j → graph verify
```

`graph verify` queda en cero diferencias esperadas. Repetir `rebuild` o `sync` no crea duplicados. MCP permanece fuera de esta etapa y se construirá en la Etapa 2 sobre estos contratos ya probados.

### Resultado de Etapa 1

Etapa cerrada el 2026-08-12, sin investigar ADMISS ni crear funcionalidad de la Etapa 2.

La [auditoría específica](etapa-1-auditoria-modelo.md) confirmó que fuentes, snapshots, registros, evidencia, procedencia, reconciliación, sistemas, etapas, roles, clases y relaciones eran reutilizables. Se añadieron únicamente identidad externa tipada, corridas/deltas, precios y medios externos, contratos de proyección y resolución del staging contra referencia.

| Entrega | Resultado comprobado |
| --- | --- |
| Memoria | `baseline`, `delta` y `targeted`; corrida anterior, actor, marca + fuente/scope, estado, huellas, métricas, errores y resultado idempotente |
| Universo de Referencia | producto y variante externos sin FK comercial; identificadores, estados, presencia, `REFERENCE_LIGHT`/`REFERENCE_ENRICHED`, precio y medio remoto |
| Observaciones | sujetos internos y externos con FKs explícitas; evidencia compatible y contradictoria permanece separada de hechos canónicos |
| Staging | la misma `import_rows` resuelve catálogo + referencia; no existe un segundo importador ni creación comercial automática |
| Graph Projector | versión `v2.1.0`; `status`, `sync`, `verify` y `rebuild`; cursor PostgreSQL y lotes; constraints e índices Neo4j; sin Cypher libre |
| Reconstrucción final | 3.656 nodos y 6.413 aristas; fingerprint PostgreSQL/Neo4j idéntico; cero faltantes, duplicados, huérfanos, referencias inválidas o versiones obsoletas |
| Divergencia | la prueba elimina deliberadamente un nodo y sus aristas; `verify` los detecta y `sync` restaura exactamente el fingerprint |
| Suite completa | migraciones `0001`–`0106`, 43 archivos y 916 pruebas pgTAP; reconstrucción total final en 457,1 s; integrales, concurrencia, typecheck, lint y build en verde |
| Seguridad | cero tablas sin RLS, baseline deliberado 31/31 y 16/16, cero funciones inseguras, cero secretos cliente y `npm audit` con cero vulnerabilidades |

La escala se comprobó como dos magnitudes independientes, no contra los 1.056 productos del corte real:

| Medición real sintética | Resultado |
| --- | --- |
| Catálogo comercial | 100.000 productos, 201.578 variantes en la medición de búsqueda |
| Universo adicional | 150.000 productos de referencia, 150.000 variantes, 150.000 observaciones y 150.000 eventos de presencia |
| Identificador exacto | 0,297 ms, índice de resolución utilizado |
| Similitud final acotada por marca | 151,932 ms, índice GiST KNN utilizado; nunca es el primer paso |
| Observación por sujeto / delta por estado | 0,279 ms / 0,224 ms, ambos indexados |
| Contrato completo de grafo | 903.658 nodos y 1.606.414 aristas recorridos en 51,492 s; crecimiento RSS de Node 59,3 MB |
| Búsqueda comercial | peor caso 1.440 ms, bajo el límite de 3.000 ms, con planes y significado comprobados |

La medición también reveló deuda real: esas 150.000 referencias ocuparon aproximadamente 678 MB entre las seis relaciones principales e índices. `REFERENCE_LIGHT`, deduplicación por hash y RAW fuera de PostgreSQL son obligatorios; antes de una campaña real equivalente se debe definir retención/archivo de eventos y observaciones y volver a medir el límite efectivo de Supabase. Esto no cambia el modelo ni fija 150.000 como techo.

## 9. Etapa 2 · ADMISS completo + MCP local

### Objetivo

ADMISS demuestra memoria, Universo de Referencia, reconciliación, grafo y decisión comercial sin hardcodear ZAC ni AJO Y LIMÓN. La investigación cubre la marca + fuente completa: las referencias oficiales no trabajadas quedan como conocimiento externo, no como productos vendibles.

La ejecución guarda en PostgreSQL fuentes, snapshots, registros, observaciones, precios externos, imágenes, candidatos y contradicciones. Después ejecuta reconciliación y `graph sync`.

### Casos obligatorios

- ZAC aparece como candidato/evidencia con SKU observado `314094`, nunca como producto vendible automático.
- AJO Y LIMÓN muestra la contradicción entre el tono/variante interno y la base fortalecedora oficial.
- Un producto suficientemente completo puede alcanzar `LISTO_PARA_DECISION_COMERCIAL` sin precio, stock ni publicación Bellaroshé.
- La segunda ejecución sin cambios produce cero duplicados en PostgreSQL y Neo4j, cero decisiones reabiertas y cero candidatos artificiales.
- El reporte separa productos oficiales conocidos, productos que Bellaroshé trabaja, coincidencias, oficiales no trabajados, novedades, candidatos comerciales y conflictos.
- Una fuente oficial con 130 productos y un catálogo Bellaroshé con 80 conserva las 130 referencias ligeras y solo profundiza lo relevante.

### MCP v1

Local STDIO y sin lógica exclusiva. La primera versión terminada es deliberadamente de solo lectura: expone consultas de dominio con parámetros acotados y el estado fijo del grafo. No expone SQL, shell, HTTP, Cypher ni mutaciones comerciales. Las campañas siguen entrando por el comando manual probado hasta cerrar un contrato de escritura específico.

Codex investiga, razona y orquesta. MCP consulta e invoca. PostgreSQL recuerda y gobierna. Neo4j conecta y expone huecos.

### Resultado de Etapa 2

Etapa cerrada el 2026-08-12. La campaña partió de la raíz oficial registrada, descubrió sus superficies y conservó 121 productos y 121 variantes ADMISS, 121 precios externos y 197 referencias remotas de imagen. Se enriquecieron 61 referencias justificadas y 60 permanecieron ligeras. No se creó ni modificó ninguna ficha, variante, precio, existencia o medio comercial.

La repetición sin cambios reutilizó el snapshot material: 242 identidades `unchanged`, cero altas/cambios/ausencias y cero duplicados en observaciones, precios, medios, casos, Mesa o grafo. La huella material fue `fe2eaacae33eb94b58a188ffa723732c703ea3c0b66e51beb7c76e213c15a902`; los timestamps volátiles de Shopify se preservan como captura, pero no falsean el delta.

| Entrega | Resultado comprobado |
| --- | --- |
| Cobertura oficial | 121 productos, 121 variantes, 726 identificadores, 1.134 observaciones, 121 precios y 197 medios remotos |
| Reconciliación | 112 candidatas, 1 contradicción estructural, 8 referencias sin candidata y 113 casos pendientes de decisión humana |
| ZAC | SKU oficial `314094` descubierto como referencia y candidata de `Esmalte ADMISS` (`ADM-ESM-CA6EEA`); sin alta comercial |
| AJO Y LIMÓN | `BASES` en la fuente oficial frente a `Esmaltes` internamente; caso `needs_review` con evidencia explícita |
| Grafo | Graph Projector `v2.2.0`; 5.951 nodos, 11.240 aristas, fingerprints iguales y cero divergencias |
| MCP local | 9 herramientas de lectura de dominio; proceso STDIO nuevo respondió ADMISS desde PostgreSQL y estado Neo4j sin leer archivos manuales ni memoria de conversación |
| Reconstrucción | migraciones `0001`–`0107`, 44 archivos y 935 pruebas pgTAP; gate total en verde en 660,6 s |
| Seguridad | auditoría estructural sin violaciones y `npm audit` con cero vulnerabilidades |

El informe de cierre y la evidencia de aceptación están en [Etapa 2 · ADMISS y MCP](etapa-2-admiss-mcp.md).

## 10. Etapas 3–5

### Etapa 3 · Reprocesar Mesa

Reprocesar el trabajo actual con la nueva evidencia, preservar decisiones históricas y sincronizar cada cambio relevante. Una evidencia contradictoria crea nuevo trabajo; no borra la decisión anterior ni convierte afirmaciones incompatibles en hechos simultáneos.

Etapa cerrada el 2026-08-12. El motor genérico toma un snapshot, genera un preview inmutable y solo aplica su fingerprint exacto. Reutiliza la Mesa, sus versiones, eventos, dependencias e idempotencia; no existe una segunda cola. Clasifica cada trabajo como `human_exception`, `automatic_debt`, `physical_capture` o `waiting_external`, audita los terminados sin editarlos y crea trabajo enlazado si aparece una contradicción posterior.

| Métrica | Antes | Después | Cambio |
| --- | ---: | ---: | ---: |
| Trabajo total | 1.679 | 1.679 | 0 |
| Activo | 1.629 | 1.447 | -182 |
| Accionable por una persona | 623 | 387 | -236 (-37,9 %) |
| Porcentaje humano sobre activo | 38,24 % | 26,74 % | -11,50 pp |
| Deuda automática | 0 | 436 | +436 |
| Captura física | 527 | 527 | 0 |
| Espera externa | 296 | 66 | -230 |
| Bloqueado | 183 | 31 | -152 |
| Completado | 49 | 231 | +182 |
| Superseded | 1 | 1 | 0 |
| Desbloqueado en apply | — | 94 | +94 |
| Nuevo por evidencia / contradicción histórica real | — | 0 / 0 | sin invención |

El preview canónico `52b0ae6d-60e5-4b51-8e09-23bacd9b416b` congeló la Mesa con snapshot `6aa0c10e86830a28980615a0273282c0e94ca39ca36b621242c4e155c7c79495` y huella de acciones `51fe0a32c2802d52045792dfbf40f1641206bded9768536781a03ad72c0ef65e`. Aplicó 182 identidades objetivas (161 tonos y 21 productos), reclasificó 112 señales externas y 324 relaciones diferidas, auditó 50 terminados y no produjo efectos comerciales.

La repetición conservó el fingerprint lógico `b46f4cd63a653adcbff6a025001990ac64d4d853724879783d725046d9ea217e`: cero cambios, eventos, dependencias, reaperturas o trabajo nuevo. ADMISS quedó con 112 señales como deuda automática y una sola contradicción humana. Las 323 relaciones históricas no fueron reconciliadas; la distribución técnica muestra 324 por el fixture sintético controlado de Etapa 1.

Graph Projector `v2.3.0` proyecta además la capa `workflow`: 7.630 nodos, 11.423 aristas, fingerprints PostgreSQL/Neo4j iguales y cero divergencias. MCP continúa de solo lectura y añade `review_reprocess_status`. Evidencia completa en [Etapa 3 · Reprocesamiento de la Mesa](etapa-3-reprocesamiento-mesa.md). Etapa 4 no fue iniciada.

### Checkpoint obligatorio previo a Etapa 4 · Cobertura ADMISS

Auditoría cerrada el 2026-08-12 sin iniciar expansión de marcas ni procesar las 324 relaciones diferidas. Las 1.134 observaciones originales fueron auditadas expresamente: solo cubrían ocho predicados de identidad, SKU, tipo, línea, presentación, tono, acabado e imagen. El RAW oficial sí contenía descripción, tags y pertenencia a colecciones, por lo que se implementó un normalizador genérico, sin reglas ADMISS, para doce dimensiones:

`tipo → subtipo → concern → beneficio declarado → ingrediente → uso → rol → etapa → sistema → formulación → acabado → relaciones`.

La corrida conserva 1.587 claims activos sobre 121 productos, cada uno con excerpt acotado, fingerprint, fuente, referencia RAW, método, confianza y estado. `catalog_semantic_terms` es vocabulario de fuente, no verdad técnica; las afirmaciones de fabricante mantienen `claimStatus=source_claim` y `isCanonicalTechnicalFact=false`. Neo4j solo añade `SemanticTerm` y `NORMALIZES_TO` en capa `evidence`.

| Resultado | Medición |
| --- | ---: |
| Tipo / subtipo | 100 % / 100 % |
| Concern / beneficio | 5,79 % / 97,52 % |
| Ingrediente / uso | 2,48 % / 14,05 % |
| Rol / etapa / sistema | 100 % / 100 % / 100 % |
| Formulación / acabado / relación | 99,17 % / 90,08 % / 99,17 % |
| Colección–tipo contradictoria | 6 productos, 9 memberships |
| Repetición | 1.587 claims, 0 duplicados, 0 superseded |
| Mesa creada / efectos comerciales | 0 / 0 |
| Grafo verificado | 9.562 nodos, 18.256 aristas, 0 divergencias |

La matriz completa, consultas, gaps y evidencia reproducible están en [Auditoría ADMISS](../research/catalog-master/reports/admiss-semantic-audit/README.md). Este checkpoint no se autoautorizó; tras cerrar también las guardas `0110`–`0112`, la autorización humana para Etapa 4 se registró el 2026-08-17.

### Checkpoint obligatorio previo a Etapa 4 · Escala humana semántica

La ampliación semántica ya tiene una barrera estructural contra la multiplicación de trabajo humano. Cada detección pertenece a un grupo por `rule_code`, tipo técnico, dimensión o causa raíz; una partición adicional exige justificar por qué un único problema de regla + conjunto afectado no basta. `UNKNOWN`, `NOT_STATED`, `DERIVED` e incertidumbre no crean Mesa automáticamente. Solo una ambigüedad que bloquea una decisión y exige criterio humano puede producir un expediente, siempre con sujeto `rule` y nunca por producto.

El reporte de campaña conserva el embudo `productos → claims → problemas → grupos → reglas → excepciones humanas`. El gate sintético procesó 10.000 productos y 10.001 problemas de una regla en 22,9 s sobre el Universo restaurado: un grupo, una excepción humana activa, cero trabajos por producto, 0,1 excepciones por 1.000 productos, ratio de crecimiento 0,0222 (`passes`) y 99,99 % de revisión individual evitada. PostgreSQL pasó 1.152 pruebas; Graph Projector `v2.6.0` quedó sin drift. Evidencia completa en [Guarda de escala humana semántica](etapa-4-guarda-escala-humana-semantica.md).

### Etapa 4 · Conocimiento masivo

**Estado:** autorizada el 2026-08-17. El corte 4A quedó implementado y certificado en `0113`; no inició investigación masiva ni reprocesamiento histórico.

Ampliar el Universo de Referencia relevante y los sistemas, etapas, clases, roles, procesos, requisitos, compatibilidades, incompatibilidades, alternativas y secuencias. Preferir relaciones entre clases y membresías de producto para evitar explosión producto-producto. No descargar indiscriminadamente todo Internet ni empezar con cien marcas antes de validar ADMISS.

#### Etapa 4A · Modelo universal de sistemas y clases

`0113` reutiliza el modelo 0086 y completa sistema→etapa→rol→clase→requisito/capacidad→producto o referencia. Los vocabularios de rol, requisito y nueve relaciones son datos extensibles. Pertenencia y función nunca generan compatibilidad: una relación estricta exige evidencia explícita del par y claim de dimensión `compatibility`.

El fixture real Acrílico valida 8 etapas, 15 roles, 16 clases, 16 puentes rol–clase, 8 requisitos, 8 secuencias, 45 productos internos y 2 referencias oficiales no comerciales. La cadena conserva 4 observaciones literales, 4 claims normalizados, 4 inferencias y 0 hechos canónicos; tres requisitos y una transición quedan pendientes de evidencia.

El gate reconstruyó 5.290 nodos y 7.545 aristas con Graph Projector `v2.7.0`, fingerprints iguales y cero divergencias. PostgreSQL pasó 50 archivos y 1.186 pruebas, seguridad/typecheck/lint, certificación 0111 y MCP 4A. Las 323 relaciones reales permanecen `untouched`, `analyzedThisCut=0`; su clasificación controlada es el siguiente corte. Evidencia completa en [Etapa 4A · Modelo universal de sistemas y clases](etapa-4a-modelo-universal-sistemas-clases.md).

#### Etapa 4B · Reprocesamiento universal de relaciones

`0114` implementa `snapshot → clasificación → preview inmutable → fingerprint → apply exacto` sobre las 323 candidatas reales. Quince perfiles de extremos y trece reglas compartidas recorren sujetos, membresías, clases, contexto, claims, autoridad, tipo de relación 0113 y resultado epistemológico; no hay decisiones manuales por fila.

El primer preview produjo 99 `CLASS_MEMBERSHIP`, 68 `CLASS_RELATION`, 60 `NEEDS_EVIDENCE` y 96 `REJECTED`. Los 68 pares de relación se comprimen en 9 firmas de clase y se proponen 88 membresías distintas. No se certificó ningún par producto–producto porque la cohorte no conserva evidencia explícita suficiente; eso no equivale a negar su existencia futura.

El corte permanece en preview: 323 candidatas aún diferidas, 0 canonizaciones, 0 trabajos humanos por candidata y 0 efectos comerciales. PostgreSQL pasó 51 archivos/1.216 pruebas; seguridad, tipos, lint, MCP 4B y Graph Projector `v2.7.0` pasaron sin drift. Evidencia completa en [Etapa 4B · Reprocesamiento universal de relaciones](etapa-4b-reprocesamiento-universal-relaciones.md).

### Etapa 5 · Comando único

Una campaña manual desde Codex investiga desde la última ejecución, reaudita, conserva historia, deja solo excepciones reales, sincroniza el grafo y presenta productos nuevos listos para decisión comercial humana.

GraphRAG, automatización continua, Cloudflare, VPS y transporte MCP remoto permanecen fuera de alcance hasta que una necesidad real los justifique.

## 11. Infraestructura y portabilidad

| Pieza | Ahora | Futuro permitido |
| --- | --- | --- |
| Aplicación | Next.js actual | mantener portable; no migrar ahora |
| Verdad y operación | Supabase Free | escalar solo por límites medidos |
| Grafo | Neo4j Community local | Community autohospedado en VPS |
| MCP | STDIO local | remoto/OAuth solo si aparece necesidad |
| Investigación | campañas manuales desde Codex | scheduler posterior, no CDC por defecto |
| RAW | almacenamiento local administrado | object storage compatible |
| Frontend hosting | entorno actual de desarrollo | plan comercial explícito antes de producción |

La configuración usa variables de entorno y rutas relativas. Ningún contrato depende de un proveedor de hosting específico.

## 12. Riesgos activos

| ID | Riesgo | Mitigación |
| --- | --- | --- |
| IC-01 | Candidatos confundidos con hechos en Neo4j | separación de labels/aristas, estado obligatorio y consultas canónicas explícitas |
| IC-02 | Dos fuentes de verdad | IDs PostgreSQL, Graph Projector único, rebuild/verify y cero escrituras libres |
| IC-03 | Drift entre PostgreSQL y Neo4j | fingerprint, projector version, sync manual posterior a research run y verificación |
| IC-04 | RAW pesado infla Git/PostgreSQL/grafo | almacenamiento local administrado, manifiesto, hash y referencia |
| IC-05 | Neo4j añade operación antes de aportar valor | Community local, sin CDC/GraphRAG y criterio de salida medible |
| IC-06 | VPS/Cloudflare prematuros distraen del conocimiento | preservar portabilidad sin desplegarlos todavía |
| IC-07 | Vercel Hobby se asume como hosting comercial | bloquear decisión de producción hasta elegir un plan permitido y sostenible |
| IC-08 | Supabase Free o VPS futuro alcanzan límites | medición de 150.000 referencias consumió ~678 MB en seis relaciones principales; definir retención/archivo y medir el límite efectivo antes de carga real equivalente |
| IC-09 | Evidencia local se pierde fuera de Git | manifiesto SHA-256, backup administrado y verificador local |
| IC-10 | API de IA introduce costo o dependencia | no usarla; campañas manuales con Codex |
| IC-11 | Referencias externas se convierten accidentalmente en productos vendibles | entidades y estados separados; adopción solo por contrato comercial humano |
| IC-12 | Universo grande agota Supabase Free | `REFERENCE_LIGHT`, RAW/medios por referencia, hashes, deduplicación, paginación y medición de volumen |
| IC-13 | Observaciones externas pierden integridad por polimorfismo improvisado | sujetos explícitos y constraints; auditar antes de elegir el esquema mínimo |
| IC-14 | Reconciliación escala como lote × universo en memoria | resolución indexada en PostgreSQL, fingerprints e identificadores antes de similitud |
| IC-15 | Precios, stock o imágenes externos contaminan datos Bellaroshé | modelos separados, procedencia obligatoria y medios diferidos por variante |
| IC-16 | CLI del projector depende del transformador TypeScript experimental de Node | funciona y está probado localmente; empaquetar/compilar el CLI con una ruta estable antes de convertirlo en servicio continuo |
| IC-17 | Una regla automática obsoleta cierra incertidumbre que ya no es objetiva | reglas versionadas, preview exacto, evidencia/fingerprint, fixtures de contradicción y toda afirmación comercial o compatibilidad fuera de autoaprobación |

Los riesgos generales de la plataforma permanecen en [Calidad y riesgos](calidad-y-riesgos.md).

## 13. Checklist vivo

### Decisiones y diseño

- [x] Arquitectura general aprobada.
- [x] PostgreSQL confirmado como única fuente de verdad.
- [x] Neo4j adelantado a Etapa 1.
- [x] Capa canónica separada de evidencia/candidatos.
- [x] Graph Projector definido como frontera única.
- [x] MCP v1 local STDIO.
- [x] Sin API de IA, CDC ni GraphRAG.
- [x] Infraestructura gratuita y portable priorizada.
- [x] Decisión comercial humana separada del descubrimiento.
- [x] Universo de Referencia separado de Catálogo e Inventario Bellaroshé.
- [x] Identidad externa puede existir sin `products`/`product_variants`.
- [x] Marca + fuente confirmada como unidad de investigación.
- [x] Un solo staging, reconciliación e interfaz de Mesa.

### Etapa 0

- [x] Auditar los Markdown y dejar documentación canónica.
- [x] Inventariar el árbol de Git y clasificar cambios por responsabilidad.
- [x] Versionar migraciones `0085`–`0100` y sus pruebas.
- [x] Versionar Mesa, contratos y superficies administrativas.
- [x] Excluir RAW/derivados y generar manifiesto verificable.
- [x] Retirar rutas absolutas obligatorias del pipeline.
- [x] Ejecutar reconstrucción completa desde cero.
- [x] Ejecutar pgTAP, seguridad, typecheck, lint y gates de enriquecimiento.
- [x] Crear commits del checkpoint.
- [x] Confirmar árbol limpio.
- [x] Reportar cierre y detenerse.

### Etapa 1

- [x] Cerrar memoria de investigación y deltas.
- [x] Auditar `catalog_observations` y diseñar sujetos con integridad explícita.
- [x] Implementar producto/variante de referencia sin identidad comercial falsa.
- [x] Implementar estados idempotentes, `REFERENCE_LIGHT` y `REFERENCE_ENRICHED`.
- [x] Implementar precios externos históricos y referencias remotas de medios.
- [x] Integrar lote → catálogo + referencia en la reconciliación existente.
- [x] Preparar Neo4j Community local.
- [x] Implementar Graph Projector.
- [x] Implementar status/sync/verify/rebuild.
- [x] Proyectar conocimiento aprobado y evidencia separada.
- [x] Demostrar rebuild, sync y verify idempotentes y reparadores.
- [x] Conservar/ampliar el gate sintético de 100.000 productos y 200.000+ variantes.
- [x] Medir 150.000 referencias adicionales sin lote × universo en memoria.
- [x] Ejecutar reconstrucción, pgTAP, seguridad, enriquecimiento, búsqueda, escala, tipos, lint, build y pruebas Neo4j.

### Etapa 2

- [x] Ejecutar ADMISS extremo a extremo.
- [x] Demostrar ZAC y AJO Y LIMÓN con reglas genéricas.
- [x] Preparar decisión humana sin publicación automática.
- [x] Construir MCP local STDIO sobre contratos probados.
- [x] Demostrar idempotencia PostgreSQL + Neo4j.
- [x] Reportar oficiales conocidos, trabajados, coincidentes, no trabajados, novedades, candidatos y conflictos.

### Etapa 3

- [x] Tomar snapshot y fingerprint antes de modificar la Mesa.
- [x] Implementar preview inmutable y apply de huella exacta.
- [x] Clasificar deuda automática, espera externa, captura física y excepción humana.
- [x] Reprocesar todas las clases y recomputar dependencias en el mismo apply.
- [x] Preservar decisiones terminadas y enlazar contradicciones posteriores como trabajo nuevo.
- [x] Tratar 112 señales ADMISS con reglas genéricas y conservar la contradicción humana.
- [x] Demostrar fixtures de captura, espera, bloqueo, contradicción histórica e imagen faltante.
- [x] Demostrar reejecución sin cambios, eventos, duplicados ni drift del grafo.
- [x] Proyectar la Mesa en Neo4j y exponer su estado por MCP de solo lectura.
- [x] Ejecutar reconstrucción 0001–0108, 968 pgTAP, seguridad, enriquecimiento, integrales, concurrencia, tipos, lint y build.

### Etapas 4–5

- [x] Auditar las 1.134 observaciones ADMISS antes de expandir conocimiento.
- [x] Estructurar doce dimensiones con normalizador genérico y procedencia.
- [x] Mantener claims de fabricante separados de hechos técnicos canónicos.
- [x] Demostrar consultas ADMISS, matriz de 121 productos e idempotencia.
- [x] Sincronizar/verificar Neo4j sin crear trabajo en Mesa ni efectos comerciales.
- [x] Agrupar problemas semánticos por regla/causa y prohibir escalación por producto.
- [x] Exigir bloqueo real + criterio humano antes de crear una excepción.
- [x] Reportar productos → claims → problemas → grupos → reglas → excepciones.
- [x] Demostrar 10.000 productos y 10.001 problemas con una sola excepción activa.
- [x] Separar observación literal, claim normalizado, inferencia y hecho canónico.
- [x] Dirigir dimensiones, perfiles, reglas y autoridad fuente×predicado mediante datos.
- [x] Certificar contradicción, entailment, ausencias y promoción con diez arquetipos sintéticos.
- [x] Materializar los claims semánticos reales de 0109 en la cadena epistemológica universal.
- [x] Autorizar explícitamente el inicio de Etapa 4.
- [x] Implementar el contrato universal sistema→etapa→rol→clase→requisito.
- [x] Validar productos y referencias con el vertical real Acrílico sin efectos comerciales.
- [x] Mantener pertenencia/función separadas de compatibilidad y preservar la cadena epistemológica.
- [x] Publicar reporte/gate/MCP 4A y proyectar Graph Projector `v2.7.0` sin drift.
- [x] Reprocesar controladamente las 323 relaciones históricas y medir cuántas suben a clases.
- [ ] Obtener casos reales de al menos tres tipos de problema humano antes de diseñar frontend.
- [ ] Escalar conocimiento a otros sistemas y marcas después del gate del reprocesamiento.
- [ ] Implementar comando único y reporte comercial.

## 14. Registro de actualizaciones

| Fecha | Cambio | Resultado |
| --- | --- | --- |
| 2026-08-12 | Auditoría inicial | Punto de partida técnico medido |
| 2026-08-12 | Higiene documental | 44 Markdown reducidos a 16 documentos con propósito explícito |
| 2026-08-12 | Arquitectura aprobada | Neo4j y Graph Projector pasan a Etapa 1; MCP queda como adaptador |
| 2026-08-12 | Etapa 0 iniciada | Checkpoint reproducible en ejecución; Etapa 1 bloqueada hasta reporte |
| 2026-08-12 | Universo de Referencia aprobado | Etapa 1 absorbe identidad externa, niveles light/enriched, observaciones externas, precios y escala; ADMISS lo valida en Etapa 2 |
| 2026-08-12 | Etapa 0 cerrada | Reconstrucción repetible, gates, backup verificado, documentación y commits completos; Etapa 1 lista sin iniciar |
| 2026-08-12 | Etapa 1 cerrada | Memoria, referencia externa, staging integrado, Graph Projector y Neo4j Community probados con volumen independiente; ADMISS y MCP permanecen en Etapa 2 |
| 2026-08-12 | Etapa 2 cerrada | ADMISS completo, delta idempotente, identidad contradictoria separada, Graph Projector `v2.2.0` y MCP STDIO de lectura probados; Etapa 3 permanece sin iniciar |
| 2026-08-12 | Etapa 3 cerrada | Preview/apply congelado, 618 cambios justificados, trabajo humano de 623 a 387, rerun nulo, Graph Projector `v2.3.0`, 968 pgTAP y reconstrucción completa; Etapa 4 permanece sin iniciar |
| 2026-08-12 | Auditoría ADMISS previa a Etapa 4 | 1.134 observaciones auditadas, 1.587 claims tipados con procedencia, matriz de 121 productos, consultas exigidas, Graph Projector `v2.4.0` sin drift y cero impacto en Mesa/comercial; Etapa 4 permanece detenida |
| 2026-08-12 | Guarda de escala humana previa a Etapa 4 | Agrupación por regla, particiones justificadas, embudo obligatorio y gate de 10.000 productos/10.001 problemas con una excepción activa; Etapa 4 permanece detenida |
| 2026-08-12 | Checkpoint Semántico Universal | Cuatro clases epistémicas, 22 dimensiones extensibles, perfiles heredables, ocho familias de reglas, autoridad fuente×predicado, entailment, contradicción explícita, promoción canónica, diez arquetipos y golden set; Graph Projector `v2.6.0`; Etapa 4 no autorizada |
| 2026-08-12 | Ingesta universal cerrada | 1.587 observaciones literales + 1.587 claims ADMISS normalizados con entailment, 72 reglas `NORMALIZATION` activas, cero canonizaciones y cero Mesa; todo enlace futuro entra por trigger fail-closed |
| 2026-08-17 | Etapa 4 autorizada | Autorización humana expresa para iniciar por sistemas y clases bajo `0110`–`0112`; no habilita publicación, canonización automática, expansión indiscriminada ni producción |
| 2026-08-17 | Etapa 4A cerrada | Contrato universal `0113`, fixture Acrílico, 8 requisitos/8 secuencias, referencias no comerciales, 0 canonizaciones, 323 relaciones intactas, 1.186 pgTAP y Graph Projector `v2.7.0` sin drift |
| 2026-08-17 | Etapa 4B cerrada | Motor universal `0114`, preview/fingerprint de 323 relaciones, 167 pares expresables por clases, 68 pares condensados en 9 reglas, 0 canonizaciones, 1.216 pgTAP y MCP/grafo sin drift |
