-- 0147 · Retirar las reglas de autoridad por fuente que nadie justificó.
--
-- 0145 insertó 68 reglas por fuente. 54 de ellas salían de un cross join: una
-- plantilla llamada «*brand*» multiplicada por las seis tiendas. Escrito así no
-- lo parece, pero es exactamente copiar las reglas de clase seis veces y llamar
-- «autoridad específica» a lo que solo era el fallback duplicado.
--
-- Y el fallback ya existía. Las 23 reglas kind:official cubren identity.*,
-- technical.*, process.*, price.* y media.*, y se aplican solas a cualquier
-- fuente official. Duplicarlas por fuente no añade una sola decisión: añade 54
-- filas que hay que mantener y que ocultan cuáles son las excepciones de verdad.
--
-- Peor todavía: esas reglas afirmaban cosas que nadie había mirado. Declaraban a
-- las seis tiendas «preferred» en official.line y official.finish sin comprobar
-- si alguna de las seis publica línea o acabado. Y «preferred» en semantic.*
-- —composición, uso— cuando lo que una ficha de tienda trae es un texto de
-- marketing del que habría que INFERIR la composición, que no es lo mismo que
-- que la fuente la declare.
--
-- Una regla de autoridad solo se sostiene sobre un campo que esa fuente publica
-- de verdad. Así que se retiran todas y se vuelven a construir sobre el
-- inventario de lo realmente observado.
--
-- Lo que NO se retira, porque no es autoridad sino hecho comprobado:
--   · el mercado y la moneda de cada fuente, preguntados a cada tienda
--   · la corrección de moneda de 2.011 precios que se guardaban como soles

begin;

delete from public.catalog_source_predicate_authority
where source_id is not null;

-- Quedan solo las 23 reglas de clase, que son el fallback y siempre lo fueron.
do $$
declare n_fuente integer; n_clase integer;
begin
  select count(*) into n_fuente from public.catalog_source_predicate_authority where source_id is not null;
  select count(*) into n_clase  from public.catalog_source_predicate_authority where source_kind is not null;
  if n_fuente <> 0 then
    raise exception 'quedan % reglas por fuente y debían quedar 0', n_fuente;
  end if;
  raise notice 'reglas por fuente: % · reglas de clase (fallback): %', n_fuente, n_clase;
end $$;

commit;
