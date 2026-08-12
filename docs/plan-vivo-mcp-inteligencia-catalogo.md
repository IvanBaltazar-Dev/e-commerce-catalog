# Bellaroshé · Plan vivo de Inteligencia de Catálogo

**Versión:** 1.1 · checkpoint de Etapa 0 cerrado
**Última actualización:** 2026-08-12
**Fuente de verdad:** PostgreSQL/Supabase
**Estado:** Etapa 0 completada; Etapa 1 lista y no iniciada

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

`Product` y `Variant` representan exclusivamente catálogo Bellaroshé. `ReferenceProduct` y `ReferenceVariant` representan identidad externa conocida y no implican adopción. Una relación `MATCHES` enlaza ambos dominios cuando la reconciliación lo justifica; el grafo nunca convierte esa coincidencia en inventario o publicación.

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

`graph verify` queda en cero diferencias esperadas. Repetir `rebuild` o `sync` no crea duplicados. MCP todavía puede limitarse a lectura al final de esta etapa.

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

Local STDIO y sin lógica exclusiva. Expone los mismos contratos que usan scripts y aplicación: prepara, consulta estado, registra observaciones, reconcilia, finaliza y sincroniza grafo mediante comandos estrechos.

Codex investiga, razona y orquesta. MCP consulta e invoca. PostgreSQL recuerda y gobierna. Neo4j conecta y expone huecos.

## 10. Etapas 3–5

### Etapa 3 · Reprocesar Mesa

Reprocesar el trabajo actual con la nueva evidencia, preservar decisiones históricas y sincronizar cada cambio relevante. Una evidencia contradictoria crea nuevo trabajo; no borra la decisión anterior ni convierte afirmaciones incompatibles en hechos simultáneos.

### Etapa 4 · Conocimiento masivo

Ampliar el Universo de Referencia relevante y los sistemas, etapas, clases, roles, procesos, requisitos, compatibilidades, incompatibilidades, alternativas y secuencias. Preferir relaciones entre clases y membresías de producto para evitar explosión producto-producto. No descargar indiscriminadamente todo Internet ni empezar con cien marcas antes de validar ADMISS.

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
| IC-08 | Supabase Free o VPS futuro alcanzan límites | medir primero y agotar nivel gratuito antes de ampliar gasto |
| IC-09 | Evidencia local se pierde fuera de Git | manifiesto SHA-256, backup administrado y verificador local |
| IC-10 | API de IA introduce costo o dependencia | no usarla; campañas manuales con Codex |
| IC-11 | Referencias externas se convierten accidentalmente en productos vendibles | entidades y estados separados; adopción solo por contrato comercial humano |
| IC-12 | Universo grande agota Supabase Free | `REFERENCE_LIGHT`, RAW/medios por referencia, hashes, deduplicación, paginación y medición de volumen |
| IC-13 | Observaciones externas pierden integridad por polimorfismo improvisado | sujetos explícitos y constraints; auditar antes de elegir el esquema mínimo |
| IC-14 | Reconciliación escala como lote × universo en memoria | resolución indexada en PostgreSQL, fingerprints e identificadores antes de similitud |
| IC-15 | Precios, stock o imágenes externos contaminan datos Bellaroshé | modelos separados, procedencia obligatoria y medios diferidos por variante |

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

- [ ] Cerrar memoria de investigación y deltas.
- [ ] Auditar `catalog_observations` y diseñar sujetos con integridad explícita.
- [ ] Implementar producto/variante de referencia sin identidad comercial falsa.
- [ ] Implementar estados idempotentes, `REFERENCE_LIGHT` y `REFERENCE_ENRICHED`.
- [ ] Implementar precios externos históricos y referencias remotas de medios.
- [ ] Integrar lote → catálogo + referencia en la reconciliación existente.
- [ ] Preparar Neo4j Community local.
- [ ] Implementar Graph Projector.
- [ ] Implementar status/sync/verify/rebuild.
- [ ] Proyectar conocimiento aprobado y evidencia separada.
- [ ] Demostrar rebuild y verify idempotentes.
- [ ] Conservar/ampliar el gate sintético de 100.000 productos y 200.000+ variantes.

### Etapa 2

- [ ] Ejecutar ADMISS extremo a extremo.
- [ ] Demostrar ZAC y AJO Y LIMÓN con reglas genéricas.
- [ ] Alcanzar decisión comercial sin publicación automática.
- [ ] Construir MCP local STDIO sobre contratos probados.
- [ ] Demostrar idempotencia PostgreSQL + Neo4j.
- [ ] Reportar oficiales conocidos, trabajados, coincidentes, no trabajados, novedades, candidatos y conflictos.

### Etapas 3–5

- [ ] Reprocesar Mesa y preservar decisiones.
- [ ] Escalar conocimiento por sistemas y clases.
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
