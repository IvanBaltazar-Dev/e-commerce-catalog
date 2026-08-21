-- 0149 · Alinear reference_key con el formato que el código genera hoy.
--
-- El pipeline de marca no se puede reejecutar. Al intentarlo falla así:
--
--   duplicate key value violates unique constraint
--   catalog_reference_products_primary_source_id_primary_extern_key
--
-- La causa: el formato de reference_key cambió en algún momento y las filas
-- existentes se quedaron con el viejo.
--
--   en base    bigen-usa-official:7818204446838
--   el código  bigen-usa-official:product:7818204446838
--
--   en base    acrylove-official:v:39480115101942
--   el código  acrylove-official:variant:39480115101942
--
-- Al reejecutar, el upsert construye la llave nueva, no encuentra conflicto por
-- reference_key —porque esa llave no existe— e intenta INSERTAR. Y ahí choca con
-- la otra restricción única, (primary_source_id, primary_external_id), que sí
-- sigue siendo la misma. El `on conflict (reference_key)` no la cubre.
--
-- Es el mismo fallo que ya costó caro con case_key: una llave que identifica algo
-- distinto de lo que la restricción considera «el mismo». Aquí lo que identifica
-- de verdad al producto dentro de una fuente es (fuente, id externo); la llave de
-- texto es una etiqueta legible derivada de eso, y por tanto es la que debe
-- ceder.
--
-- 3.980 productos y 3.406 variantes. No toca ninguna FK: reference_key es única
-- pero no es la clave primaria, y nada la referencia.

begin;

update public.catalog_reference_products p
set reference_key = f.source_key || ':product:' || p.primary_external_id
from public.catalog_sources f
where f.id = p.primary_source_id
  and p.reference_key <> f.source_key || ':product:' || p.primary_external_id;

update public.catalog_reference_variants v
set reference_key = f.source_key || ':variant:' || v.primary_external_id
from public.catalog_sources f
where f.id = v.primary_source_id
  and v.reference_key <> f.source_key || ':variant:' || v.primary_external_id;

do $$
declare mal_p integer; mal_v integer;
begin
  select count(*) into mal_p from public.catalog_reference_products p
    join public.catalog_sources f on f.id = p.primary_source_id
    where p.reference_key <> f.source_key || ':product:' || p.primary_external_id;
  select count(*) into mal_v from public.catalog_reference_variants v
    join public.catalog_sources f on f.id = v.primary_source_id
    where v.reference_key <> f.source_key || ':variant:' || v.primary_external_id;
  if mal_p > 0 or mal_v > 0 then
    raise exception 'quedan % productos y % variantes con la llave desalineada', mal_p, mal_v;
  end if;
  raise notice 'reference_key alineada en productos y variantes';
end $$;

commit;
