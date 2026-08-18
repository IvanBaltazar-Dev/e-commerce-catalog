# Operación, pruebas y despliegue

**Corte:** 2026-08-17. Este runbook describe la operación vigente. Producción no se toca hasta que staging pase todos los gates.

## Entornos

```text
LOCAL       desarrollo, importaciones y pruebas destructivas
STAGING     ensayo funcional sin datos productivos
PRODUCCIÓN  operación real, solo después de aprobación
```

Cada entorno requiere su propio proyecto Supabase, buckets, secretos y frontend. Las credenciales viven en el gestor de secretos, nunca en Git.

Local usa la banda `55320–55329`: API `55321`, base `55322`, Studio `55323`. `.env.local` atiende Next.js y `.env.supabase.local` atiende scripts. Ambos deben apuntar a `http://127.0.0.1:55321` o `http://localhost:55321`.

Los scripts rechazan destinos remotos por defecto. Una operación remota requiere simultáneamente `--allow-remote` y `--confirm-project=<PROJECT_REF>` cuando el script lo admita.

## Primera ejecución local

```bash
npm install
npx supabase start
npm run db:reset:local
npm run seed:demo-operation
npm run dev
```

Desarrollo usa Turbopack. Para revisar el prototipo sin compilación al primer clic:

```bash
npm run prototype:build
npm run prototype:start
# http://127.0.0.1:3005
```

`npm run prototype` ejecuta ambas fases y usa `.next-prototype`, aislado de otros servidores.

## Usuarios locales

| Rol | Usuario | Contraseña | Alcance |
| --- | --- | --- | --- |
| `developer` | `bulk-dev@local.invalid` | `Bulk-Dev-2026!` | Panel completo e Importaciones |
| `admin` | `demo-admin@local.invalid` | `Demo-Admin-2026!` | Operación de la propietaria, sin Importaciones |
| `seller` | `demo-seller@local.invalid` | `Demo-Seller-2026!` | Venta, caja, existencias y conversaciones |

Son identidades `.invalid` exclusivamente locales. Nunca se siembran fuera de la máquina de desarrollo.

## Verificación mínima

Después de cambios documentales o TypeScript:

```bash
npm run typecheck
npm run lint
```

Después de migraciones o reglas de negocio:

```bash
npm run db:reset:local
npm run test:db
npm run audit:security
```

El checkpoint semántico base llega hasta `0112`, el contrato funcional 4A hasta `0113`, el reprocesamiento universal 4B hasta `0114`, el read model humano 4C hasta `0115`, el contrato de decisión/apply 4E hasta `0116`, la expansión controlada hasta `0117` y la campaña unificada hasta `0118`. La certificación cubre claims de fuente, agregación, epistemología universal, ingesta fail-closed, sistema→etapa→rol→clase→requisito, preview inmutable de 323 relaciones, 18 decisiones agrupadas, aplicación exacta con auditoría, manifiestos sin clasificación automática y nueve pasos de campaña con huella comercial estable. La autorización humana de Etapa 4 no reemplaza esta certificación ni permite omitir gates.

Gates especializados:

| Comando | Cobertura |
| --- | --- |
| `npm run gate:rebuild` | reconstrucción desde cero, integrales, concurrencia, tipos, lint y build |
| `npm run gate:busqueda` | búsquedas con volumen y planes indexados |
| `npm run gate:enriquecimiento` | procedencia, conocimiento y exportación aprobada |
| `npm run gate:reference-scale` | Universo de Referencia adicional, matching indexado y streaming del contrato de grafo |
| `npm run test:graph-projector` | rebuild repetido, divergencia deliberada, reparación incremental y verify |
| `npm run test:stage2:admiss` | ADMISS, ZAC, AJO Y LIMÓN, guardas comerciales, deduplicación y capas del grafo |
| `npm run test:mcp:catalog-intelligence` | proceso STDIO nuevo, superficie MCP cerrada y respuesta integral desde las bases |
| `npm run audit:admiss-semantics` | cobertura semántica ADMISS, excerpts, gaps e idempotencia sin canonización |
| `npm run gate:semantic-human-scale` | agregación por regla y crecimiento sublineal de excepciones humanas |
| `npm run gate:semantic-certification` | arquetipos universales, entailment, contradicción, promoción y contrato fail-closed |
| `npm run gate:stage4a` | contrato universal, fixture Acrílico, 323 diferidas intactas, guardas comerciales y paridad del grafo |
| `npm run test:mcp:stage4a` | herramienta MCP 4A de solo lectura y reporte seguro, sin depender de una campaña de marca |
| `npm run relation:reprocess -- preview <clave> 323` | congela y clasifica las 323 relaciones sin mutar la cohorte fuente |
| `npm run gate:stage4b` | cobertura completa, compresión clase/par, fingerprints, guardas epistémicas y paridad del grafo |
| `npm run test:mcp:stage4b` | reporte MCP 4B de solo lectura con 323 resultados y cero promoción |
| `npm run gate:stage4c` | tres familias reales, agrupación por causa, contrato de decisión, guardas comerciales y paridad del grafo |
| `npm run test:mcp:stage4c` | reporte y cola MCP 4C de solo lectura; React no interpreta reglas |
| `npm run test:mcp:stage4e` | cuatro lecturas y cuatro comandos de decisión; inspecciona sin mutar y certifica el contrato cerrado |
| `npm run test:catalog-relation-decisions-ui` | cola, lenguaje, decisión no binaria y responsive de 4F sobre una aplicación local ya iniciada |
| `npm run system:expand -- run-approved` | aplica idempotentemente los manifiestos Gel/Pestañas aprobados, sin productos ni efectos comerciales |
| `npm run gate:controlled-expansion` | preview/apply de manifiestos, fronteras epistémicas/comerciales y paridad completa del grafo |
| `npm run test:mcp:stage4g` | reporte MCP de expansión de solo lectura |
| `npm run catalog:intelligence -- preview|run|report ...` | prepara, ejecuta/reanuda o consulta una campaña unificada local |
| `npm run gate:stage5` | nueve pasos, reporte humano, fronteras comercial/epistémica y paridad completa del grafo |
| `npm run test:mcp:stage5` | reporte MCP de campaña de solo lectura |
| `npm run test:catalog-review-rerun` | reprocesamiento idempotente de la Mesa |
| `npm run test:review-reprocess` | rerun nulo, fingerprint lógico y guardas de tablas comerciales |
| `npm run test:venta` | pagos, concurrencia, venta y nota |
| `npm run test:admin-nav` | navegación autenticada y carga inicial |
| `npm run perf:volume` | rendimiento bajo volumen sintético |
| `npm run test:responsive` | superficies reales en escritorio y móvil |

Las pruebas deben aislar sus propios datos y limpiar en `finally`; no pueden asumir que otra sesión no usa la misma base.

## Neo4j Community y Graph Projector

Neo4j es local, derivado y prescindible para la operación comercial. Define `NEO4J_PASSWORD` en `.env.supabase.local`; el resto de valores puede partir de `.env.example`.

```bash
npm run neo4j:up
npm run stage1:fixtures
npm run graph:status
npm run graph:rebuild
npm run graph:verify
npm run graph:sync
```

`graph:rebuild` vacía exclusivamente los nodos/aristas marcados como proyección Bellaroshé y los repone desde PostgreSQL. `graph:sync` procesa nodos y aristas por cursor y lotes, actualiza fingerprints y retira derivados obsoletos. `graph:verify` es de solo lectura y reporta faltantes, duplicados, huérfanos, referencias inválidas, elementos inesperados y versiones antiguas. No existe un comando de Cypher libre.

`npm run neo4j:down` detiene el contenedor sin borrar sus volúmenes. Levantarlo de nuevo y ejecutar `graph:rebuild` recupera el mismo conocimiento desde PostgreSQL.

## Campaña oficial y MCP local

La unidad de campaña es una fuente registrada y, si aún no está vinculada, una marca. El adaptador descubre desde la raíz; no se introducen fichas individuales en el código.

```bash
npm run research:official-brand -- --source-key admiss-co-official --brand ADMISS --summary
npm run graph:sync
npm run graph:verify
npm run test:stage2:admiss
npm run mcp:catalog-intelligence
```

Repetir `research:official-brand` genera un delta. Si el material no cambió, reutiliza el snapshot y no duplica observaciones, precios, medios, candidatas ni trabajos. El RAW capturado queda bajo `research/catalog-master/local/research-runs`, fuera de Git, con manifiesto por corrida; PostgreSQL conserva hash, metadata y referencia.

La captura Shopify incluye también la pertenencia oficial a colecciones. El normalizador semántico interpreta superficies oficiales mediante reglas genéricas y conserva cada resultado como claim de fuente, nunca como verdad técnica universal. Para reproducir la auditoría ADMISS previa a Etapa 4:

```bash
npm run test:semantic-normalizer
npm run research:official-brand -- --source-key admiss-co-official --brand ADMISS --summary
npm run audit:admiss-semantics
npm run graph:sync
npm run graph:verify
```

El informe queda en `research/catalog-master/reports/admiss-semantic-audit/`: matriz CSV de 121 productos, JSON con consultas/excerpts/fingerprints y resumen Markdown. La auditoría no crea trabajo en Mesa, no publica y no autoriza por sí sola una etapa. La autorización humana para iniciar Etapa 4 se registró el 2026-08-17 y conserva intactas todas las guardas.

MCP v1 usa STDIO local. 4E añade cuatro lecturas y cuatro comandos acotados para preview, aplazamiento, reanudación y apply exacto; no acepta SQL, shell, URL arbitraria, Cypher ni mutaciones de catálogo, precio, inventario o publicación. Los comandos llaman los mismos contratos PostgreSQL que la interfaz y sincronizan el Graph Projector después de aplicar.

Etapa 5 añade `catalog_campaign_report` como lectura y mantiene la ejecución fuera de MCP. El flujo operacional es:

```bash
npm run catalog:intelligence -- preview --source-key admiss-co-official --brand ADMISS --campaign-key <clave>
npm run catalog:intelligence -- run --source-key admiss-co-official --brand ADMISS --campaign-key <clave>
npm run catalog:intelligence -- report --campaign-id <uuid>
npm run gate:stage5
npm run test:mcp:stage5
```

Repetir `run` con la misma clave reanuda pasos cerrados; no los duplica. `--skip-research` solo reutiliza el universo persistido y conserva los otros ocho pasos. La campaña sigue siendo manual, local y no comercial.

Después de un `db reset`, `npm run checkpoint:restore:local` no solo restaura las 26 tablas comerciales: regenera staging, ejecuta el corte analítico 4B y sincroniza las 18 decisiones 4E. Así, ninguna prueba o pantalla depende de residuos locales.

## Reprocesamiento de la Mesa

El preview persiste una fotografía completa y una huella de acciones. `apply` rechaza cualquier fingerprint distinto o una Mesa que haya cambiado desde el preview. PostgreSQL decide; al terminar se sincroniza y verifica Neo4j.

```bash
npm run review:reprocess -- report
npm run review:reprocess -- preview <clave-preview>
npm run review:reprocess -- apply <preview-id> <preview-fingerprint> <clave-apply>
npm run review:reprocess -- run <clave-base>
npm run test:catalog-review-rerun
npm run test:review-reprocess
npm run graph:sync
npm run graph:verify
```

`run` solo encadena preview y apply del mismo snapshot. Las decisiones históricas no se editan: evidencia contradictoria posterior registra un evento y un trabajo enlazado. Las afirmaciones comerciales, compatibilidades y las relaciones masivas no se autoaprueban.

Para el gate de escala completo, primero se conserva el volumen comercial sintético y luego se añade un universo independiente:

```bash
npm run gate:busqueda -- --keep
npm run gate:reference-scale -- --referencias=150000
```

El segundo gate elimina sus referencias sintéticas al terminar. Un `db:reset:local` posterior retira el volumen comercial de prueba.

## Inventario y datos de prueba

- No cargar stock mediante `UPDATE`; usar `load_initial_inventory`, recepción o ajuste autorizado.
- Una variante importada sin existencia no aparece como vendible solo porque exista en catálogo.
- Las sedes y registros temporales de pruebas deben desactivarse o limpiarse al finalizar.
- Una migración no puede depender de un seed. Producción puede no ejecutar seeds.
- Después de `db reset`, verificar `/auth/v1/health`; si Kong conserva un enlace obsoleto, reiniciar únicamente el contenedor local de Kong y volver a comprobar salud.

## Backup y recuperación

```bash
npm run backup:verify
npm run rollback:drill
```

`backup:verify` genera un `pg_dump` y lo restaura de verdad en una base de verificación. Un archivo que nunca se restauró no cuenta como backup.

Para un incidente remoto, restaurar primero en un proyecto o base nueva, verificar conteos e invariantes y después cambiar el frontend. No restaurar encima del origen dañado sin conservar una copia de su estado.

## Staging y producción

Secuencia obligatoria:

1. provisionar proyectos separados y cargar secretos por entorno;
2. verificar `supabase migration list --linked`;
3. ejecutar y restaurar un backup del entorno;
4. aplicar migraciones en staging;
5. ejecutar `audit:security`, E2E real y pruebas de humo;
6. validar RLS, Storage, responsive, rendimiento y rollback;
7. revisar resultados y autorizar producción expresamente;
8. repetir backup, migración, smoke test y observación en producción.

El frontend se revierte publicando el build anterior. Una migración aditiva permite ese rollback; una migración destructiva exige el plan de datos y backup aprobado antes de aplicarla.

## Observabilidad

- Toda API debe devolver `x-request-id` y repetirlo en el error estructurado.
- Logs de servidor son JSON de una línea, sin payloads sensibles.
- Clases mínimas: `http_5xx`, `rpc_error`, `ai_failure`, `pdf_failure` y `storage_failure`.
- Las mutaciones críticas dejan auditoría en la base.
- La caída de un proveedor de IA degrada la asistencia; nunca impide vender ni publica contenido sola.

## Problemas frecuentes

| Síntoma | Acción |
| --- | --- |
| Supabase no inicia | comprobar Docker y la banda `55320–55329` |
| Auth devuelve 502 tras reset | comprobar salud y reiniciar Kong local |
| Chrome no aparece en pruebas/PDF | `npx puppeteer browsers install chrome` o definir `PUPPETEER_EXECUTABLE_PATH` |
| Panel devuelve cero filas | revisar perfil activo, rol, sede y RLS |
| Importaciones no aparece | usar `developer` y comprobar `ENABLE_CATALOG_IMPORTS=true` |
| Inventario muestra pocos productos | solo muestra variantes con saldo; catálogo no equivale a stock |
| Typecheck menciona una ruta borrada | limpiar tipos generados del build afectado |
| Error con `requestId` | buscar ese ID en logs y seguir la clase registrada |

## Referencias

- [Arquitectura](arquitectura.md)
- [Calidad y riesgos](calidad-y-riesgos.md)
- [Importación](importacion-catalogo.md)
- [Migraciones](../supabase/migrations/README.md)
