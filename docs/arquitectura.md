# Arquitectura de Bellaroshé

**Corte:** 2026-08-12
**Estado:** arquitectura vigente en el entorno local; producción permanece fuera de alcance hasta superar staging.

## Plataforma y límites

Bellaroshé es una aplicación Next.js 15 con TypeScript sobre Supabase: PostgreSQL, Auth y Storage. React presenta contratos; las reglas críticas, la autorización por fila y las transacciones viven en PostgreSQL.

```text
Navegador
  → páginas y componentes Next.js
  → rutas API y servicios server-side
  → RPC, tablas con RLS y Storage
  → PostgreSQL como fuente de verdad
```

Los dominios principales son catálogo, organización, abastecimiento, inventario, venta/caja, omnicanalidad, analítica, asistencia y enriquecimiento. Comparten identidad y auditoría, pero no deben duplicar sus reglas.

## Decisiones estructurales

### Catálogo

- Producto es la familia comercial; variante es la unidad vendible.
- Todo producto operativo tiene al menos una variante activa y una variante predeterminada coherente.
- Categorías, plantillas, atributos, opciones y ejes son datos, no condiciones por marca codificadas en React.
- `is_active` controla la operación; `editorial_status` controla publicación.
- Precio, disponibilidad, mayorista, relaciones y medios se resuelven desde sus tablas canónicas, no desde copias en la interfaz.
- Producto y variante no se confunden durante la reconciliación: primero se confirma la familia; tono, SKU o presentación se resuelven en trabajos dependientes.

### Organización y seguridad

- Toda operación pertenece a una empresa y una sede mediante `branch_id`, aunque la experiencia actual oculte la sede cuando solo existe una activa.
- Los roles son `admin`, `developer` y `seller`; RLS y contratos estrechos determinan su alcance.
- Los libros de auditoría, kardex, eventos de revisión y demás evidencias históricas son de solo adición.
- Una tabla de solo adición no lleva una FK que pueda mutarla indirectamente mediante `ON DELETE`.
- `service_role` solo puede existir en servidor o scripts. Ningún secreto usa el prefijo `NEXT_PUBLIC_`.

### Inventario y costo

- El saldo se bloquea por `(variant_id, branch_id)`; no se ajusta con `UPDATE` manual.
- Todo cambio de existencia genera un movimiento de kardex trazable.
- El costo promedio se calcula sobre valor total, distingue costo desconocido de costo cero y fuerza valor cero cuando la cantidad llega a cero.
- La disponibilidad vendible deriva del inventario y del control editorial; no se inventa stock para productos cargados.

### Venta, dinero y documentos

- Venta, entrega y cobro son dimensiones distintas.
- Una venta confirmada preserva fotografías de sus líneas y no depende de nombres o precios futuros.
- Pagos, anulaciones, devoluciones, reembolsos y reservas son transacciones idempotentes y conciliables.
- Los candados se toman en orden estable y, al cobrar, sobre la venta para evitar doble cobro.
- La nota de venta es un documento interno. Boleta y factura requieren su flujo fiscal independiente; nunca se simula un comprobante SUNAT.
- El saldo neto considera total, devoluciones, cobros y reembolsos.

### Proveedores y compras

- Una oferta vincula proveedor con producto o variante; solo el alcance variante admite acuerdos de costo.
- Los costos tienen vigencia e historial: un costo vigente no se reescribe.
- Las escalas por cantidad deben ser contiguas y completas, no solo no superpuestas.
- Presentación de compra, impuestos, bonificaciones y moneda forman parte de la comparación.
- Una opción no viable se conserva con el motivo; no desaparece del análisis.

## Evidencia, revisión y conocimiento

El enriquecimiento usa capas separadas:

```text
fuente externa → snapshot RAW → observación normalizada
→ candidata/reconciliación → trabajo de revisión
→ decisión aprobada → catálogo o conocimiento canónico
→ proyección de grafo reconstruible y solo lectura
```

- La investigación nunca escribe directamente en productos, variantes, tonos, medios o relaciones.
- La Mesa de revisión coordina trabajo; no reemplaza el catálogo ni la evidencia.
- Los hechos requieren procedencia compatible con el valor aprobado.
- Una relación inferida, compartir marca o aparecer en un mismo sistema no demuestra compatibilidad entre dos productos.
- PostgreSQL es la fuente de verdad. Neo4j Community es una proyección local derivada: `Graph Projector` la reconstruye, sincroniza y verifica, y nunca escribe de vuelta. `Product`/`Variant` son catálogo Bellaroshé; `ReferenceProduct`/`ReferenceVariant` son conocimiento externo y pueden existir sin identidad comercial.

El Universo de Referencia se diseña como volumen independiente del catálogo. Corridas marca + fuente conservan baseline, deltas y observaciones; el staging existente consulta primero catálogo y referencias mediante índices PostgreSQL. El projector recorre vistas ordenadas con cursor y lotes, sin cargar el universo completo en Node. Las señales de identidad se proyectan como `IdentityCandidate`, `IdentityContradiction` o `IdentityMatch`, separadas de `Product`/`Variant` y de las referencias externas.

MCP v1 es un adaptador STDIO local de solo lectura sobre contratos PostgreSQL y el estado fijo del Graph Projector. No contiene reglas exclusivas ni permite consultas genéricas o escritura comercial. La campaña manual conserva la única ruta de mutación de investigación probada en esta etapa.

## Concurrencia e idempotencia

- Los comandos de negocio actualizan verdad canónica, auditoría e impacto en una sola transacción.
- Cada reintento externo usa una clave idempotente; la misma clave con otro contenido falla.
- La edición humana usa versión esperada. Una decisión sobre una versión obsoleta recibe conflicto, nunca sobrescribe otra sesión.
- Las operaciones masivas congelan IDs, versiones y huellas; si el conjunto cambia, fallan sin aplicar parcialmente.

## Evolución del esquema

El historial comienza en V1 (`0001`, `0002`, `0004`), evoluciona de forma aditiva desde `0005` y llega actualmente a `0107_stage2_brand_research_mcp_contracts.sql`. Las migraciones antiguas no se reescriben; toda corrección nueva se expresa en otra migración y actualiza pruebas y contratos.

El índice detallado vive en [supabase/migrations/README.md](../supabase/migrations/README.md). Las referencias de implementación deben apuntar a la migración o contrato que ejecuta la regla, no a una bitácora histórica.

## Deuda arquitectónica que sigue visible

- Comprobar y retirar cualquier consumidor V1 restante antes de una migración destructiva.
- Validar en el borde los contratos JSON de RPC o generar tipos desde Supabase.
- Mantener las familias completamente dirigidas por datos.
- Cerrar el contrato de escritura del MCP antes de permitir mutaciones, aunque sean sobre staging.
- Probar despliegue, respaldo y recuperación en un staging real antes de producción.
