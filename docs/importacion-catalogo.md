# Importación y carga masiva de catálogo

Este es el contrato operativo único para XLSX, ZIP de medios y el listado crudo de 1.500 filas. Toda ingesta pasa por staging; ningún archivo escribe directamente en el catálogo canónico.

## Acceso y seguridad

- La superficie es `/admin/importaciones`.
- Requiere rol `developer` y `ENABLE_CATALOG_IMPORTS=true`, comprobados en página y API.
- XLSX curado: solo `.xlsx`, máximo 8 MB.
- ZIP de medios: máximo 32 MB, sin cifrado, enlaces, rutas absolutas, `..`, duplicados por mayúsculas ni tamaños incoherentes.
- Los medios admitidos son WebP y PDF con firma validada; viven bajo `productos/`.
- La previsualización no escribe. Las creaciones propuestas requieren confirmación explícita y el servidor vuelve a analizar el mismo archivo.
- Las marcas y definiciones de atributos no se crean silenciosamente desde un XLSX arbitrario.

## Dos entradas, un solo staging

### Plantilla curada

La plantilla oficial es `assets/import/plantilla_importacion_productos.xlsx`. Sus hojas de datos son:

- `Productos`
- `Tonos`
- `Variantes`
- `Atributos_producto`
- `Atributos_variante`
- `Medios`
- `Relaciones`

Solo se procesa una fila con `importar=TRUE`. Las hojas auxiliares son guías, no parte del contrato de escritura. El esquema exacto se valida en `src/lib/admin/catalog-import` y sus pruebas; no debe duplicarse en componentes.

### Listado crudo Bellaroshé

El listado histórico de 1.500 filas se normaliza antes de entrar al mismo staging. Cada fila conserva `raw_data` literal y genera `normalized_data` con clasificación, identidad, nombre, agrupamiento, atributos, tono, proveedor, medios, acción propuesta y razones de revisión.

La escalera de identidad es:

1. código interno;
2. proveedor + código de proveedor, excluyendo `S/C`;
3. marca + nombre base + presentación;
4. atributos comerciales;
5. descripción normalizada como señal secundaria.

Una contradicción de marca, presentación, códigos o atributos obliga a revisión. Compartir descripción nunca autoriza una fusión automática.

## Producto, variante y proveedor

- El código interno del Excel identifica la unidad vendible y, cuando existe, se usa como SKU.
- El producto recibe una clave determinista de marca, familia y nombre base.
- Filas que solo difieren en un eje declarado se agrupan como variantes.
- Un mismo artículo comprado a dos proveedores crea ofertas separadas, no dos productos.
- `product_suppliers` conserva SKU de proveedor, preferencia y condiciones; los acuerdos de costo viven aparte.
- Una fila committed es el ancla final de idempotencia y no se vuelve a importar aunque cambie el agrupador.

## Medios

La convención estable es:

```text
productos/<PRODUCT_CODE>/main.webp
productos/<PRODUCT_CODE>/tonos/<tono>.webp
productos/<PRODUCT_CODE>/carta-colores.webp|pdf
```

La conciliación clasifica `exact`, `high`, `review`, `missing` o `color_fallback`. Solo `exact` y `high` pueden avanzar sin decisión individual. `missing` no bloquea el catálogo y queda como deuda; `color_fallback` exige un tono conocido y nunca toma la foto de otra variante. Los hashes impiden duplicar activos.

## Estados y commit

El lote recorre `uploaded → parsing → normalized → needs_review → approved → committed|failed`. `import_rows` conserva la fila, propuesta, decisión y objetivos; `import_issues` conserva severidad y resolución.

El commit trabaja por clúster de producto y utiliza los mismos contratos de producto, tono, proveedor y medios que el panel. Debe ser:

- transaccional por clúster;
- idempotente por fila, código, SKU y checksum;
- reanudable tras un fallo;
- auditable hasta la fila original;
- incapaz de desactivar constraints para “hacer pasar” un lote.

## Runbook

```bash
# Gate unitario/seguro del formato
npm run test:catalog-import-xlsx
npm run test:catalog-media-zip
npm run test:catalog-import-flow
npm run test:catalog-import-access

# Carga por lote del listado real
npm run bulk:lote -- --lote <n> --familias "A;B" --stage
npm run bulk:lote -- --lote <n> --familias "A;B" --approve
npm run bulk:lote -- --lote <n> --familias "A;B" --commit
npm run bulk:lote -- --lote <n> --familias "A;B" --second-pass
npm run bulk:lote -- --lote <n> --familias "A;B" --media-sync
```

Cada lote debe producir filas procesadas, productos nuevos/reutilizados, variantes, duplicados evitados, medios por estado, faltantes, rechazos, issues y duración. Cada issue enlaza al dato fuente.

## Corte histórico de la carga local

Al cerrar la carga del 9 de agosto de 2026:

- las 1.500 filas tenían resultado explícito;
- 1.432 filas únicas quedaron importadas, 67 en decisión de la dueña y 1 duplicado puro omitido;
- el segundo pase no creó duplicados;
- la deuda de imágenes quedó explícita, no inventada;
- staging y producción seguían pendientes de credenciales y gates.

El estado vigente debe leerse desde los lotes y reportes de la base. Este corte demuestra el proceso, no reemplaza una consulta actual.

## Criterio de salida

Un lote está terminado cuando reconstruye su trazabilidad, no duplica en un segundo pase, deja todas las excepciones visibles, concilia medios sin sustituciones falsas y supera pruebas, seguridad y verificación de integridad. Publicar productos es una decisión editorial posterior e independiente.
