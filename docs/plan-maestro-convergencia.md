# Plan maestro Bellaroshé — Prototipo → aplicación real

**Regla de gobierno, por encima de todo el checklist:**

> 🚫 No abrir un nuevo circuito grande mientras el anterior siga con frontend
> provisional. **Terminado significa: datos + reglas + UI del prototipo + móvil
> + pruebas.**

La idea central: **no esperamos al final para cambiar el frontend.** Cada
circuito se termina funcionalmente y se lleva de inmediato al diseño definitivo
del prototipo antes de abrir demasiados módulos nuevos. El equipo deja de
decidir «qué toca después» sobre la marcha: lo dice este documento.

Referencias: [importacion-masiva-catalogo.md](importacion-masiva-catalogo.md)
(pipeline, runbook de lotes, actas), `docs/decision-reutilizacion-v2.md`.

---

## Fase 1 — Completar el catálogo real local

**Objetivo:** dejar de desarrollar contra demos; las ~1,500 filas reales en local.

Ya está: `unas-esmaltes-01` (74 productos, 227 variantes, 152 tonos, segundo
pase sin duplicados, imágenes Masglo conciliadas, búsqueda POS por tono probada).

Ahora, con el mismo runner (`npm run bulk:lote`) y por cada lote
**preview → excepciones → aprobación → commit → reporte → segundo pase**:
`unas-sistemas-01` · `unas-decoracion-01` · `unas-herramientas-01` ·
`unas-equipos-01` · `cejas-pestanas-01` · `cabello-barberia-01` ·
`rostro-cuerpo-01` · `transversales-01` · 6 filas pendientes → revisión humana.

**Gate de salida** (no se exige perfección de datos, sí):
ninguna duplicación silenciosa · todas las excepciones explicadas · idempotencia
· productos/variantes correctamente agrupados · proveedor correctamente asociado
· deuda de imágenes explícita · ningún dato inventado.

## Fase 2 — Convergencia Frontend #1: Nueva venta (B1 definitivo)

No se agregan módulos operativos hasta hacer esta convergencia.

- **2.1 Las tres velocidades**: (1) búsqueda directa producto/SKU/marca/tono →
  variante; (2) producto → variante rápida; (3) `openTones(pid)`.
- **Hoja de tonos definitiva**: Recientes · Más vendidos · Todos · búsqueda
  interna con foco automático · familia cromática · «Solo disponibles» ·
  selección múltiple · «Limpiar selección» · «Agregar N unidades» · precios
  minorista/mayorista + umbral · imagen/swatch · disponibilidad.
  **Invariantes del prototipo:** la cuadrícula NO se reordena mientras se
  selecciona, y se conserva el `scrollTop` al actualizarla.
- **2.2 Recientes correctamente**: sin tabla nueva; derivados de
  `sales + sale_lines + seller_id + variant_id + issued_at` (30 días). Sembrar
  ventas locales de Vendedora A y B y demostrar recientes distintos.
- **2.3 Carrito definitivo**: cantidades · eliminar línea · vaciar con
  confirmación · selección múltiple · minorista/mayorista · totales ·
  disponibilidad · advertencias.
- **2.4 Cobro**: un solo medio → importe precargado; varios → distribución
  manual; sin pasos redundantes.
- **2.5 Comprobante/cierre**: venta → pago → confirmación → comprobante/nota →
  nueva venta.

## Fase 3 — Convergencia Frontend #2: Dueña (Inicio A1)

A1 ya tiene la lógica. Comparar sistemáticamente prototipo vs aplicación y
cerrar diferencias de jerarquía, espacios, tarjetas, estados vacíos, alertas,
accesos, responsive, tipografía y microinteracciones. **Sin volver a calcular
números en el frontend.**

## Fase 4 — Convergencia Frontend #3: Inventario + Reposición

D1 y D2 están funcionalmente cerrados; convertirlos en experiencia definitiva.

- **Inventario** contesta de inmediato: qué producto · qué variante · cuánto hay
  · reservado · disponible · estado · dónde está · por qué existe ese saldo.
  Búsqueda por nombre, SKU, marca, tono y código de tono. **Cada cantidad abre
  el kardex que la explica.**
- **Reposición** contesta: qué reponer · por qué · cuánto queda · cobertura ·
  salidas · proveedor · cantidad sugerida · acción. Si la cobertura no se puede
  calcular: **decirlo y explicar por qué; no fabricar una cifra.**

## Fase 5 — Gate visual y funcional

Antes de abrir el siguiente circuito: Desktop contra prototipo · Tablet
(densidad y navegación) · Móvil (especialmente Nueva venta, selector de tonos,
carrito, inventario, reposición) · **Datos reales**: producto con 1 / 10 / 50+
variantes · Masglo 70+ tonos · sin foto · swatches · agotados · varios
proveedores · mayorista · búsqueda por SKU y por tono.

## Fase 6 — Continuar roadmap funcional

Regla nueva por circuito: **A modelo/contrato → B backend → C integración →
D prototipo implementado → E pruebas → F cerrado.** No se acumula «funciona,
pero después hacemos el frontend».

## Fase 7 — Público V2

No se deja para el final: cuando backoffice/POS esté convergido y el catálogo
real cargado. Inicio público (búsqueda protagonista, familias, tonos, marcas,
novedades, más vendidos, recomendaciones) · `/catalogo` explorador universal ·
`/tonos` especializado (marca, línea, familia cromática, acabado,
disponibilidad, swatches, fotografías) · filtros dinámicos por familia
(esmaltes: tono/acabado/línea; pestañas: curva/grosor/longitud; pegamentos:
secado/retención; lámparas: potencia; tornos: RPM…) — encaja con la
arquitectura porque el catálogo es producto/variante + atributos declarativos,
no columnas por familia. Páginas de marca, familia, producto, selección y
carrito público. Primero excelente descubrimiento; después checkout/cuentas/IA.

## Fase 8 — Staging (en paralelo)

Staging · credenciales · R-12 · variables · Supabase · Vercel · backups ·
rollback. Cuando esté: **repetir la carga real con los mismos 9 lotes**, sin
modificar datos a mano para «hacerlos entrar». Local y staging deben reconciliar.

## Fase 9 — Catálogo + sistema completo en staging

Integrales: catálogo → venta → pago → caja → inventario → kardex → reposición →
proveedor → dashboard. Y público → producto → variante → selección →
disponibilidad/precio.

## Fase 10 — Producción

Solo cuando: carga real probada · segunda ejecución idempotente · staging
limpio · frontend convergido · móvil probado · rollback preparado ·
credenciales rotadas · métricas fundamentales conciliadas.

---

# CHECKLIST MAESTRO

## Datos reales
- [x] Piloto de importación real.
- [x] unas-esmaltes-01.
- [x] unas-sistemas-01.
- [x] unas-decoracion-01.
- [x] unas-herramientas-01.
- [x] unas-equipos-01.
- [x] cejas-pestanas-01.
- [x] cabello-barberia-01.
- [x] rostro-cuerpo-01.
- [x] transversales-01.
- [x] Resolver/revisar las 6 filas pendientes. (registradas en lote pendientes-manual-01, en revisión de la dueña)
- [x] Segundo pase global sin duplicados.
- [x] Reconciliación global del catálogo.
- [x] Reporte final de importación local.

## POS / Venta
- [ ] Implementar diseño definitivo de Nueva venta.
- [ ] Velocidad 1: búsqueda directa de variante/tono.
- [ ] Velocidad 2: producto → variante.
- [ ] Velocidad 3: hoja de tonos.
- [ ] Recientes / Más vendidos / Todos.
- [ ] Recientes derivados por vendedora.
- [ ] Familias cromáticas dinámicas.
- [ ] Solo disponibles.
- [ ] Selección múltiple.
- [ ] Cuadrícula congelada.
- [ ] Restauración de scrollTop.
- [ ] Vaciar selección.
- [ ] Vaciar carrito con confirmación.
- [ ] Cobro automático con un medio.
- [ ] Cobro dividido.
- [ ] Comprobante/cierre.
- [ ] Responsive real.

## Dueña
- [x] A1 funcional.
- [ ] A1 visualmente convergido con prototipo.
- [ ] Estados vacíos definitivos.
- [ ] Alertas definitivas.
- [ ] Responsive definitivo.
- [ ] Meta diaria cuando exista configuración real.

## Inventario
- [x] D1 funcional.
- [ ] D1 con diseño definitivo.
- [ ] Búsqueda nombre.
- [ ] Búsqueda SKU.
- [ ] Búsqueda marca.
- [ ] Búsqueda tono.
- [ ] Búsqueda código de tono.
- [ ] Kardex desde cada cantidad.
- [ ] Responsive definitivo.

## Reposición
- [x] D2 funcional.
- [ ] D2 con diseño definitivo.
- [ ] Razón de reposición.
- [ ] Stock.
- [ ] Cobertura.
- [ ] Salidas.
- [ ] Proveedor.
- [ ] Cantidad sugerida.
- [ ] Acción Reponer.
- [ ] Estado «no estimable» correctamente explicado.

## Gate Frontend #1
- [ ] Nueva venta aprobada contra prototipo.
- [ ] Inicio aprobado contra prototipo.
- [ ] Inventario aprobado contra prototipo.
- [ ] Reposición aprobada contra prototipo.
- [ ] Desktop aprobado.
- [ ] Tablet aprobado.
- [ ] Móvil aprobado.
- [ ] Catálogo real utilizado en las pruebas.

## Público V2
- [ ] Arquitectura pública definitiva.
- [ ] Inicio.
- [ ] /catalogo.
- [ ] /tonos.
- [ ] Página de marca.
- [ ] Página de familia.
- [ ] Producto/variantes.
- [ ] Selección/carrito.
- [ ] Filtros dinámicos por familia.
- [ ] Imágenes optimizadas.
- [ ] Responsive.
- [ ] Pruebas con catálogo real completo.

## Infraestructura
- [ ] Provisionar staging.
- [ ] Resolver R-12.
- [ ] Credenciales rotadas.
- [ ] Backups.
- [ ] Rollback.
- [ ] Configuración versionada/documentada.

## Staging
- [ ] Ejecutar los 9 lotes.
- [ ] Segundo pase sin duplicados.
- [ ] Reconciliar con local.
- [ ] POS completo.
- [ ] Inventario completo.
- [ ] Reposición completa.
- [ ] Dashboard completo.
- [ ] Público completo.
- [ ] Móvil completo.

## Producción
- [ ] Gate técnico.
- [ ] Gate funcional.
- [ ] Gate visual.
- [ ] Gate de datos.
- [ ] Gate de seguridad.
- [ ] Gate de rollback.
- [ ] Migración definitiva.
- [ ] Verificación posterior al despliegue.
