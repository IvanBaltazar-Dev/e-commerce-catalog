# Plan vigente — alta guiada de productos

## Objetivo único

Resolver el registro de un producto nuevo de forma práctica, sin exigir que la persona usuaria conozca categorías internas, rutas, plantillas ni el modelo de datos.

La pantalla principal de este trabajo es `/admin/productos/nuevo`. El módulo de pedidos ya implementado se conserva, pero no es el objetivo de esta etapa.

## Flujo acordado

1. Elegir una familia comercial clara: esmalte, pestaña en tira, extensión profesional, adhesivo, lámpara, torno o pulidor, máquina de corte, accesorio o repuesto.
2. Asignar internamente la categoría y plantilla adecuadas.
3. Capturar nombre, código y marca; permitir crear una marca sin abandonar el formulario.
4. Permitir una línea comercial opcional, también creada en contexto.
5. Mostrar únicamente las características correspondientes a la familia elegida.
6. Elegir o crear valores controlados y generar las variantes necesarias.
7. Guardar siempre al menos una presentación comprable, aunque el producto no tenga variantes comerciales.
8. Guardar como borrador o publicar, validando solo la información necesaria para cada estado.

### Búsqueda rápida y datos sin duplicados

- La marca es global y canónica; no se duplica por tipo de producto.
- Marca y línea se relacionan con una o varias familias. El buscador propone primero las pertinentes y solo busca fuera de la familia cuando la persona escribe.
- Existe una única opción `Genérica / sin marca`, disponible para todas las familias.
- Los resultados de marca y línea se limitan a ocho por búsqueda.
- Los tonos de esmalte pertenecen a una marca y, cuando corresponde, a una línea.
- El selector de tonos permite buscar por nombre o código, filtrar por familia cromática y muestra como máximo doce resultados.
- Un tono nuevo registra nombre, código, familia cromática y color de referencia; al generar variantes también conserva esa relación normalizada.

## Soporte de base de datos

- El núcleo V2 conserva productos, variantes, atributos tipados, precios, disponibilidad, medios y relaciones.
- `product_lines` modela líneas comerciales por marca.
- `brand_product_families` y `product_line_product_families` permiten reutilizar una misma marca o línea en varias familias sin duplicarla.
- `color_shades` modela la biblioteca de tonos por marca/línea y se enlaza con la variante exacta.
- Ocho plantillas de alta cubren las familias del primer preview.
- La categoría y la plantilla se resuelven por el tipo elegido; no se solicitan como datos manuales.
- Marcas, líneas y opciones controladas se pueden ampliar desde el formulario.
- Todo producto se crea mediante el flujo atómico y queda con una variante predeterminada activa.

## Fuera de alcance inmediato

- diseño visual definitivo;
- editor técnico general de taxonomías;
- importador masivo visual desde Excel;
- conciliación automática de imágenes;
- retiro de columnas V1 o despliegue remoto.

## Criterio de aceptación

Una persona puede registrar, por ejemplo, un esmalte Admiss sin saber qué significa una ruta o una plantilla: elige “Esmalte”, selecciona la marca, busca o crea sus tonos y guarda el producto. La base conserva por debajo la categoría, plantilla, familia cromática y variantes correctas.

La implementación técnica se documenta en [docs/CATALOG_V2_IMPLEMENTATION.md](docs/CATALOG_V2_IMPLEMENTATION.md).
