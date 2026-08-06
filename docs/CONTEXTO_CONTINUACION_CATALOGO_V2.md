# Bellaroshe Catálogo V2 · Contexto para continuar en otra ventana

**Actualizado:** 21 de julio de 2026  
**Repositorio:** `D:\init\e-commerce-catalog`  
**Rama actual:** `feature/product-data-modeling`  
**Estado:** flujo de pedidos corregido; pendiente de validación visual del usuario  
**Producción/remoto:** no modificado

## 1. Instrucción esencial para la siguiente ventana

Continuar desde el estado actual. No rediseñar ni rehacer la implementación desde cero, no descartar cambios existentes y no ejecutar `supabase db push`, seeds ni scripts contra un proyecto remoto.

Antes de actuar:

1. Leer este documento completo.
2. Leer [`CATALOG_V2_IMPLEMENTATION.md`](./CATALOG_V2_IMPLEMENTATION.md), que es la documentación técnica canónica.
3. Ejecutar `git status --short` y conservar todos los cambios existentes del usuario.
4. Usar exclusivamente Supabase local (`127.0.0.1:54321` o `localhost:54321`).

## 2. Alcance que ya fue incorporado

Se implementó el Catálogo V2 de forma aditiva sobre el modelo V1:

- categorías jerárquicas;
- plantillas y atributos tipados;
- productos con una variante predeterminada obligatoria;
- variantes combinatorias y manuales;
- precios minoristas y mayoristas con vigencia;
- disponibilidad `available`, `sold_out` y `consult`;
- medios de producto o variante con propiedad XOR;
- relaciones de compatibilidad, repuesto, accesorio y recomendación;
- estados editoriales separados de la activación operativa;
- staging y trazabilidad para importaciones;
- contratos SQL públicos para listado, detalle, carrito y precios;
- catálogo público paginado y filtrado en PostgreSQL;
- carrito identificado por `variantId + purchaseMode`;
- evaluación canónica del carrito y generación de WhatsApp en servidor;
- panel funcional para pedidos, productos y variantes; la estructura técnica queda fuera de la navegación diaria;
- registro administrativo de pedidos con recálculo canónico, historial y estados;
- exportación PDF V2 con consultas agrupadas;
- backfill controlado desde V1;
- RLS, constraints, índices y pruebas automatizadas.

La interfaz administrativa y pública es funcional y de baja fidelidad. El acabado visual definitivo no fue parte de esta etapa.

## 3. Archivos y áreas principales

### Base de datos

- `supabase/migrations/0001_initial_catalog_backend.sql`
- `supabase/migrations/0002_columns_and_grants.sql`
- `supabase/migrations/0004_harden_product_image_read_policy.sql`
- `supabase/migrations/0005_catalog_v2.sql`
- `supabase/migrations/0006_catalog_v2_contracts.sql`
- `supabase/migrations/0007_admin_orders.sql`
- `supabase/seeds/0002_v2_demo.sql`
- `supabase/tests/`

Las migraciones históricas `0001`, `0002` y `0004` fueron restauradas para coincidir exactamente con `origin/main`. La V2 empieza en `0005`; no modificar la historia anterior para añadir funcionalidad nueva.

### Contratos y aplicación pública

- `src/lib/catalog/contracts.ts`
- `src/app/api/catalog/`
- `src/lib/public/catalog.ts`
- `src/components/public/HomeView.tsx`
- `src/components/public/ProductView.tsx`
- `src/components/public/SelectionProvider.tsx`
- `src/components/public/SelectionView.tsx`

### Administración

- `src/app/admin/(panel)/pedidos/`
- `src/app/api/admin/orders/`
- `src/components/admin/QuickOrderView.tsx`
- `src/lib/admin/orders.ts`
- `src/lib/admin/catalog-v2.ts`
- `src/lib/admin/catalog-v2-service.ts`
- `src/app/api/admin/catalog-v2/`
- `src/components/admin/CatalogV2Structure.tsx`
- `src/components/admin/CatalogV2ProductForm.tsx`
- `src/app/admin/(panel)/estructura/`

### PDF y pruebas de integración

- `src/app/api/admin/pdf/generate/route.ts`
- `src/lib/catalog/pdf-html.ts`
- `scripts/test-v1-backfill.ps1`
- `scripts/test-v2-contracts.mjs`
- `scripts/test-v2-admin-flow.mjs`
- `scripts/test-v2-scale.mjs`
- `scripts/cleanup-v2-test-data.mjs`

## 4. Reglas de arquitectura que no deben romperse

- Todo producto operativo debe tener exactamente una variante predeterminada activa.
- Todo pedido administrativo debe guardarse mediante `create_admin_order`, después de recalcular precios y disponibilidad.
- El alta debe usar `create_product_with_default_variant`; ningún endpoint debe crear un producto sin variante.
- `replace_default_variant` solo puede seleccionar una variante activa del mismo producto.
- La lectura pública exige `products.is_active = true` y `editorial_status = 'published'`.
- Un artículo en modo `consult` no recibe un precio inventado.
- La identidad de una línea del carrito es `variantId + purchaseMode`.
- Antes de WhatsApp se recalculan precio, disponibilidad y mayorista en el servidor.
- El listado se filtra y pagina en PostgreSQL; no se deben cargar todos los productos en el navegador.
- Los medios pertenecen a producto XOR variante.
- Los rangos de vigencia de precios no se pueden superponer por variante/lista.
- Las columnas V1 se conservan hasta comprobar que ya no existen consumidores activos.
- `service_role` solo puede usarse en servidor o scripts; nunca con prefijo `NEXT_PUBLIC_`.

## 5. Seguridad del entorno

Existen, están ignorados por Git y apuntan al entorno local:

- `.env.local`
- `.env.supabase.local`

También existe `.env.remote.example`, sin secretos, solo como documentación. Los scripts administrativos bloquean destinos no locales. No cambiar esta protección.

Para remoto se exigirían simultáneamente `--allow-remote` y `--confirm-project=<PROJECT_REF>`, pero **no están autorizados para esta entrega**.

## 6. Seeds demostrativos

El reset local deja cinco productos públicos de ejemplo:

- esmalte;
- extensiones;
- torno en modalidad consulta;
- repuesto;
- accesorio.

Las rutas `demo/*` son placeholders de Supabase Storage. Se modelaron las asociaciones, pero no se cargaron binarios reales de imágenes o documentos.

## 7. Validaciones ya realizadas

Al cierre de la implementación se ejecutaron correctamente:

- `npx supabase db reset --local`;
- `npx supabase test db --local`: 23 pruebas pgTAP aprobadas;
- `npm run test:contracts`: aprobado, con 5 productos públicos tras limpieza;
- `npm run test:backfill`: aprobado con 8 fixtures V1 y restauración posterior de V2;
- `npm run test:admin-flow`: aprobado nuevamente el 21 de julio de 2026 con login real local, alta atómica, dos variantes, publicación, UI pública, carrito, mayorista, pedido administrativo, historial, redirección de `/admin/estructura` y PDF;
- `npm run test:scale`: aprobado con 1,505 productos temporales, 16 páginas y 867 ms para la página final en el entorno de referencia;
- `npm run test:cleanup`: terminó con 0 productos y 0 usuarios temporales de prueba;
- `npm run typecheck`;
- `npm run lint`, sin advertencias;
- `npm run build`;
- `git diff --check`, sin errores (solo avisos de fin de línea);
- migración local `0007_admin_orders.sql` aplicada correctamente;
- revisión visual automatizada de `/admin/pedidos` en 1440 px y 390 px, sin desbordamiento horizontal.

Estos son resultados registrados al cierre anterior; la nueva ventana puede repetirlos si necesita verificar cambios adicionales.

## 8. Cómo levantar y probar desde terminal

Desde PowerShell:

```powershell
Set-Location "D:\init\e-commerce-catalog"
npm install
npx supabase start
npx supabase status
npm run db:reset:local
```

Pruebas de base, contratos y código:

```powershell
npm run typecheck
npm run lint
npm run test:db
npm run test:contracts
npm run test:backfill
npm run test:scale
```

Para el flujo autenticado, usar dos terminales. Terminal A:

```powershell
Set-Location "D:\init\e-commerce-catalog"
npm run dev
```

Terminal B, cuando Next.js ya responda:

```powershell
Set-Location "D:\init\e-commerce-catalog"
npm run test:admin-flow
```

El flujo usa un usuario local descartable y puede emplear Microsoft Edge instalado en:

```text
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

Al terminar:

```powershell
npm run test:cleanup
npm run build
npx supabase migration list --local
npx supabase stop
```

Notas:

- `test:backfill` reconstruye temporalmente la historia V1 y en su bloque de limpieza restaura V2.
- `test:scale` crea 1,505 registros temporales y luego los elimina.
- No ejecutar pruebas de integración en paralelo contra la misma base local porque varias reconstruyen o limpian datos.

## 9. Estado actual de Git

- Rama: `feature/product-data-modeling`.
- Commit base observado: `4afd01b chore: consolidate initial database migration`.
- El árbol de trabajo está deliberadamente sucio: hay decenas de archivos modificados y nuevos correspondientes a la implementación V2.
- No se hizo `git add`, commit, push, pull request ni despliegue.
- No usar `git reset --hard`, `git checkout --`, limpieza masiva ni comandos equivalentes: podrían borrar el trabajo pendiente.

El hecho de que Git muestre migraciones históricas como modificadas o nuevas depende del estado de la rama base; su contenido fue comparado con `origin/main` y coincidía al cerrar la implementación.

## 10. Pendientes de decisión o revisión

No son fallos bloqueantes del prototipo, pero deben revisarse antes de producción:

1. Validar con negocio los nombres definitivos de categorías, plantillas, atributos y opciones.
2. Cargar y comprobar archivos reales de imágenes, cartas de colores y fichas PDF en Storage.
3. Hacer revisión visual manual en escritorio y móvil.
4. Confirmar respaldo, ventana de despliegue y auditoría formal de RLS.
5. Verificar que no quede ningún consumidor de columnas V1.
6. Diseñar después, en una migración separada, la retirada de columnas V1; no hacerlo en esta entrega.
7. Definir explícitamente si se aprueba commit, push y despliegue. Ninguna de esas acciones está autorizada todavía.

## 11. Incidencias técnicas ya resueltas

- El backfill tuvo un fallo transitorio de Docker durante un reset; al repetirlo sin el servidor de desarrollo activo pasó correctamente.
- La publicación de 1,505 productos en una sola sentencia excedía el timeout; la prueba ahora publica en lotes de 100.
- La limpieza de escala se ajustó a lotes por el límite predeterminado de 1,000 filas de PostgREST.
- La limpieza administrativa ahora elimina primero reglas mayoristas y relaciones dependientes.
- Puppeteer no tenía Chromium propio disponible; la aplicación y la prueba incorporan fallback a Edge/Chrome local.

## 12. Mensaje sugerido para abrir la nueva ventana

```text
Continúa el trabajo de Bellaroshe Catálogo V2 en D:\init\e-commerce-catalog.
Lee primero docs/CONTEXTO_CONTINUACION_CATALOGO_V2.md y
docs/CATALOG_V2_IMPLEMENTATION.md. Conserva todo el árbol de trabajo actual,
trabaja solo con Supabase local y no hagas commit, push ni despliegue sin mi
autorización. Antes de cambiar código, revisa git status y dime qué acción
propones según los pendientes documentados.
```
