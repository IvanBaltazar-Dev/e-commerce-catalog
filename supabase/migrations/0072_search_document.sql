-- ---------------------------------------------------------------------------
-- 0072 · Un solo patrón de búsqueda: documento normalizado + índice trigrama
-- ---------------------------------------------------------------------------
-- Medido el 2026-08-10 con 100 000 productos y 201 578 variantes sembradas:
-- `catalog_list_v2` tardaba 41 s en listar la primera página, y buscar
-- «esmalte» 12,9 s. El requisito es 3 s en el peor caso.
--
-- LO QUE ESTABA MAL, Y POR QUÉ NINGÚN ÍNDICE LO ARREGLABA:
--
--   · `pos_variant_search` comparaba con `lower(columna) LIKE '%término%'` en
--     DIEZ columnas de CINCO tablas. Un índice trigrama por columna no sirve:
--     el planificador no puede combinar diez índices de tablas distintas unidas
--     por OR. Tiene que recorrerlas.
--   · Los índices que sí existían estaban sobre la columna CRUDA
--     (`products_name_trgm_idx` es `gin (name gin_trgm_ops)`), y la comparación
--     era sobre `lower(name)`. Un índice sobre una expresión distinta de la que
--     se compara es un índice que nunca se usa.
--   · `pos_search_persons` quitaba tildes con `translate(...)` y no tenía
--     ningún índice sobre esa expresión.
--   · Nadie buscaba por color, talla ni tipo, aunque el modelo ya declara qué
--     atributos son buscables (`attribute_definitions.is_searchable`).
--
-- LA FORMA DE ARREGLARLO: un documento por fila, con TODO lo que se puede
-- buscar de esa fila ya normalizado, y UN índice trigrama sobre él. Diez
-- comparaciones sobre cinco tablas pasan a ser una comparación sobre una
-- columna indexada.
--
-- POR QUÉ TRIGRAMA Y NO tsvector: `products.search_document` ya era un tsvector
-- y se queda, porque para el catálogo público buscar por palabras completas
-- está bien. En el mostrador no: quien vende teclea «esmal» y espera ver
-- «esmalte». Eso es subcadena, y subcadena en PostgreSQL es trigrama.
--
-- POR QUÉ DISPARADORES Y NO COLUMNA GENERADA: una columna generada solo puede
-- leer SU PROPIA fila. El documento de una variante necesita el nombre del
-- producto, el de la marca, el de la línea, el del tono y sus valores de
-- atributo — cinco tablas más. Donde el documento cabe en una fila (personas,
-- productos) sí es columna generada, que es más barata y no se puede desincronizar.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- 1. La normalización, en un solo sitio
-- ---------------------------------------------------------------------------
-- IMMUTABLE a propósito: es lo que permite usarla en columnas generadas y en
-- índices de expresión. Si un día deja de serlo, los índices que la usan dejan
-- de ser válidos, así que no puede depender de configuración regional ni de
-- diccionarios (por eso `translate` y no la extensión `unaccent`, cuyo
-- diccionario es configurable y por tanto no inmutable).
create or replace function public.search_normalize(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select nullif(
    btrim(regexp_replace(
      translate(lower(coalesce(p_text, '')), 'áéíóúüñàèìòùâêîôûäëïöç', 'aeiouunaeiouaeiouaeioc'),
      '\s+', ' ', 'g')),
    '');
$$;

comment on function public.search_normalize(text) is
  'Minúsculas, sin tildes y con los espacios colapsados. La ÚNICA normalización de búsqueda del sistema: si el documento y el término no pasan por aquí los dos, no se encuentran.';

revoke execute on function public.search_normalize(text) from public;
grant execute on function public.search_normalize(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Productos: documento de una sola fila → columna generada
-- ---------------------------------------------------------------------------
-- Sustituye al `.or(name.ilike, code.ilike, product_type.ilike)` que la lista
-- del admin hacía suelta por PostgREST, sin índice y sin contrato.
alter table public.products
  add column if not exists search_text text
  generated always as (
    public.search_normalize(
      coalesce(code, '') || ' ' || coalesce(name, '') || ' ' ||
      coalesce(product_type, '') || ' ' || coalesce(presentation, '')
    )
  ) stored;

create index if not exists products_search_text_trgm_idx
  on public.products using gin (search_text public.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 3. Personas: documento de una sola fila → columna generada
-- ---------------------------------------------------------------------------
-- El teléfono y el documento entran tal cual: quien busca a una clienta teclea
-- tanto «rosa» como los últimos cuatro dígitos del celular.
alter table public.persons
  add column if not exists search_document text
  generated always as (
    public.search_normalize(
      coalesce(full_name, '') || ' ' || coalesce(phone_normalized, '') || ' ' ||
      coalesce(document_number, '')
    )
  ) stored;

create index if not exists persons_search_document_trgm_idx
  on public.persons using gin (search_document public.gin_trgm_ops);

-- ---------------------------------------------------------------------------
-- 4. Variantes: el documento que cruza cinco tablas
-- ---------------------------------------------------------------------------
alter table public.product_variants
  add column if not exists search_document text;

comment on column public.product_variants.search_document is
  'Todo lo buscable de la variante en un solo texto normalizado: producto (código, nombre, presentación, tipo), marca, línea, tono (nombre y código), variante (nombre, SKU, código de barras) y los valores de los atributos marcados is_searchable — color, talla, tono, aroma. Lo mantienen los disparadores de esta migración; no se escribe a mano.';

create index if not exists product_variants_search_document_trgm_idx
  on public.product_variants using gin (search_document public.gin_trgm_ops);

-- Para términos de uno o dos caracteres el trigrama no puede ayudar (no hay
-- trigramas que buscar), así que el SKU y el código de barras conservan su
-- búsqueda por prefijo, que sí es indexable con btree.
create index if not exists product_variants_sku_prefix_idx
  on public.product_variants (public.search_normalize(sku) text_pattern_ops)
  where sku is not null;

-- Los valores de atributo solo tenían índices que empiezan por
-- `attribute_definition_id`, pensados para filtrar por faceta. Buscar «los
-- valores de ESTA variante» —que es lo que necesita el documento— recorría las
-- 500 000 filas enteras. Es también lo que hace lenta cualquier ficha.
create index if not exists variant_attribute_values_variant_idx
  on public.variant_attribute_values (variant_id);

create index if not exists product_attribute_values_product_idx
  on public.product_attribute_values (product_id);

-- ---------------------------------------------------------------------------
-- 5. Cómo se construye el documento de una variante
-- ---------------------------------------------------------------------------
-- Recibe un conjunto de ids y reescribe solo los que de verdad cambian. El
-- `is distinct from` no es una optimización cosmética: sin él, tocar una marca
-- reescribiría todas las variantes de todos sus productos aunque el texto
-- quedara igual, y cada reescritura es una fila muerta más en un índice GIN.
-- El documento se define UNA vez, en una vista, y de ahí lo leen tanto la
-- reconstrucción puntual de los disparadores como el relleno completo. Si la
-- definición viviera en dos sitios, acabarían diciendo cosas distintas.
--
-- Los atributos entran por un GROUP BY, no por un lateral correlacionado: con
-- el índice por `variant_id` el planificador empuja el filtro cuando se pide
-- una sola variante, y agrupa de una pasada cuando se piden todas. Un lateral
-- haría lo segundo 200 000 veces.
create or replace view public.variant_search_source
with (security_invoker = true) as
select
  variant.id as variant_id,
  public.search_normalize(
    coalesce(product.code, '') || ' ' ||
    coalesce(product.name, '') || ' ' ||
    coalesce(product.presentation, '') || ' ' ||
    coalesce(product.product_type, '') || ' ' ||
    coalesce(brand.name, '') || ' ' ||
    coalesce(line.name, '') || ' ' ||
    coalesce(shade.name, '') || ' ' ||
    coalesce(shade.code, '') || ' ' ||
    coalesce(variant.name, '') || ' ' ||
    coalesce(variant.sku, '') || ' ' ||
    coalesce(variant.barcode, '') || ' ' ||
    coalesce(atributos.texto, '')
  ) as texto
from public.product_variants variant
join public.products product on product.id = variant.product_id
left join public.brands brand on brand.id = product.brand_id
left join public.color_shades shade on shade.id = variant.color_shade_id
left join public.product_lines line on line.id = shade.product_line_id
left join (
  select
    value.variant_id,
    string_agg(
      coalesce(option.value, '') || ' ' ||
      coalesce(option.label, '') || ' ' ||
      coalesce(value.value_text, ''), ' ') as texto
  from public.variant_attribute_values value
  join public.attribute_definitions definition
    on definition.id = value.attribute_definition_id
   and definition.is_active
   and definition.is_searchable
  left join public.attribute_options option on option.id = value.option_id
  group by value.variant_id
) atributos on atributos.variant_id = variant.id;

revoke all on public.variant_search_source from public, anon, authenticated;

-- Reconstrucción puntual: la que usan los disparadores. El `join unnest` en vez
-- de `= any(array)` importa — `= any` sobre un array grande se comporta como un
-- recorrido lineal del array por cada fila.
create or replace function public.refresh_variant_search_documents(p_variant_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_variant_ids is null or array_length(p_variant_ids, 1) is null then
    return 0;
  end if;

  update public.product_variants target
  set search_document = fuente.texto
  from public.variant_search_source fuente
  join unnest(p_variant_ids) as pedido(id) on pedido.id = fuente.variant_id
  where target.id = fuente.variant_id
    and target.search_document is distinct from fuente.texto;

  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;

revoke execute on function public.refresh_variant_search_documents(uuid[]) from public;
grant execute on function public.refresh_variant_search_documents(uuid[]) to service_role;

-- Reconstrucción completa: relleno inicial y red de seguridad.
--
-- UNA sola sentencia, no por lotes. Por lotes era peor por dos razones que solo
-- se ven midiendo: la agregación de los valores de atributo se recalcula entera
-- en CADA lote, y una función plpgsql corre en una sola transacción de todas
-- formas, así que trocear no reducía nada. Medido con 201 578 variantes: seis
-- minutos de una sentencia contra más de diez sin terminar por lotes.
create or replace function public.rebuild_variant_search_documents()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
begin
  update public.product_variants target
  set search_document = fuente.texto
  from public.variant_search_source fuente
  where target.id = fuente.variant_id
    and target.search_document is distinct from fuente.texto;

  get diagnostics v_total = row_count;
  return v_total;
end;
$$;

revoke execute on function public.rebuild_variant_search_documents() from public;
grant execute on function public.rebuild_variant_search_documents() to service_role;

-- ---------------------------------------------------------------------------
-- 6. Quién avisa de que hay que reconstruirlo
-- ---------------------------------------------------------------------------
-- Todos los disparadores son POR SENTENCIA con tablas de transición, no por
-- fila. Importa: una importación masiva que toca 50 000 variantes dispara la
-- reconstrucción UNA vez con las 50 000, no 50 000 veces con una.

-- PostgreSQL no permite lista de columnas junto a tablas de transición, así que
-- el filtro por columna se hace DENTRO, comparando las dos tablas. Sale mejor:
-- comparar el valor viejo con el nuevo también corta la recursión, porque
-- escribir `search_document` no cambia ninguna de las columnas vigiladas y la
-- reconstrucción se queda sin filas que reconstruir.

create or replace function public.trg_refresh_variants_from_variants_ins()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(select id from nuevas));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_variants()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select n.id from nuevas n join viejas v on v.id = n.id
    where (n.name, n.sku, n.barcode, n.color_shade_id, n.product_id)
       is distinct from (v.name, v.sku, v.barcode, v.color_shade_id, v.product_id)));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_products()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select pv.id from public.product_variants pv
    join nuevas n on n.id = pv.product_id
    join viejas v on v.id = n.id
    where (n.code, n.name, n.presentation, n.product_type)
       is distinct from (v.code, v.name, v.presentation, v.product_type)));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_brands()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select pv.id from public.product_variants pv
    join public.products p on p.id = pv.product_id
    join nuevas n on n.id = p.brand_id
    join viejas v on v.id = n.id
    where n.name is distinct from v.name));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_shades()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select pv.id from public.product_variants pv
    join nuevas n on n.id = pv.color_shade_id
    join viejas v on v.id = n.id
    where (n.name, n.code) is distinct from (v.name, v.code)));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_lines()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select pv.id from public.product_variants pv
    join public.color_shades s on s.id = pv.color_shade_id
    join nuevas n on n.id = s.product_line_id
    join viejas v on v.id = n.id
    where n.name is distinct from v.name));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_values()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(select variant_id from afectadas));
  return null;
end;
$$;

create or replace function public.trg_refresh_variants_from_options()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.refresh_variant_search_documents(array(
    select val.variant_id from public.variant_attribute_values val
    join nuevas n on n.id = val.option_id
    join viejas v on v.id = n.id
    where (n.value, n.label) is distinct from (v.value, v.label)));
  return null;
end;
$$;

-- PostgreSQL concede EXECUTE al rol PUBLIC en TODA función nueva, y `anon` es
-- miembro de PUBLIC. Una función de disparador la invoca el disparador, nunca
-- un cliente: nadie más tiene por qué poder llamarla.
revoke execute on function public.trg_refresh_variants_from_variants_ins() from public;
revoke execute on function public.trg_refresh_variants_from_variants() from public;
revoke execute on function public.trg_refresh_variants_from_products() from public;
revoke execute on function public.trg_refresh_variants_from_brands() from public;
revoke execute on function public.trg_refresh_variants_from_shades() from public;
revoke execute on function public.trg_refresh_variants_from_lines() from public;
revoke execute on function public.trg_refresh_variants_from_values() from public;
revoke execute on function public.trg_refresh_variants_from_options() from public;

drop trigger if exists product_variants_refresh_search on public.product_variants;
create trigger product_variants_refresh_search
after insert on public.product_variants
referencing new table as nuevas
for each statement execute function public.trg_refresh_variants_from_variants_ins();

drop trigger if exists product_variants_refresh_search_upd on public.product_variants;
create trigger product_variants_refresh_search_upd
after update on public.product_variants
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_variants();

drop trigger if exists products_refresh_variant_search on public.products;
create trigger products_refresh_variant_search
after update on public.products
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_products();

drop trigger if exists brands_refresh_variant_search on public.brands;
create trigger brands_refresh_variant_search
after update on public.brands
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_brands();

drop trigger if exists color_shades_refresh_variant_search on public.color_shades;
create trigger color_shades_refresh_variant_search
after update on public.color_shades
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_shades();

drop trigger if exists product_lines_refresh_variant_search on public.product_lines;
create trigger product_lines_refresh_variant_search
after update on public.product_lines
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_lines();

drop trigger if exists variant_values_refresh_search_ins on public.variant_attribute_values;
create trigger variant_values_refresh_search_ins
after insert on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_refresh_variants_from_values();

drop trigger if exists variant_values_refresh_search_upd on public.variant_attribute_values;
create trigger variant_values_refresh_search_upd
after update on public.variant_attribute_values
referencing new table as afectadas
for each statement execute function public.trg_refresh_variants_from_values();

drop trigger if exists variant_values_refresh_search_del on public.variant_attribute_values;
create trigger variant_values_refresh_search_del
after delete on public.variant_attribute_values
referencing old table as afectadas
for each statement execute function public.trg_refresh_variants_from_values();

drop trigger if exists attribute_options_refresh_variant_search on public.attribute_options;
create trigger attribute_options_refresh_variant_search
after update on public.attribute_options
referencing old table as viejas new table as nuevas
for each statement execute function public.trg_refresh_variants_from_options();

commit;

-- ---------------------------------------------------------------------------
-- 7. Relleno inicial, fuera de la transacción de esquema
-- ---------------------------------------------------------------------------
select public.rebuild_variant_search_documents();

analyze public.product_variants;
analyze public.products;
analyze public.persons;
analyze public.variant_attribute_values;
