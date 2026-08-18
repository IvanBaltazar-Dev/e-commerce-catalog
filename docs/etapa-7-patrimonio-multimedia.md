# Etapa 7 · El patrimonio multimedia entra al checkpoint

**Comandos:** `npm run media:export`, `npm run media:restore`,
`npm run gate:media-rebuild`, `npm run test:media-adversarial`

**Estado:** implementado y certificado adversarialmente; falta la primera
campaña real de imágenes

## Qué resuelve

El 18 de agosto de 2026, una reconstrucción desde base vacía devolvió las 158
filas de `media_assets`, devolvió los buckets… y dejó `storage.objects` vacío.
Metadatos intactos, cero bytes. El catálogo quedó sin una sola imagen y **nada
se puso en rojo**: el gate completo terminó en verde.

El checkpoint reproducía PostgreSQL y solo PostgreSQL. Desde esta etapa
reproduce el estado de Bellaroshé.

## Dónde viven los bytes

No dentro del volcado ni dentro de Git: seguirían siendo payload pesado en el
sitio equivocado, que es justo lo que el plan evita para los snapshots crudos.
Lo que se conserva es un **manifiesto verificable y una ruta recuperable**:

- los objetos se copian al almacén local de investigación, fuera de Git;
- el manifiesto declara, por objeto, `bucket`, `path`, `sha256`, `bytes`,
  `mime`, el `media_asset` asociado y el producto o variante que lo reclama.

## La verificación va en las dos direcciones

Un gate que solo compare el manifiesto contra la base diría «verde» sin abrir un
archivo. Este descarga cada objeto y compara el contenido real:

```
media_assets / manifiesto  ──►  el objeto existe y su hash coincide
objeto físico              ──►  está declarado y tiene dueño válido
```

Cuatro contadores, cada uno con sus ejemplos, y cualquiera distinto de cero
pone el gate en rojo:

| Contador | Qué significa |
|---|---|
| `mediosFantasma` | Hay metadato y no hay archivo. Es lo que pasó y no se detectó. |
| `archivosHuerfanos` | Hay archivo y nadie lo declara. |
| `hashesDivergentes` | Misma ruta, otro contenido. |
| `mediosSinDueno` | El medio no cuelga de ningún producto ni variante. |

## La huella del patrimonio

Contar archivos no basta: 172 objetos pueden ser otros 172, o los mismos
colgando de otras entidades. Por eso el gate emite una huella agregada, al mismo
nivel que las que ya existen para PostgreSQL y para el grafo, calculada sobre
`bucket`, `path`, `sha256`, `bytes`, `mime` y dueño, en orden estable.

Solo coincide si son **exactamente los mismos bytes sobre exactamente las mismas
entidades**. Que la huella no cuadre es motivo de rojo por sí solo, aunque cada
archivo esté en su sitio y cada hash cuadre.

## La certificación es adversarial

`test:media-adversarial` no comprueba que el gate diga verde sobre un patrimonio
sano. Fabrica dos objetos propios, congela su checkpoint y luego **rompe el
patrimonio de cuatro maneras distintas**, una por vez, devolviéndolo a su sitio
entre una y otra, exigiendo rojo por el motivo correcto en cada caso.

Después demuestra dos cosas más:

- que el mismo archivo colgado de **otra** variante cambia la huella, que es
  precisamente lo que el conteo no ve;
- que vaciar Storage dejando PostgreSQL intacto pone el gate en rojo, que el
  `restore` devuelve los objetos desde el almacén local, y que la huella
  resultante es **la misma** que antes de destruir.

## Lo que todavía no se puede demostrar

El ciclo completo —destruir el entorno, reconstruir PostgreSQL, restaurar
Storage y obtener la misma huella— solo queda cerrado cuando el checkpoint
incluya medios reales. Hoy el checkpoint declara 158 medios sin un solo byte
detrás: esa es la deuda que la primera campaña de imágenes viene a saldar.

## Frontera

Este gate no descarga nada. Descargar es la campaña siguiente, y el orden
acordado es explícito: **no se descarga una sola imagen hasta que el checkpoint
falle si pierde un solo objeto de Storage.** Cumplido eso, las 172 imágenes
inequívocas dejan de ser un riesgo y pasan a ser la primera campaña real de
recuperación multimedia.
