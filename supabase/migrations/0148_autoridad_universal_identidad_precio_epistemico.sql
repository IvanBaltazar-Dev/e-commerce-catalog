-- 0148 · Tres correcciones universales, ninguna por marca.
--
-- Vienen de un diagnóstico que se hizo midiendo seis fuentes, pero ninguna de
-- las tres es una particularidad de esas seis: son huecos del contrato que se
-- habrían repetido con la séptima.
--
--   1 · el resolutor no prefiere el patrón exacto sobre el comodín
--   2 · identity.* iguala un identificador global con uno local de la fuente
--   3 · price.* concede autoridad comercial sin saber de qué mercado habla
--
-- Y una cuarta que las atraviesa: la autoridad de una conclusión de nuestro
-- parser no puede ser la autoridad literal de la fuente.

begin;

-- ── 1 · El patrón exacto debe ganar al comodín ──────────────────────────────
--
-- El orden actual es: fuente propia, dimensión declarada, patrón no comodín,
-- campo no comodín, y después authority_score descendente. Con dos reglas que
-- casan —identity.* con score 1.0 e identity.source_external_id con 0.35— gana
-- la de score más alto, que es justo la genérica.
--
-- O sea que declarar una regla más específica y MÁS RESTRICTIVA no tenía ningún
-- efecto: quedaba tapada por el comodín. Cualquier intento de rebajar autoridad
-- sobre un caso concreto era inerte, y no se notaba porque nada fallaba: se
-- resolvía, solo que con la regla equivocada.
create or replace function public.resolve_catalog_source_authority_v1(
  p_source_id uuid, p_predicate text, p_source_field text, p_dimension_code text
)
returns table(policy_id uuid, source_role text, authority_level text, authority_score numeric, rationale text)
language sql stable set search_path to ''
as $function$
  select policy.id, policy.source_role, policy.authority_level,
         policy.authority_score, policy.rationale
  from public.catalog_sources source
  join public.catalog_source_predicate_authority policy
    on policy.is_active
   and (policy.source_id = source.id or policy.source_kind = source.authority)
   and (policy.dimension_code is null or policy.dimension_code = p_dimension_code)
   and (
     policy.predicate_pattern = '*'
     or (right(policy.predicate_pattern, 1) = '*'
         and p_predicate like left(policy.predicate_pattern, -1) || '%')
     or policy.predicate_pattern = p_predicate
   )
   and (
     policy.source_field_pattern = '*'
     or (right(policy.source_field_pattern, 1) = '*'
         and p_source_field like left(policy.source_field_pattern, -1) || '%')
     or policy.source_field_pattern = p_source_field
   )
  where source.id = p_source_id
  order by
    (policy.source_id is not null) desc,
    -- Lo específico manda sobre lo genérico, y eso incluye poder BAJAR la
    -- autoridad de un caso concreto sin que el comodín lo pise.
    (policy.predicate_pattern = p_predicate) desc,
    length(policy.predicate_pattern) desc,
    (policy.dimension_code is not null) desc,
    (policy.predicate_pattern <> '*') desc,
    (policy.source_field_pattern <> '*') desc,
    policy.authority_score desc,
    policy.id
  limit 1;
$function$;

-- ── 2 · Identificador global ≠ identificador local de la fuente ─────────────
--
-- identidad-guardas.ts ya ordena GTIN 100, MANUFACTURER_SKU 90, SUPPLIER_SKU 70
-- y SOURCE_EXTERNAL_ID 50, y lo hace por una razón concreta: un id interno de
-- Shopify solo significa algo dentro de esa tienda. Emparejar dos productos
-- porque comparten id de Shopify sería como emparejarlos por número de fila.
--
-- La tabla de autoridad decía otra cosa: identity.* preferred para todo. Dos
-- subsistemas dando significado distinto al mismo concepto, y el que ganaba
-- dependía de por dónde entrase el dato.
insert into public.catalog_source_predicate_authority(
  source_kind, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale, conditions
) values
  ('official','IDENTITY','identity.gtin','*','identity','preferred',1.0,
   'Un GTIN identifica el producto en cualquier catálogo del mundo. Es la única identidad que no depende de que dos fuentes escriban el nombre igual.',
   '{"alcance":"global","emisor":"GS1"}'::jsonb),

  ('official','IDENTITY','identity.manufacturer_sku','*','identity','preferred',0.9,
   'El SKU de fábrica manda dentro del espacio de nombres de su marca. Fuera de él no identifica nada: dos marcas pueden usar el mismo código para cosas distintas.',
   '{"alcance":"namespace_de_marca","exige":"marca_conocida_para_comparar"}'::jsonb),

  ('official','IDENTITY','identity.source_external_id','*','identity','supplemental',0.35,
   'Es el id interno de la tienda. Sirve para volver a la ficha de la que salió el dato y para nada más: emparejar por él sería emparejar por número de fila.',
   '{"alcance":"solo_dentro_de_la_fuente","nunca":"emparejamiento_entre_fuentes"}'::jsonb),

  ('official','IDENTITY','identity.brand_declared','*','identity','acceptable',0.6,
   'La marca tal como la escribe la tienda, sin resolver. Medido en las seis fuentes: Masglo aparece como MASGLO, Masglo y Masglo España; Bigen como «bigen-usa.com»; Acrylove como «acryloveoficial». Es una etiqueta, no una entidad.',
   '{"resuelto":false,"resolver_seria":"DERIVED_INFERRED"}'::jsonb)
on conflict do nothing;

-- ── 3 · El precio externo no es autoridad comercial ─────────────────────────
--
-- La regla de clase concedía «acceptable 0.85» a cualquier fuente official. Pero
-- una regla de clase no puede saber en qué mercado ni en qué moneda está el
-- precio, y sin eso la cifra no significa nada aquí: los 3.900–15.900 de Admiss
-- son pesos colombianos.
--
-- La comparabilidad no es una propiedad de la fuente sino de la relación entre
-- su mercado y el nuestro, y eso ya es un DATO (catalog_sources.metadata.market).
-- Así que baja a suplementario para todas y quien consuma decide comparando
-- mercados — en vez de seis reglas por fuente diciendo lo mismo.
update public.catalog_source_predicate_authority
set authority_level = 'supplemental',
    authority_score = 0.4,
    rationale = 'Observación de precio en el mercado de la fuente. Nunca es autoridad sobre el precio propio, y su comparabilidad depende de que el mercado coincida — que es un dato de la fuente, no una regla de autoridad.',
    conditions = conditions || '{"comparable_si":"catalog_sources.metadata.market coincide con el mercado propio","nunca":"precio_de_venta_ni_costo_bellaroshe"}'::jsonb
where source_kind = 'official' and predicate_pattern = 'price.*';

-- ── 4 · Una inferencia nuestra no hereda la autoridad de la fuente ──────────
--
-- La fuente tiene autoridad sobre el TEXTO que publica. Lo que nuestro parser
-- concluya de ese texto es nuestro, y su fiabilidad es la de la regla — que se
-- mide, y que varía muchísimo: el mismo parser de acabado acierta el 79% en
-- Admiss y el 0% en Cherimoya. Heredar «preferred» de la fuente convertiría
-- nuestro regex en una declaración del fabricante.
--
-- El tope es por clase epistémica y se aplica sobre lo que resuelva la autoridad
-- de fuente, sin sustituirla: una fuente floja no sube por normalizar bien.
create or replace function public.resolve_authority_with_epistemics_v1(
  p_source_id uuid, p_predicate text, p_source_field text,
  p_dimension_code text, p_epistemic_class text
)
returns table(
  authority_level text, authority_score numeric, source_role text,
  capped boolean, cap_reason text, rationale text
)
language sql stable set search_path to ''
as $function$
  with base as (
    select * from public.resolve_catalog_source_authority_v1(
      p_source_id, p_predicate, p_source_field, p_dimension_code)
  ),
  tope as (
    select case p_epistemic_class
      when 'OBSERVATION_LITERAL'      then 'preferred'
      when 'CANONICAL_FACT'           then 'preferred'
      -- Determinista y reversible, pero la transformación es nuestra.
      when 'NORMALIZED_SOURCE_CLAIM'  then 'acceptable'
      -- Interpretación. Su acierto depende de la regla, no de la fuente.
      when 'DERIVED_INFERRED'         then 'supplemental'
      else 'supplemental'
    end as nivel_max
  ),
  orden as (
    select 'prohibited' n, 0 r union all select 'supplemental', 1
    union all select 'acceptable', 2 union all select 'preferred', 3
  )
  select
    case when ob.r > ot.r then t.nivel_max else b.authority_level end,
    case when ob.r > ot.r then least(b.authority_score, ot.r * 0.35) else b.authority_score end,
    b.source_role,
    (ob.r > ot.r),
    case when ob.r > ot.r
      then format('%s topado a %s: la clase epistémica es %s, así que el valor lo produce nuestra regla y no la fuente',
                  b.authority_level, t.nivel_max, p_epistemic_class)
      else null end,
    b.rationale
  from base b
  cross join tope t
  join orden ob on ob.n = b.authority_level
  join orden ot on ot.n = t.nivel_max;
$function$;

comment on function public.resolve_authority_with_epistemics_v1 is
  'Autoridad de fuente topada por clase epistémica. Una inferencia de nuestro '
  'parser nunca puede presentarse con la autoridad literal de la fuente.';

grant execute on function public.resolve_authority_with_epistemics_v1 to authenticated, service_role;

commit;
