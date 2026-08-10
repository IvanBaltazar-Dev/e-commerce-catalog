begin;

create extension if not exists pgtap with schema extensions;

select plan(6);

-- ---------------------------------------------------------------------------
-- 0081 · Las proyecciones no se contagian entre sí
-- ---------------------------------------------------------------------------
-- Esta batería no mide velocidad: mide AISLAMIENTO. Existe porque el defecto
-- que la motivó no se veía en ninguna prueba funcional — todo daba resultados
-- correctos, solo que escribir un documento de búsqueda recalculaba precios,
-- auditaba filas y validaba publicaciones. Se descubrió por el reloj: rellenar
-- 200 000 documentos tardaba más de diecisiete minutos.
--
-- Lo que se afirma aquí:
--
--   renombrar una marca  → reescribe documentos · NO recalcula precios
--   cambiar un precio    → recalcula el precio  · NO reescribe documentos
--   escribir proyecciones → NO audita product_variants
--
-- Si alguien engancha mañana un disparador de precios a «cualquier UPDATE de
-- product_variants», falla aquí y no dentro de seis meses con un cronómetro.
-- ---------------------------------------------------------------------------

-- Punto de partida conocido: se retrasan las marcas de tiempo para que
-- «tocado» signifique «tocado por esta prueba» y no «tocado alguna vez».
update public.product_catalog_projection
set search_updated_at = now() - interval '1 day',
    price_updated_at  = now() - interval '1 day';

create temporary table fx_marca on commit drop as
select b.id, b.name, count(*)::int as productos
from public.brands b
join public.products p on p.brand_id = b.id
group by b.id, b.name
order by count(*) asc
limit 1;

select isnt((select id from fx_marca), null, '0 · hay una marca con productos para el experimento');

create temporary table fx_auditoria on commit drop as
select count(*)::int as n from public.audit_log where table_name = 'product_variants';

-- ---------------------------------------------------------------------------
-- Renombrar una marca
-- ---------------------------------------------------------------------------
update public.brands set name = name || ' PRUEBA0081' where id = (select id from fx_marca);

select cmp_ok(
  (select count(*)::int from public.product_catalog_projection
   where search_updated_at > now() - interval '1 hour'),
  '>', 0,
  '1 · renombrar una marca SÍ reescribe los documentos de sus productos'
);

select is(
  (select count(*)::int from public.product_catalog_projection
   where price_updated_at > now() - interval '1 hour'),
  0,
  '2 · y NO recalcula ni un solo precio'
);

select is(
  (select count(*)::int from public.audit_log where table_name = 'product_variants')
    - (select n from fx_auditoria),
  0,
  '3 · escribir proyecciones no audita product_variants'
);

-- ---------------------------------------------------------------------------
-- Cambiar un precio, en el otro sentido
-- ---------------------------------------------------------------------------
update public.product_catalog_projection
set search_updated_at = now() - interval '1 day',
    price_updated_at  = now() - interval '1 day';

-- BAJANDO el precio de TODAS las variantes de UN producto. Subirlo no sirve:
-- la proyección guarda el mínimo, y encarecer una variante que no era la más
-- barata no cambia el mínimo — así que la proyección, correctamente, no
-- escribe nada y la prueba fallaría por su propio descuido.
-- Se mueven TODOS los precios minoristas vigentes de UN producto, y a un valor
-- que con seguridad cambia el mínimo. Tocar una sola fila no basta: si no era
-- la más barata, el mínimo no se mueve y la proyección —con razón— no escribe
-- nada; y el mínimo real de este catálogo es 0.00, así que dividirlo tampoco
-- lo cambia. La prueba fallaría por su propio descuido, no por el sistema.
create temporary table fx_precio on commit drop as
select pc.product_id, pc.starting_price
from public.product_catalog_projection pc
where pc.starting_price is not null
limit 1;

update public.variant_prices vp
set amount = (select starting_price from fx_precio) + 7
from public.product_variants v, public.price_lists pl, fx_precio fx
where v.id = vp.variant_id and v.is_active and v.product_id = fx.product_id
  and pl.id = vp.price_list_id and pl.price_type = 'retail'
  and pl.is_active and pl.is_public
  and vp.is_active and vp.validity @> now();

select cmp_ok(
  (select count(*)::int from public.product_catalog_projection
   where price_updated_at > now() - interval '1 hour'),
  '>', 0,
  '4 · cambiar un precio SÍ recalcula el precio de sus productos'
);

select is(
  (select count(*)::int from public.product_catalog_projection
   where search_updated_at > now() - interval '1 hour'),
  0,
  '5 · y NO reescribe ni un solo documento de búsqueda'
);

select * from finish();

rollback;
