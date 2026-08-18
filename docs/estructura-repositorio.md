# Qué es cada carpeta

Lo que se versiona es código, contratos y evidencia reproducible. Todo lo demás
—cachés, dumps, exportaciones— es regenerable y está fuera de Git. Esta página
existe para que ninguna carpeta del disco quede sin explicación.

## Lo que Git conserva

| Carpeta | Qué es |
|---|---|
| `src/` | La aplicación: rutas de Next, componentes, servicios y contratos de tipo. |
| `supabase/migrations/` | El esquema, en orden. Es la única fuente de la estructura de datos. |
| `supabase/tests/database/` | pgTAP. Una prueba por migración con contrato propio. |
| `scripts/` | Gates, integrales, sembrado y utilidades de línea de comandos. |
| `docs/` | Etapas, decisiones y evidencia. Empieza por [README](README.md). |
| `research/catalog-master/` | El pipeline de investigación: **código y manifiesto**, no los datos. |
| `catalog-preview/` | El catálogo impreso y sus capturas, versionadas como referencia visual. |
| `assets/`, `public/`, `security/`, `infra/` | Marca, estáticos, política y Neo4j local. |

## Lo que el disco tiene y Git no

| Carpeta | Qué es | Se puede borrar |
|---|---|---|
| `.next/` | Caché del servidor de desarrollo principal (`npm run dev`). | Sí, se regenera al arrancar. |
| `.next-a/` | Build de producción aislado que sirve `npm run serve:a` en el puerto 3002. Es el que usa el gate de reconstrucción. | Sí, `npm run build:a` lo rehace. |
| `.next-b/`, `.next-c/`, `.next-d/` | Cachés de los servidores de desarrollo paralelos `dev:b` (3005), `dev:c` (3006) y `dev:d` (3007). Existen para trabajar en varias sesiones a la vez sin pelearse por el puerto ni por la carpeta de build. | Sí. Se rehacen solas al arrancar esa ranura. |
| `node_modules/` | Dependencias. | Sí, `npm ci`. |
| `research/catalog-master/data/`, `sources/`, `local/` | Snapshots crudos de las fuentes oficiales y tablas derivadas. Pesan y cambian; Git guarda el manifiesto SHA-256, no el contenido. | No sin querer: son la entrada del pipeline. |
| `outputs/` | Entregables generados para revisión humana (planillas, listas de captura). | Los `.xlsx` son entregables; los `.inspect.ndjson` que los acompañaban eran subproductos de herramienta y se retiraron. |
| `backups/` | Volcados de la base anteriores al sistema de checkpoints (agosto de 2026). | **Decisión pendiente.** Ver abajo. |
| `test-results/` | Capturas y reportes de las pruebas de interfaz y de los gates. | Sí. |
| `.env.local`, `.env.supabase.local` | Credenciales locales. Nunca al historial. | No. |

### Las cuatro ranuras de desarrollo

`dev`, `dev:b`, `dev:c` y `dev:d` son el mismo servidor de Next en cuatro
puertos con cuatro carpetas de build distintas. No hay diferencia de código
entre ellas: solo permiten que varias sesiones de trabajo convivan sin que una
invalide la caché de la otra. Si sobran, se borra la carpeta y basta.

| Ranura | Comando | Puerto | Caché |
|---|---|---|---|
| principal | `npm run dev` | 3001 | `.next/` |
| producción local | `npm run build:a` + `npm run serve:a` | 3002 | `.next-a/` |
| b | `npm run dev:b` | 3005 | `.next-b/` |
| c | `npm run dev:c` | 3006 | `.next-c/` |
| d | `npm run dev:d` | 3007 | `.next-d/` |

> `build:a` reescribe `next-env.d.ts` para apuntar a `.next-a`. Es un efecto de
> Next, no del proyecto: hay que devolver el archivo a `.next` antes de
> commitear.

## Decisión pendiente sobre `backups/`

Quedan 164 MB de tres volcados: uno completo y otro de solo datos del 10 de
agosto de 2026, y un `.dump` del 12. Son anteriores al sistema de checkpoints,
que hoy es el camino de restauración real (`npm run checkpoint:restore:local`).
No se borraron porque borrar copias de seguridad no se deshace y la decisión es
del dueño del dato, no de quien limpia.
