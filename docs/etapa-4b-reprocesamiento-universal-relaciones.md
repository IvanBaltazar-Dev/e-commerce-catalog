# Etapa 4B · Reprocesamiento universal de relaciones

**Corte certificado:** 2026-08-17

**Migración:** `0114_universal_relation_reprocessing.sql`

**Estado:** primer pase completo en preview; no aplicado ni promovido

## Resultado

Las 323 candidatas históricas diferidas fueron fotografiadas y clasificadas por el motor `stage4b-v1`. Ninguna fila fuente cambió de estado, no se creó trabajo humano por producto, no apareció ningún hecho canónico y no hubo efectos comerciales.

| Destino | Candidatas |
| --- | ---: |
| `CLASS_MEMBERSHIP` | 99 |
| `CLASS_RELATION` | 68 |
| `GENUINE_PAIR_RELATION` | 0 |
| `NEEDS_EVIDENCE` | 60 |
| `CONTRADICTED` | 0 |
| `UNKNOWN` | 0 |
| `REJECTED` | 96 |
| **Total** | **323** |

El cero en relación genuina producto–producto no afirma que nunca pueda existir una. Significa que la evidencia conservada en esta cohorte no prueba todavía ningún par estricto. En particular, compartir marca o categoría no satisface `COMPATIBLE_WITH`.

## Compresión semántica

- 167 pares son expresables mediante clases: 99 como membresías útiles y 68 como relaciones entre clases.
- Los 68 pares de relación se condensan en 9 firmas de regla entre clases; se evitan 59 repeticiones de regla producto–producto.
- El preview propone 88 membresías distintas después de deduplicar producto + clase.
- 60 compatibilidades de drill siguen como deuda automática de evidencia explícita del par.
- 96 falsos pares se excluyen del conocimiento propuesto, pero su candidata histórica permanece intacta.

Los números provienen de los datos reales, no fueron fijados como metas.

## Motor reproducible

El flujo ejecutado es:

```text
candidate
→ subjects
→ existing memberships
→ endpoint classes
→ system/stage/role hints
→ semantic claims
→ source authority
→ 0113 relation kind
→ epistemic result
→ immutable preview
```

Quince perfiles de extremo y trece reglas compartidas sustituyen decisiones manuales por relación. Los perfiles son datos editables y explican qué patrón coincidió, qué exclusión se activó, qué clases se observaron, qué autoridad existe y por qué se eligió el destino.

`catalog_relation_reprocess_runs` congela cohorte y fingerprints; `catalog_relation_reprocess_items` conserva cada salida y bloquea `UPDATE`/`DELETE`. `preview_catalog_relation_reprocess_v1` exige el conteo esperado. `apply_catalog_relation_reprocess_v1` exige el fingerprint exacto y solo activa el análisis congelado: por contrato no aprueba, rechaza ni promueve la candidata fuente.

El primer pase certificado permaneció en `previewed`:

- snapshot: `d5b3f3c438fb2d456bdf4a114f86e97250248bdc9c2d42f8824c202020f555d4`
- preview: `32cfd09fff2774f0f45f69232894e581ec00c8dc21b46ef656f45240868983ab`

## Conflictos reales observados

La clasificación ya expone causas compartidas que 4C puede convertir en decisiones humanas agrupadas:

1. **Compatibilidad sobreafirmada por autoridad insuficiente.** `drill->drill_bit` produjo 60 pares semánticamente plausibles, pero solo con reglas de marca/categoría; falta diámetro de vástago u otra evidencia explícita.
2. **Alcance de origen mezclado.** La categoría histórica trató brocas como drills, adhesivos como tips o extensiones y accesorios como polygel. Esos pares conservan membresías útiles sin promover la relación incorrecta.
3. **Destino funcional equivocado.** Reglas de lámpara alcanzaron guantes UV y lámparas de mesa sin capacidad declarada de curado; los 24 pares gel→lámpara quedaron rechazados en preview.
4. **Promoción de regla con impacto múltiple.** 68 pares podrían sustituirse por 9 relaciones de clase. La decisión debe explicar el conjunto afectado antes de activar cualquier conocimiento.

No se fabricó una contradicción documental: la cohorte no contiene hoy evidencia fuente contra fuente enlazada al par, por eso `CONTRADICTED=0`.

## Certificación

- Reconstrucción local completa `0001–0114` y restauración verificada: 1.056 productos, 1.578 variantes, 323 candidatas diferidas.
- PostgreSQL: 51 archivos, 1.216 pruebas pgTAP, `PASS`.
- `gate:stage4a` y `gate:stage4b`: `PASS`.
- MCP `stage4b_relation_reprocess_report`: solo lectura, `PASS`.
- TypeScript y ESLint: `PASS`.
- Seguridad: RLS completo, 31 relaciones y 16 funciones `anon` iguales a la línea base, cero violaciones.
- Graph Projector `v2.7.0`: 5.290 nodos, 7.545 aristas, cero diferencias; fingerprint PostgreSQL/Neo4j `177f77717186b291f520a292f156fb9e8047da2537c63bd76cf91e3ccaa00151`.
- `db lint --level error`: solo conserva el error preexistente de `issue_purchase_order` sobre `supplier_cost_agreement_id`; `0114` no añadió hallazgos.

## Frontera y siguiente corte

Permanecen intactos precio, inventario, publicación, producción, investigación masiva, GraphRAG y `stage4Authorized=false`. La siguiente responsabilidad es 4C: agrupar las causas reales, obtener al menos tres familias de decisión y producir el contrato de lectura comercial que consumirá el frontend.
