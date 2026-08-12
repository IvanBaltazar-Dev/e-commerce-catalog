# Operación, pruebas y despliegue

**Corte:** 2026-08-12. Este runbook describe la operación vigente. Producción no se toca hasta que staging pase todos los gates.

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

El corte auditado de la suite completa era de 876 comprobaciones pgTAP sobre las migraciones `0001`–`0100`. El número cambia; el resultado de la ejecución vigente es la evidencia válida.

Gates especializados:

| Comando | Cobertura |
| --- | --- |
| `npm run gate:rebuild` | reconstrucción desde cero, integrales, concurrencia, tipos, lint y build |
| `npm run gate:busqueda` | búsquedas con volumen y planes indexados |
| `npm run gate:enriquecimiento` | procedencia, conocimiento y exportación aprobada |
| `npm run test:catalog-review-rerun` | reprocesamiento idempotente de la Mesa |
| `npm run test:venta` | pagos, concurrencia, venta y nota |
| `npm run test:admin-nav` | navegación autenticada y carga inicial |
| `npm run perf:volume` | rendimiento bajo volumen sintético |
| `npm run test:responsive` | superficies reales en escritorio y móvil |

Las pruebas deben aislar sus propios datos y limpiar en `finally`; no pueden asumir que otra sesión no usa la misma base.

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
