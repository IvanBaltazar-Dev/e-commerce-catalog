-- 0124 · La compuerta de necesidad deja de pagarse por fila.
--
-- 0122 colgó dos disparadores de `catalog_review_work_items`, y la Mesa se
-- proyecta en bloque: unas mil quinientas filas de una vez. Medido, el coste
-- era este:
--
--   sync_catalog_review_work_items_v1  sin los disparadores  →  1,4 s
--   sync_catalog_review_work_items_v1  con los disparadores  →  6,8 s
--
-- Casi cinco veces más, y por encima del tiempo máximo de sentencia: la
-- reconstrucción desde base vacía moría en el tercer paso con «canceling
-- statement due to statement timeout». Un gate que tarda de más no es un gate
-- lento, es un gate roto.
--
-- Dos causas, las dos evitables:
--
--   1. La relevancia comercial llamaba a una función SECURITY DEFINER por cada
--      fila. Ocho milisegundos de planificación multiplicados por mil quinientas
--      son doce segundos de nada. El conteo se hace ahora dentro del propio
--      disparador, contra el índice de marca que ya existía.
--
--   2. El sujeto de una fila fuente se buscaba por parecido de nombre contra los
--      1051 productos, en cada escritura. Eso era un apaño de cuando el enlace
--      se había perdido; desde que el cargador escribe el producto y la variante
--      al crear la excepción, adivinar sobra. Si hay enlace exacto se usa; si no
--      lo hay, se dice que no lo hay. El veredicto de la compuerta no cambia:
--      una fila sin sujeto recuperable seguía siendo deuda automática, viniera
--      por «sin candidatos» o por «candidatos demasiado débiles».

begin;

create or replace function public.apply_catalog_review_commercial_weight_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  affected integer;
begin
  -- Una relevancia declarada a mano por quien registra el trabajo manda sobre
  -- el cálculo. Solo se completa lo que llegó vacío.
  if new.business_relevance is not null and new.business_relevance > 0 then
    return new;
  end if;

  if new.subject_id is null then
    new.business_relevance := 0;
    return new;
  end if;

  -- El conteo va aquí y no en una función aparte: la llamada costaba más que
  -- la consulta.
  if new.subject_type = 'brand' then
    select count(*) into affected
    from public.products product
    where product.brand_id = new.subject_id and product.is_active;
  elsif new.subject_type = 'product' then
    select count(*) into affected
    from public.products product
    where product.id = new.subject_id and product.is_active;
  elsif new.subject_type in ('variant', 'shade') then
    affected := 1;
  else
    affected := 0;
  end if;

  new.business_relevance := least(100, coalesce(affected, 0))::numeric;
  return new;
end;
$function$;

create or replace function public.normalize_catalog_review_source_row_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  linked record;
begin
  if new.source_type <> 'enrichment_exception'
     or coalesce(new.context -> 'details' ->> 'source_scope', '') <> 'SOURCE_ROW' then
    return new;
  end if;

  select exception.product_id, exception.variant_id,
         product.name as product_name, product.code as product_code,
         variant.name as variant_name
  into linked
  from public.catalog_enrichment_exceptions exception
  left join public.products product on product.id = exception.product_id
  left join public.product_variants variant on variant.id = exception.variant_id
  where exception.id = new.source_id;

  if found and linked.product_id is not null then
    new.subject_type := 'product';
    new.subject_id := linked.product_id;
    new.context := coalesce(new.context, '{}'::jsonb)
      || jsonb_build_object('sourceRowLink', jsonb_strip_nulls(jsonb_build_object(
        'exact', true,
        'weakCount', 1,
        'clearCount', 1,
        'bestScore', 1,
        'candidates', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'productId', linked.product_id,
          'variantId', linked.variant_id,
          'name', linked.product_name,
          'variantName', linked.variant_name,
          'code', linked.product_code,
          'score', 1
        )))
      )));
    return new;
  end if;

  -- Sin enlace exacto no se adivina. La fila queda declarada como lo que es:
  -- una pregunta sin sujeto recuperable, que la compuerta manda a deuda
  -- automática por la regla `source_row_reference_unresolvable`.
  new.context := coalesce(new.context, '{}'::jsonb)
    || jsonb_build_object('sourceRowLink', jsonb_build_object(
      'exact', false, 'weakCount', 0, 'clearCount', 0, 'bestScore', 0,
      'candidates', '[]'::jsonb
    ));
  return new;
end;
$function$;

-- La búsqueda por parecido deja de existir: no la usa nadie y su sitio nunca
-- fue un disparador por fila.
drop function if exists public.catalog_review_source_row_link_v1(text);

revoke all on function public.apply_catalog_review_commercial_weight_v1()
  from public, anon, authenticated;
revoke all on function public.normalize_catalog_review_source_row_v1()
  from public, anon, authenticated;

commit;
