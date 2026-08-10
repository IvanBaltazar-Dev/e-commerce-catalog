-- ---------------------------------------------------------------------------
-- 0082 · Se retiran las proyecciones que vivían dentro de las tablas de negocio
-- ---------------------------------------------------------------------------
-- Última migración de la secuencia que empezó en 0072. Aquí no se añade nada:
-- se quita lo que 0078-0081 dejaron sin consumidores.
--
-- POR QUÉ VA APARTE Y NO DENTRO DE 0078. Porque una migración que crea lo nuevo
-- Y borra lo viejo en el mismo paso no se puede verificar: si algo falla, no se
-- sabe si falló lo nuevo o faltaba lo viejo. Primero se construyó, se rellenó,
-- se comparó viejo contra nuevo, se cambiaron los lectores y se midió. Solo con
-- eso en verde se retira.
--
-- LO COMPROBADO ANTES DE ESCRIBIR ESTO:
--
--   · Cero funciones leen `product_variants.search_document`. `inventory_board`
--     era el último consumidor y 0080 lo pasó a la proyección.
--   · Cero funciones leen `products.starting_price`. `catalog_list_v2` lee
--     `product_catalog_projection.starting_price` desde 0079.
--   · Cero referencias en `src/`.
--   · Las funciones de disparador viejas solo se llaman entre ellas: caen todas
--     juntas o ninguna.
--
-- LO QUE NO SE RETIRA, Y POR QUÉ:
--
--   · `products.search_text` y `persons.search_document` son columnas
--     GENERADAS. No cuestan una escritura aparte —PostgreSQL las calcula al
--     escribir la fila— así que no arrastran disparadores y no tienen el
--     problema que esta secuencia vino a corregir. Además `search_text` es lo
--     que va a servir la lista de productos del admin cuando se lleve a
--     contrato.
--   · Los disparadores de `catalog_facet_presence` (0076) siguen: esa
--     proyección ya estaba fuera de las tablas de negocio desde que nació.
--
-- UNA CONSECUENCIA QUE CONVIENE TENER PRESENTE. La rama de términos cortos de
-- 0077 permitía además coincidencia exacta de MARCA, y eso se pierde aquí: los
-- códigos de `variant_search_codes` son sku, internal_code, barcode, shade_code
-- y supplier_code. Recuperarlo, si se quiere, es añadir un `code_type` — no una
-- rama OR. Se deja fuera a propósito: con dos letras, un prefijo de marca
-- devuelve demasiadas marcas para ser útil.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. Los disparadores que mantenían el documento dentro de product_variants
-- ---------------------------------------------------------------------------
drop trigger if exists product_variants_refresh_search on public.product_variants;
drop trigger if exists product_variants_refresh_search_upd on public.product_variants;
drop trigger if exists products_refresh_variant_search on public.products;
drop trigger if exists brands_refresh_variant_search on public.brands;
drop trigger if exists color_shades_refresh_variant_search on public.color_shades;
drop trigger if exists product_lines_refresh_variant_search on public.product_lines;
drop trigger if exists variant_values_refresh_search_ins on public.variant_attribute_values;
drop trigger if exists variant_values_refresh_search_upd on public.variant_attribute_values;
drop trigger if exists variant_values_refresh_search_del on public.variant_attribute_values;
drop trigger if exists attribute_options_refresh_variant_search on public.attribute_options;

-- ---------------------------------------------------------------------------
-- 2. Los que recalculaban el precio dentro de products
-- ---------------------------------------------------------------------------
drop trigger if exists variant_prices_refresh_starting_price_ins on public.variant_prices;
drop trigger if exists variant_prices_refresh_starting_price_upd on public.variant_prices;
drop trigger if exists variant_prices_refresh_starting_price_del on public.variant_prices;
drop trigger if exists product_variants_refresh_starting_price_ins on public.product_variants;
drop trigger if exists product_variants_refresh_starting_price_upd on public.product_variants;
drop trigger if exists product_variants_refresh_starting_price_del on public.product_variants;

-- ---------------------------------------------------------------------------
-- 3. Sus funciones
-- ---------------------------------------------------------------------------
drop function if exists public.trg_refresh_variants_from_variants_ins();
drop function if exists public.trg_refresh_variants_from_variants();
drop function if exists public.trg_refresh_variants_from_products();
drop function if exists public.trg_refresh_variants_from_brands();
drop function if exists public.trg_refresh_variants_from_shades();
drop function if exists public.trg_refresh_variants_from_lines();
drop function if exists public.trg_refresh_variants_from_values();
drop function if exists public.trg_refresh_variants_from_options();
drop function if exists public.trg_starting_price_from_prices();
drop function if exists public.trg_starting_price_from_variants();

drop function if exists public.refresh_variant_search_documents(uuid[]);
drop function if exists public.rebuild_variant_search_documents();
drop function if exists public.refresh_product_starting_price(uuid[]);
drop function if exists public.rebuild_product_starting_prices();

-- La definición del documento vive ahora en `variant_search_parts`, partida en
-- lo del producto y lo de la variante para no repetir 164 veces lo mismo.
drop view if exists public.variant_search_source;

-- ---------------------------------------------------------------------------
-- 4. Las columnas. Sus índices caen con ellas.
-- ---------------------------------------------------------------------------
alter table public.product_variants drop column if exists search_document;
alter table public.products drop column if exists starting_price;

-- ---------------------------------------------------------------------------
-- 5. Los índices de prefijo que sustituye `variant_search_codes_prefix_idx`
-- ---------------------------------------------------------------------------
-- Cinco índices sobre cinco expresiones de cuatro tablas, que era el patrón
-- que hacía imposible que el planificador los combinara. Ahora los códigos son
-- filas de una sola tabla y basta UN índice.
drop index if exists public.product_variants_sku_prefix_idx;
drop index if exists public.product_variants_barcode_prefix_idx;
drop index if exists public.products_code_prefix_idx;
drop index if exists public.color_shades_code_prefix_idx;
drop index if exists public.brands_name_exact_idx;

commit;

analyze public.product_variants;
analyze public.products;
