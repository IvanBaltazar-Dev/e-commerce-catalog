# Importación de catálogo desde XLSX

El cargador está en `/admin/importaciones`, se muestra únicamente al rol `developer` y además requiere `ENABLE_CATALOG_IMPORTS=true` en el servidor. El mismo control se aplica nuevamente en la página y en los endpoints de plantilla, previsualización y confirmación.

## Formato admitido

Solo se acepta `.xlsx` de hasta 8 MB. No se admiten `.xls`, `.xlsm` ni `.xlsb`. La plantilla oficial es `assets/import/plantilla_importacion_productos.xlsx` y también se descarga desde la pantalla del cargador.

Las filas se procesan únicamente cuando `importar=TRUE`; todos los ejemplos entregados usan `FALSE` para impedir cargas accidentales.

Hojas y encabezados exactos:

- `Productos`: `importar, product_code, slug, template_code, category_path, brand_slug, product_line_slug, name, short_description, description, editorial_status, is_active, is_featured, wholesale_mixing_policy`
- `Tonos`: `importar, brand_slug, product_line_slug, tone_code, tone_name, color_family_value, reference_color, is_active`
- `Variantes`: `importar, product_code, sku, name, variant_key, tone_code, availability, is_default, is_active, sort_order, retail_price_pen, wholesale_price_pen, wholesale_minimum, media_path`
- `Atributos_producto`: `importar, product_code, attribute_code, option_value, value_text, value_number, value_boolean, value_date, value_json`
- `Atributos_variante`: `importar, sku, attribute_code, option_value, tone_code, value_text, value_number, value_boolean, value_date, value_json`
- `Medios`: `importar, product_code, sku, role, path, mime_type, alt_text, sort_order, is_primary`
- `Relaciones`: `importar, source_product_code, target_product_code, relation_type, compatibility_status, notes, sort_order`

Las hojas `LEEME`, `Catalogos`, `Opciones_atributo`, `Plantillas_atributos` y `Control` son guías; el contrato de datos son las siete hojas anteriores.

## Líneas de producto que todavía no existen

No se agrega una columna especial ni se codifica una línea concreta en la aplicación. En `Productos`, cada fila sigue indicando:

- `brand_slug`: slug de una marca que ya existe.
- `product_line_slug`: slug deseado para la línea, en minúsculas y con guiones; por ejemplo `tradicional`, `gel-color` o `cuidado-unas`.
- `template_code`: familia o plantilla a la que debe asociarse esa línea.

Si la combinación `brand_slug + product_line_slug` no existe, la previsualización la agrupa como una sola propuesta. La aplicación genera un nombre legible a partir del slug, muestra la marca y las familias involucradas, y permite al developer editar el nombre. En esta etapa no escribe nada.

Para aprobar una importación con líneas propuestas se debe escribir `AUTORIZAR E IMPORTAR`. El servidor vuelve a analizar el mismo XLSX y solo crea las líneas cuyo slug, marca y nombre hayan sido autorizados exactamente. Después las asocia a todas las `template_code` requeridas y revalida tonos y productos. Una marca inexistente continúa siendo un error: crear marcas automáticamente queda fuera del alcance de una importación de productos.

Las definiciones de atributos tampoco se crean desde un XLSX arbitrario. Deben formar parte de la plantilla configurada en la base para evitar que un archivo cargado altere silenciosamente el modelo del catálogo. La familia `ESMALTE_TONOS` incluye los datos generales, acabados y agrupaciones por tono usados por el lote Masglo, además de valores JSON tipados para pares fotocromáticos. Otras familias se configuran de la misma manera mediante la estructura del catálogo y no mediante reglas codificadas para una marca o línea.

## Paquete de medios ZIP

La misma pantalla permite cargar previamente un `.zip` de hasta 32 MB. El ZIP se inspecciona en el servidor antes de escribir y debe cumplir estas reglas:

- Los medios deben estar dentro de `productos/` y usar segmentos de ruta tipo slug (`A-Z`, `a-z`, números, punto, guion o guion bajo).
- Solo se extraen y suben `.webp` y `.pdf`; su firma y estructura se comprueban contra la extensión. Los WebP con dimensiones o cantidad de píxeles excesivas también se bloquean.
- `MANIFIESTO_IMAGENES.csv` y `README_CARGA.txt` pueden estar en la raíz, pero se ignoran y nunca se almacenan.
- Cualquier otro tipo de archivo bloquea el paquete completo. También se bloquean cifrado, rutas absolutas o con `..`, enlaces simbólicos, entradas duplicadas sin distinguir mayúsculas, métodos de compresión no admitidos, tamaños falsos y relaciones de compresión sospechosas.
- Los PDF con JavaScript, acciones automáticas, formularios, adjuntos, contenido enriquecido, cifrado u object streams se rechazan.
- Ningún objeto existente se sobrescribe. La previsualización informa cuántos medios son nuevos y cuántos ya están disponibles.

Al confirmar con `SUBIR MEDIOS`, el servidor vuelve a inspeccionar el mismo ZIP, compara su SHA-256, sube solo los objetos faltantes y registra el lote en `import_batches` como `catalog_media_zip`. Si una subida falla, elimina los objetos que alcanzó a crear. El ZIP original no se conserva.

Ejemplo de estructura:

```text
MANIFIESTO_IMAGENES.csv
README_CARGA.txt
productos/MAS-TRA-135/main.webp
productos/MAS-TRA-135/carta-colores.webp
productos/MAS-TRA-135/carta-colores.pdf
productos/MAS-TRA-135/tonos/abrumadora.webp
```

## Referencias de medios en el XLSX

El XLSX nunca contiene binarios. `path` y `media_path` deben ser rutas seguras que ya existan en el bucket `catalog-assets`. La previsualización comprueba su existencia. Se admiten JPEG, PNG, WebP, GIF y PDF; esto evita usar objetos OLE o archivos embebidos dentro del libro.

Para una imagen ligada a un SKU, la fila de `Medios` puede usar `role=main` o `role=swatch`; ambos se normalizan como el medio principal de esa variante. Los demás roles se reservan para medios del producto.

## Flujo

1. Descargar y completar la plantilla.
2. Seleccionar el ZIP de medios, inspeccionarlo y confirmar con `SUBIR MEDIOS`. Si los medios ya existen, se puede omitir este paso; el XLSX comprobará cada ruta nuevamente.
3. Seleccionar el XLSX y ejecutar la previsualización.
4. Corregir todos los errores; las advertencias no bloquean.
5. Si aparecen líneas propuestas, revisar sus nombres y escribir `AUTORIZAR E IMPORTAR`. Si no hay cambios de estructura, escribir `IMPORTAR`.

El servidor vuelve a leer el archivo, compara el SHA-256 con la previsualización, revalida el lote, crea las líneas autorizadas, tonos, productos y relaciones, y guarda auditoría normalizada. El XLSX original no se persiste. Si una operación falla, elimina las líneas, asociaciones, productos, relaciones, reglas, tonos y opciones que hayan quedado parciales.

## Controles de seguridad

El analizador inspecciona primero el contenedor ZIP/OOXML y bloquea cifrado, macros/VBA, macro sheets, ActiveX, OLE, objetos embebidos, conexiones, consultas, enlaces externos, fórmulas, hipervínculos, instrucciones XML, rutas internas inseguras, métodos de compresión no admitidos y bombas ZIP. También limita entradas, tamaño por entrada y tamaño total descomprimido.

Para asignar el rol local:

```powershell
node scripts/grant-admin.mjs developer@ejemplo.com developer --env .env.supabase.local
```
