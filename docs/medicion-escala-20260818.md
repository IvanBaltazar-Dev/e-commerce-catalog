# Medición de escala · 18 de agosto de 2026

Las mediciones anteriores eran previas a las migraciones que llegan hasta 0124
y a la compuerta de necesidad. Esta corrida vuelve a certificar la escala contra
el código actual, antes de tocar imágenes.

## Búsqueda comercial · RNF-1

**Volumen sembrado:** 100.002 productos publicados, 201.571 variantes,
500.918 valores de atributo.

**Umbral:** 3.000 ms en el peor caso de cinco corridas. No la mediana: una
mediana buena no compensa un peor caso lento.

| Superficie | Peor | Mediana |
|---|---|---|
| Catálogo público · listado sin término | **1.131 ms** | 789 ms |
| Catálogo público · con tilde («lámpara») | 1.083 ms | 728 ms |
| Catálogo público · por tipo («torno») | 977 ms | 764 ms |
| Catálogo público · sin tilde («lampara») | 930 ms | 847 ms |
| Catálogo público · dos letras («ml») | 898 ms | 429 ms |
| Catálogo público · poco selectivo («esmalte») | 868 ms | 592 ms |
| Catálogo público · por color («rojo») | 760 ms | 668 ms |
| Catálogo público · muy selectivo (SKU) | 367 ms | 283 ms |
| POS · poco selectivo («esmalte») | 678 ms | 432 ms |
| POS · sin tilde («lampara») | 617 ms | 288 ms |
| POS · por tipo («torno») | 457 ms | 381 ms |
| POS · con tilde («lámpara») | 413 ms | 301 ms |
| POS · dos letras («ml») | 256 ms | 154 ms |
| POS · por color («rojo») | 246 ms | 197 ms |
| POS · por talla («mediano») | 220 ms | 137 ms |
| POS · muy selectivo (SKU) | 213 ms | 159 ms |
| POS · carta de tonos de un producto | 96 ms | 68 ms |
| Existencias · tablero con término | 50 ms | 30 ms |
| POS · buscador de clientas | 16 ms | 14 ms |

El peor caso de todo el sistema queda en **el 38 % del presupuesto**. Todas las
consultas comprobadas usan su índice.

**Semántica**, que es la otra mitad del gate y la que un índice rápido no
garantiza:

- una marca corta exacta encuentra: «ib» → 549 productos;
- un prefijo corto de SKU sigue encontrando: «vo» → 100.001;
- un fragmento corto arbitrario **no** encuentra: «ml» → 0 de 101.052;
- la tilde no cambia el resultado: «lámpara» = «lampara», 10.038 en ambos casos.

Evidencia completa en `test-results/gate-busqueda.md`.

## Disponibilidad de la interfaz

Medido contra el **build de producción**, que es como está escrito el requisito
—«una ruta autenticada no debe tardar más de tres segundos en el build de
revisión local»—. Las dieciséis rutas del panel pasan, entre **647 y 968 ms**.

Medir esto contra el servidor de desarrollo no vale: ahí se estaba midiendo la
compilación bajo demanda de Turbopack, y el resultado cambiaba de corrida en
corrida.

## Universo de Referencia

150.000 referencias sintéticas adicionales sobre el mismo volumen comercial.
Cada consulta comprobada usa el índice que se espera de ella, no uno cualquiera:

| Consulta | Tiempo | Umbral | Índice |
|---|---|---|---|
| Similitud acotada por marca | **106,13 ms** | 500 ms | `catalog_reference_products_brand_name_knn_idx` |
| Observaciones por sujeto | 0,286 ms | 100 ms | `catalog_observations_reference_variant_idx` |
| Deltas por estado | 0,137 ms | 100 ms | `catalog_reference_presence_events_delta_idx` |

La resolución exacta dentro del universo ocurre en fracciones de milisegundo; el
único caso que se acerca a su umbral es la búsqueda por similitud, y se queda en
la quinta parte.

**Contrato del grafo**, recorrido en streaming sobre el volumen completo:

- 905.306 nodos y 1.607.374 aristas;
- 45,1 s de proyección;
- **59,4 MB** de crecimiento de memoria residente.

Ese último número es el que importa: recorrer un millón y medio de aristas sin
cargarlas en memoria es lo que hace que el contrato escale. El gate retira sus
referencias sintéticas al terminar.

## Qué demuestra y qué no

Demuestra **capacidad técnica de escala**: el modelo aguanta cien mil productos
comerciales y ciento cincuenta mil referencias sin degradarse.

No demuestra que ese dataset exista. Las referencias eran sintéticas, sembradas
para certificar arquitectura y rendimiento. El conocimiento real investigado a
fondo hasta hoy es ADMISS. Llenar el Universo de Referencia con marcas reales es
trabajo posterior, y deliberadamente posterior: primero que la infraestructura
aguante, después llenarla.

## Después de medir

El volumen se conserva solo mientras dura la medición. Un `db:reset:local` y la
restauración del checkpoint devuelven el catálogo real de 1.051 productos.
