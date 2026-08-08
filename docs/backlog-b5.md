# Backlog — mejoras no bloqueantes (registradas en el Bloque 5)

Regla del Bloque 5: si durante la estabilización aparece una mejora que **no** bloquea seguridad, integridad, despliegue, recuperación, rendimiento razonable ni operación real, se registra aquí y se sigue. Estabilización no se convierte en otro bloque de desarrollo.

## Registradas

| # | Mejora | Por qué no bloquea | Cuándo conviene |
|---|---|---|---|
| B5-01 | Índices sobre tablas grandes con `CREATE INDEX CONCURRENTLY` | Al volumen actual y esperado (~miles de filas) los índices existentes cumplen los umbrales medidos (`perf:volume`); ninguna consulta necesitó uno nuevo | Cuando una tabla supere ~10⁵ filas en producción y una medición real lo pida |
| B5-02 | Observabilidad enriquecida (tracing distribuido, panel de errores) | La observabilidad mínima (x-request-id + log estructurado por clase) ya permite diagnosticar un incidente | Si el volumen de incidentes justifica una herramienta dedicada |
| B5-03 | `perf:volume` con un equivalente remoto (medir en staging con datos reales) | Local mide el mismo esquema; el gate de staging lo cubre con `e2e:staging` + una medición puntual cuando exista el entorno | Al provisionar staging |
| B5-04 | Optimización de imágenes del catálogo | La auditoría inicial la señaló como debilidad de rendimiento; la medición de `perf:volume` NO la reprodujo como cuello de botella (el catálogo público responde dentro de umbral). Solo se abre si una medición en producción con imágenes reales lo confirma | Si producción muestra el problema medido |
| B5-05 | Rotación automatizada de `ANTHROPIC_API_KEY` y secretos de canal | Hoy son opcionales y viven solo en el gestor de secretos del servidor; la rotación es manual documentada | Cuando la IA y los canales pasen a producción activa |
| B5-06 | Actualizar Supabase CLI (2.109 → 2.112) | La versión instalada reconstruye y prueba todo en verde; el aviso es informativo | En una ventana de mantenimiento |

## Deuda cerrada durante el Bloque 5 (ya NO es backlog)

- **R-12** (`.env` raíz con `service_role` remoto): archivo puesto en cuarentena fuera del repo; **rotación de la clave pendiente en el dashboard** (única acción manual que queda del ítem).
- **ACL por defecto abierto a anon** (deuda de 0002): cerrado por la migración 0045 con auditoría (`audit:security`) y línea base versionada.
- **Rutas de navegador hardcodeadas**: reemplazadas por `scripts/lib/resolve-browser.mjs`.
- **Ausencia de staging y procedimiento de reversión** (hueco de la auditoría inicial): runbook en `docs/staging-produccion.md`, rollback ensayado en `scripts/rollback-drill.mjs`, backup real en `scripts/backup-verify.mjs`.
