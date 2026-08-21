-- 0150 · Distinguir «lo trajo la fuente» de «lo dedujo una regla nuestra».
--
-- Los métodos de extracción permitidos describían todos de dónde SALIÓ el dato:
-- official_api, official_page, physical_packaging, spreadsheet… Todos suponen
-- que alguien de fuera lo publicó y nosotros lo recogimos.
--
-- Faltaban los dos casos en que el dato no lo publicó nadie: lo produjo una
-- regla nuestra a partir de un texto que sí publicaron. Y esa diferencia es la
-- que hace falta poder ver, porque hasta ahora una presentación calculada con un
-- regex entraba marcada como «official_api» y con confianza 1 — indistinguible
-- de un campo que la tienda sí trae.
--
--   rule_normalization  transformación determinista y reversible.
--                       «13,5 ML» en el título → presentación «13.5 ml».
--                       El valor es nuestro; la información, de la fuente.
--
--   rule_inference      interpretación. Del título «AUSENTE - ESMALTE…» se
--                       concluye que el tono es «AUSENTE» porque asumimos que el
--                       título separa el tono con un guion. Si la fuente cambia
--                       su convención, el valor sale mal y la fuente no tiene
--                       ninguna culpa.
--
-- Medido en las seis fuentes: el mismo parser de acabado acierta el 79% en
-- Admiss y el 0% en Cherimoya. Eso es una propiedad de la regla, no de Cherimoya,
-- y solo se puede razonar así si el método de extracción lo dice.

begin;

alter table public.catalog_observations drop constraint if exists catalog_observations_method_allowed;
alter table public.catalog_observations add constraint catalog_observations_method_allowed
  check (extraction_method = any (array[
    -- lo publicó alguien de fuera y lo recogimos
    'official_api', 'official_page', 'authorized_distributor',
    'internal_document', 'physical_packaging', 'spreadsheet',
    'manual_capture', 'computer_vision',
    -- lo produjo una regla nuestra a partir de lo anterior
    'rule_normalization', 'rule_inference'
  ]));

comment on column public.catalog_observations.extraction_method is
  'De dónde salió el valor. Los métodos rule_* indican que NO lo publicó la '
  'fuente: lo produjo una regla nuestra sobre un texto que sí publicó, y por '
  'tanto su fiabilidad es la de la regla y no la de la fuente.';

commit;
