begin;

create extension if not exists pgtap with schema extensions;

select plan(5);

-- ---------------------------------------------------------------------------
-- 0076 · La proyección de facetas dice lo mismo que el catálogo
-- ---------------------------------------------------------------------------
-- `catalog_facet_presence` es una copia: qué opciones de atributo existen en el
-- catálogo publicado. Las copias sirven mientras no mientan, así que lo que
-- esta batería comprueba no es que la tabla tenga filas, sino que su contenido
-- COINCIDE con lo que se obtendría calculándolo, y que sigue coincidiendo
-- después de publicar y de retirar un producto.
--
-- La comparación contra la fuente sí mira las tablas enteras, y aquí eso es
-- correcto: no es un conteo que otra sesión pueda mover, es una igualdad entre
-- una proyección y su origen, leídos en la misma instantánea de la transacción.
-- ---------------------------------------------------------------------------

create or replace function pg_temp.presencia_calculada()
returns table (definition_id uuid, option_id uuid)
language sql stable as $$
  select distinct value.attribute_definition_id, value.option_id
  from public.product_attribute_values value
  join public.products product on product.id = value.product_id
  where value.option_id is not null
    and product.is_active and product.editorial_status = 'published'
  union
  select distinct value.attribute_definition_id, value.option_id
  from public.variant_attribute_values value
  join public.product_variants variant on variant.id = value.variant_id and variant.is_active
  join public.products product on product.id = variant.product_id
  where value.option_id is not null
    and product.is_active and product.editorial_status = 'published';
$$;

select is(
  (select count(*)::int from (
     select definition_id, option_id from pg_temp.presencia_calculada()
     except
     select attribute_definition_id, option_id from public.catalog_facet_presence
   ) faltantes),
  0,
  '1 · no falta ninguna opción que el catálogo publicado sí tiene'
);

select is(
  (select count(*)::int from (
     select attribute_definition_id, option_id from public.catalog_facet_presence
     except
     select definition_id, option_id from pg_temp.presencia_calculada()
   ) sobrantes),
  0,
  '2 · no sobra ninguna opción que el catálogo publicado ya no tiene'
);

-- ---------------------------------------------------------------------------
-- Publicar y retirar tienen que moverla
-- ---------------------------------------------------------------------------
create temporary table fx_producto on commit drop as
select p.id as product_id, v.id as variant_id, vav.attribute_definition_id, vav.option_id
from public.products p
join public.product_variants v on v.product_id = p.id and v.is_active
join public.variant_attribute_values vav on vav.variant_id = v.id and vav.option_id is not null
where p.is_active and p.editorial_status = 'published'
  -- Un producto que sea el ÚNICO con esa opción: si no, retirarlo no cambia nada
  -- y la prueba pasaría sin comprobar nada.
  and not exists (
    select 1
    from public.variant_attribute_values otro
    join public.product_variants ov on ov.id = otro.variant_id and ov.is_active
    join public.products op on op.id = ov.product_id
      and op.is_active and op.editorial_status = 'published'
    where otro.option_id = vav.option_id and op.id <> p.id
  )
limit 1;

select is(
  (select count(*)::int from public.catalog_facet_presence pres
   join fx_producto fx on fx.option_id = pres.option_id
                      and fx.attribute_definition_id = pres.attribute_definition_id),
  (select count(*)::int from fx_producto),
  '3 · la opción exclusiva de ese producto está en la proyección'
);

update public.products
set editorial_status = 'draft'
where id in (select product_id from fx_producto);

select is(
  (select count(*)::int from public.catalog_facet_presence pres
   join fx_producto fx on fx.option_id = pres.option_id
                      and fx.attribute_definition_id = pres.attribute_definition_id),
  0,
  '4 · al retirar el producto, su opción exclusiva desaparece de la proyección'
);

update public.products
set editorial_status = 'published'
where id in (select product_id from fx_producto);

select is(
  (select count(*)::int from public.catalog_facet_presence pres
   join fx_producto fx on fx.option_id = pres.option_id
                      and fx.attribute_definition_id = pres.attribute_definition_id),
  (select count(*)::int from fx_producto),
  '5 · al volver a publicarlo, vuelve'
);

select * from finish();

rollback;
