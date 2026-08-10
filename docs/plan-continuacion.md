# Plan de continuación — circuito de venta

Estado al cierre de la sesión del **2026-08-10**. Este documento existe para que
la siguiente sesión no tenga que reconstruir el contexto ni repetir lo hecho.

Lo primero, porque condiciona todo lo demás: **nada de esto está commiteado.**

---

## 0. Lo primero que hay que decidir: el commit

```
último commit:  494d8ee  feat(pos): la carta de 164 tonos se abre…
sin commitear:  69 ficheros · 19 migraciones (0051–0069)
```

Las migraciones **0051 a 0069 están aplicadas solo en la base local** y sus
ficheros están sin versionar. El registro de migraciones se rellenó **a mano**
(`insert into supabase_migrations.schema_migrations`) porque se aplicaron con
`psql -f`, no con `supabase db push`.

Consecuencias que hay que tener presentes:

- ~~Un `supabase db reset --local` reconstruye desde los ficheros.~~ **Comprobado
  el 2026-08-10: no reconstruía.** Dos defectos, los dos corregidos; el detalle
  en 2.1. Ahora sí reconstruye y los tres gates quedan en verde desde cero. El
  bloque sin versionar pasa de 0051–0069 a **0051–0071**, con
  `0049_inventory_board` renombrada a `0070`.
- Nada se ha aplicado a staging ni a producción. Los agujeros de seguridad que se
  corrigieron en esta sesión nunca llegaron a salir de local.

**Antes de tocar nada nuevo**, decidir con Ivan si se commitea el bloque entero
(recomendado: un commit por bloque temático, no uno de 69 ficheros) o si se
revisa antes.

---

## 1. Lo que está hecho y verificado

No hace falta rehacerlo. Cada punto tiene su prueba.

| Bloque | Qué quedó | Dónde se comprueba |
|---|---|---|
| Roles de la venta | compradora ≠ destinataria ≠ quien recoge ≠ receptor fiscal, cada uno con su documento | `0060`, `0061`, `9000_combinaciones_venta` |
| Requisitos de entrega | como DATOS en `fulfillment_requirements`; disparador diferido que impide cerrar una venta inentregable | `0061_sale_parties_enforcement.test.sql` |
| Contra entrega | adelanto al pedir, saldo al recibir; solo delivery y envío | `0063`, `0064` |
| Tres dimensiones | venta (`status`) · entrega (`fulfillment_status`) · cobro (`payment_terms` + saldo), independientes | `0064_fulfillment_and_advance.test.sql` |
| Saldo neto de devoluciones | `pendiente = total − devuelto − cobrado + reembolsado` | `0068_devolucion_entrega_y_comprobante.test.sql` |
| Concurrencia del cobro | candado **de la venta**; dos dispositivos no cobran dos veces | `npm run test:settle-concurrency` |
| N.º de operación | una regla en PostgreSQL, una en la app, fijadas entre sí | `0065`, `npm run test:payment-rule` |
| Impresión | ruta propia en `admin/(print)`, sin panel; logo con proporción exacta; reimprimir no escribe nada | `npm run test:sale-note` |
| Comprobante | nota / boleta / factura, requisitos como datos, sin heredar el documento de nadie | `0068`, `0069` |
| Pendientes | centro operativo con chips; cada fila ofrece su siguiente paso | verificado en pantalla |

**Gates que deben estar en verde para aprobar cualquier cosa:**

```bash
npx supabase test db --local
```

```bash
npm run audit:security
```

```bash
npm run test:venta
```

Al cierre: **676 comprobaciones pgTAP en 32 ficheros**, seguridad sin
violaciones, `typecheck` y `lint` limpios.

---

## 2. Lo pendiente, en orden

### 2.1 · Comprobar que un `db reset` reconstruye — **HECHO (2026-08-10)**

Reconstruye. Los tres gates quedaron en verde sobre una base construida desde
cero: **676 comprobaciones pgTAP en 32 ficheros**, `audit:security` sin
violaciones, y las cuatro pruebas de `test:venta`. El catálogo de trabajo se
volcó antes a `backups/pre-reset-20260810-0359-completo.sql` (76 MB, 135 tablas,
191 funciones).

**No reconstruía. Aparecieron dos defectos, los dos anteriores a este bloque.**

**a) Dos migraciones compartían el número `0049`.** `0049_bulk_catalog_families`
y `0049_inventory_board`, ambas ya commiteadas. Como `schema_migrations.version`
es clave primaria, al grabar la segunda el reset moría con `duplicate key`. En la
base local no se vio porque el registro se rellenó a mano: `inventory_board`
estaba aplicada pero **invisible para el registro**.

Corregido renombrándola a `0070_inventory_board.sql`. Nada en 0050–0069 la
referencia, así que moverla al final no rompe el orden. **No existe ningún nombre
que ordene entre `0049_` y `0050_`**: la CLI ordena por nombre de fichero y en
ASCII cualquier dígito va antes que `_`, así que `00495_` quedaría *antes* que
`0049_`; y un sufijo de letra (`0049a_`) la CLI lo salta en silencio.

**b) Una migración dependía de un seed.** 0049 declara 42 pares
plantilla↔atributo, y uno —`PRESS_ON_DECORADO`/`shape`— nunca se escribía: el
atributo `shape` no lo creaba ninguna migración, lo creaba
`supabase/seeds/0002_v2_demo.sql`, que corre **después** de todas las
migraciones. El `join` interno descartaba la fila sin ruido.

Corregido con `0071_press_on_shape_axis.sql`, que promueve `shape` a eje del
catálogo —como 0011 hace con `tone` y 0015 con `voltage`— y escribe la
asociación que faltaba. Comprobados los 42 pares, no solo los 6 que muestrea la
prueba: era el único que caía.

**La regla que sale de aquí:** una migración no puede depender de un seed. El
seed es opcional —producción no lo corre— así que todo lo que una migración
necesite tiene que haberlo creado otra migración.

**Lo que sigue sin comprobarse:** que el reset sea *reentrante* (dos corridas
seguidas). `gate:rebuild` existe para eso y pide el servidor en 3002.

**Estado de la base local tras todo esto.** El catálogo se restauró del volcado
—1 056 productos, 1 578 variantes, 185 marcas, 253 tonos, 64 categorías, 69
proveedores— **sin las ventas**: `sales`, `sale_lines`, cobros, caja y kardex
están a cero a propósito. Consecuencia a tener presente: **1 539 variantes no
siguen inventario y ninguna tiene existencia**; solo las 3 presentaciones que
siembra `seed:demo-operation` se pueden vender. Si hace falta stock para probar
algo, se carga con `load_initial_inventory`, nunca con un `UPDATE`.

Se restauró también la configuración que siembran las migraciones y que un
`truncate` se lleva por delante sin que nada la reponga: `fulfillment_requirements`
(0061), `tax_document_requirements` (0068), `branches`, `channels`,
`marketing_sources`, `expense_categories` y `template_attribute_comparisons`. Es
la trampa de restaurar por tablas: el catálogo solo no basta, porque las reglas
que viven como datos se van con él.

### 2.2 · RNF-1 · Ninguna búsqueda pasa de 3 segundos

La regla está escrita en [requisitos-no-funcionales.md](requisitos-no-funcionales.md).
Falta implementarla. **Es lo más importante de la lista.**

**El diagnóstico, confirmado columna a columna el 2026-08-10.** Era correcto:
`pos_variant_search` hace **diez comparaciones `lower(columna) LIKE '%término%'`
sobre diez columnas de cinco tablas** — `products` (name, code, presentation),
`brands` (name), `product_lines` (name), `color_shades` (name, code) y
`product_variants` (name, sku, barcode).

De las diez, **solo `color_shades.name`** tiene un índice usable
—`gin (lower(name) gin_trgm_ops)`—. `products.name` tiene índice trigrama pero
**sobre la columna cruda**, que el planificador no puede usar para `lower(name)`;
las otras ocho no tienen ninguno. Además siete van envueltas en
`coalesce(columna, '')`. La tabla completa está en
[requisitos-no-funcionales.md](requisitos-no-funcionales.md).

Con las 1.578 variantes actuales son 2 ms y no se nota. El requisito es 100.000.

**El trabajo, en este orden:**

1. **Una ruta de sembrado de volumen que respete el catálogo.** Es lo que faltó
   para poder medir. La inserción masiva ingenua choca contra:
   - un producto activo exige **variante predeterminada activa**;
   - publicar exige **atributos obligatorios** de la plantilla;
   - `products.wholesale_price` es `NOT NULL`.

   La vía que funciona es insertar productos **inactivos**, luego variantes con
   `variant_key` e `is_default`, luego activar. Los atributos obligatorios
   siguen bloqueando: hay que sembrarlos o usar una plantilla que no los exija.
   `scripts/perf-volume.mjs` ya siembra 1.500 productos correctamente — **partir
   de ahí y subirlo**, no escribir un sembrado nuevo desde cero.

2. **El documento de búsqueda.** Cambiar diez comparaciones sin índice por una
   con él. Precedente en el propio repo: `products.search_document` con
   `products_search_document_idx`. Falta el equivalente por variante (nombre,
   SKU, código de barras, nombre y código del tono) mantenido por disparador,
   con un GIN trigrama, y reescribir el predicado de `pos_variant_search`.

3. **`npm run gate:busqueda`.** Siembra, mide **N veces**, falla si el **peor
   caso** de cualquier superficie supera 3.000 ms, e imprime el
   `EXPLAIN (ANALYZE, BUFFERS)` de lo que falla. Cubre `pos_variant_search`,
   `pos_product_tones`, `pos_search_persons` y `catalog_list_v2`.

4. **Limpiar el volumen al terminar.** En esta sesión quedaron 12.000 productos
   a medias y hubo que borrarlos a mano. El sembrado debe llevar prefijo y
   limpiarse siempre, pase lo que pase.

### 2.3 · Los deadlocks que reporta Ivan

**No reproducidos.** Hace falta que diga dónde: qué pantalla, qué acción, y el
mensaje si sale alguno. Lo que se descartó:

- La pantalla congelada al pulsar «Boleta o factura» **era el z-index**, no un
  bloqueo: la hoja se abría detrás de la pantalla de venta registrada. Corregido.
- Los candados que introdujo esta sesión son **consultivos y por venta**
  (`pg_advisory_xact_lock` en `settle_sale_balance`), y solo se toman al cobrar
  un saldo. `register_sale` ordena las líneas por variante justamente para no
  provocar interbloqueos.

Si reaparece, mirar `pg_stat_activity` y `pg_locks` durante el episodio, y
revisar si viene del servidor de desarrollo recompilando (en dev se han visto
respuestas de 8–11 s que son compilación, no base).

### 2.4 · RNF-2 · Disponibilidad de lo cargado

Ivan: «de nada me sirve tener todo cargado si no puedo interactuar». Sin
diagnóstico todavía. Sospechas a comprobar, por orden de probabilidad:

1. La búsqueda del POS dispara una petición por pulsación sin
   *debounce* suficiente, y cada una recorre el catálogo (ver 2.2).
2. La carta de 164 tonos rerenderiza la rejilla entera al escribir.
3. El servidor de desarrollo: medir en `build` + `start`, no en `dev`.

Medir antes de tocar. La regla está escrita; falta el número.

---

## 3. Apuntado y sin desarrollar

- **`register_sale` → `p_options jsonb`.** Su firma ya se reescribió tres veces
  por añadir parámetros (0055, 0061, 0063). Hay un aviso en el código: **el
  siguiente parámetro no se añade así**, se agrupan las opciones escalares.
- **Emisión de boleta/factura.** Hoy solo se registra la *solicitud*; la emisión
  es externa. Integrar con SUNAT es un bloque aparte y hay que decidirlo antes de
  empezarlo.
- **Rediseño de la navegación del admin** (sidebar izquierdo, móvil de partida).
- **Código de entrega para recojo** (QR que la vendedora lee para marcar
  entregado). Encaja con `fulfillment_status` y con el cobro del saldo.

---

## 4. Trampas del entorno — leer antes de empezar

**Dos sesiones de Claude comparten este repo y la misma base local.** No es
teórico: durante esta sesión otra sesión modificó `SaleNoteView.tsx` (añadió
selector de papel 58/80 mm) y registró ventas que rompieron una prueba. De ahí
dos reglas:

- **Toda aserción se acota a sus propios datos.** Una huella o un conteo sobre
  una tabla entera falla por lo que hizo otro. Pasó tres veces en esta sesión.
- Antes de editar un fichero compartido, mirar si cambió.

**Otras trampas concretas:**

- Las **sedes de prueba** (`INTEGRAL`, `INTEGRAL2`) las crea `test:block2`. Ahora
  las desactiva al terminar. Si aparecen sedes en el panel, es que alguna prueba
  se interrumpió: desactivarlas.
- La **existencia demo se agota** con las pruebas. Se repone con
  `adjust_inventory` (no con un `UPDATE`, que rompería el kardex).
- Las rutas de Next dejan **tipos generados obsoletos** en `.next*/types` al mover
  un fichero; hay que borrarlos o `typecheck` falla por un fichero que ya no
  existe.
- `psql` por `docker exec` en Git Bash necesita `MSYS_NO_PATHCONV=1`, o `/tmp/x`
  se convierte en una ruta de Windows.
- **Tras un `db reset`, Kong devuelve 502 al hablar con Auth.** El reset termina
  con «Restarting containers…» y el enlace de Kong hacia el contenedor de auth
  queda rancio: `seed:demo-operation` muere con `AuthRetryableFetchError` y
  `status: 502` aunque el contenedor de auth esté `healthy` y escuchando. Se
  arregla con `docker restart supabase_kong_e-commerce-catalog` y esperar a que
  `/auth/v1/health` dé 200. Sin eso, la batería `9000_combinaciones_venta` falla
  en su precondición —«el entorno tiene una presentación con precio y
  existencia»— y parece un fallo de la base cuando es del sembrado.
- Para comprobar el reset **sin** destruir el catálogo, se puede reconstruir en
  una base desechable del mismo clúster: `create database rebuild_check`, cargar
  en ella el esquema `auth`+`storage` con `pg_dump --schema-only`, borrar las
  políticas de `storage` (las crea 0001) y aplicar las migraciones en orden con
  `ON_ERROR_STOP=1`. Detecta lo que falla sin tocar nada de trabajo.
- Los tres carriles de desarrollo son `dev` (3001), `dev:b` (3005), `dev:c`
  (3006) y `dev:d` (3007), cada uno con su `.next`. Comprobar cuál está libre.

---

## 5. Las reglas que no se negocian

Están en [requisitos-no-funcionales.md](requisitos-no-funcionales.md) y en las
memorias del proyecto. Resumidas:

1. **Toda búsqueda por debajo de 3 s en el peor caso, con 100.000 productos.**
2. **Una sola sede.** Ninguna pantalla la ofrece, la nombra ni la pide.
3. **Las reglas críticas viven en PostgreSQL**, no solo en la pantalla. Una sola
   definición por regla, consultada por el contrato y por el disparador.
4. **Una migración no está hecha** hasta que `audit:security` y pgTAP están en
   verde. El lote 0052–0060 se dio por bueno sin correrlos y tenía dos tablas sin
   RLS y cuatro funciones alcanzables con la clave anon.
5. **Una prueba que puede fallar por algo ajeno a lo que afirma** es una prueba
   que se acabará ignorando.
