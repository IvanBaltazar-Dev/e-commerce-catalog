-- ---------------------------------------------------------------------------
-- 0083 · Las dos búsquedas del admin pasan a tener contrato
-- ---------------------------------------------------------------------------
-- Eran las únicas superficies de búsqueda que no pasaban por ninguna función de
-- la base. Buscaban así, desde la aplicación y por PostgREST:
--
--   /api/admin/products            .or(name.ilike, code.ilike, product_type.ilike)
--   /api/admin/catalog-v2/relations .or(name.ilike, code.ilike)
--
-- Tres consecuencias, y ninguna es teórica:
--
--   1. Sin índice. `ilike '%x%'` sobre tres columnas crudas recorre la tabla.
--   2. Con OTRAS reglas. No quitaban tildes —«lámpara» no encontraba
--      «lampara»— y no tenían la regla de términos cortos, así que teclear
--      «ml» devolvía cuanto producto dijera «ml» en cualquier parte.
--   3. Sin sitio donde arreglarlo. Una superficie sin contrato no puede cumplir
--      una regla que vive en el contrato: hay que acordarse de repetirla.
--
-- QUÉ DEVUELVE EL CONTRATO Y POR QUÉ. Los IDENTIFICADORES de la página y el
-- total, no las filas. La pantalla del admin consume una forma anidada
-- —marca, categoría, galería— que PostgREST ya sabe construir; replicarla en
-- SQL sería duplicar por duplicar. Así la regla —qué coincide, en qué orden y
-- qué página— vive entera aquí, y la lista de ids que viaja está acotada al
-- tamaño de la página.
-- ---------------------------------------------------------------------------

begin;

-- Los contratos son SECURITY INVOKER, como `inventory_board`: se apoyan en la
-- RLS y en los privilegios de quien pregunta, no los suplantan. Para eso
-- necesitan poder leer la proyección de códigos. Se concede a `authenticated`
-- y NUNCA a `anon`: son SKU y códigos internos, cosa del mostrador.
drop policy if exists "variant search codes readable by staff" on public.variant_search_codes;
create policy "variant search codes readable by staff"
on public.variant_search_codes
for select
to authenticated
using (true);

grant select on public.variant_search_codes to authenticated;

-- ---------------------------------------------------------------------------
-- La lista de productos del admin
-- ---------------------------------------------------------------------------
create or replace function public.admin_product_search(
  p_query text default null,
  p_estado text default null,
  p_active boolean default null,
  p_brand_id uuid default null,
  p_limit integer default 24,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_termino text := coalesce(public.search_normalize(p_query), '');
  v_corto boolean := v_termino <> '' and length(v_termino) < 3;
  v_pattern text := '%' || v_termino || '%';
  v_prefijo text := v_termino || '%';
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  if p_estado is not null and p_estado not in ('publicado', 'borrador', 'oculto') then
    raise exception using errcode = '22023', message = 'Estado de producto no permitido.';
  end if;

  with coincidentes as (
    select product.id, product.sort_order, product.name
    from public.products product
    where
      -- Misma normalización y misma regla de términos cortos que el POS y el
      -- catálogo. Es el sentido de tener contrato: una sola definición.
      (
        v_termino = ''
        or (v_corto and product.id in (
              select proyeccion.product_id
              from public.variant_search_codes codigo
              join public.variant_search_projection proyeccion
                on proyeccion.variant_id = codigo.variant_id
              where codigo.normalized_code like v_prefijo))
        or (not v_corto and product.search_text like v_pattern)
      )
      and (p_active is null or product.is_active = p_active)
      and (p_brand_id is null or product.brand_id = p_brand_id)
      and (
        p_estado is null
        or (p_estado = 'publicado'
            and product.editorial_status = 'published' and product.is_active)
        or (p_estado = 'borrador'
            and product.editorial_status in ('draft', 'in_review', 'incomplete')
            and product.is_active)
        or (p_estado = 'oculto'
            and (product.editorial_status = 'hidden' or not product.is_active))
      )
  ),
  pagina as (
    select id from coincidentes
    order by sort_order asc, name asc
    offset v_offset
    limit v_limit
  )
  select jsonb_build_object(
    'ids', coalesce((select jsonb_agg(id) from pagina), '[]'::jsonb),
    'total', (select count(*)::integer from coincidentes)
  ) into v_result;

  return v_result;
end;
$function$;

comment on function public.admin_product_search(text, text, boolean, uuid, integer, integer) is
  'Qué productos ve la lista del admin y en qué orden. Devuelve los identificadores de la página y el total; la forma anidada la construye quien pregunta. Usa la misma normalización y la misma regla de términos cortos que el POS y el catálogo público.';

revoke execute on function public.admin_product_search(text, text, boolean, uuid, integer, integer) from public;
grant execute on function public.admin_product_search(text, text, boolean, uuid, integer, integer) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- El buscador de productos relacionables
-- ---------------------------------------------------------------------------
create or replace function public.admin_relation_search(
  p_query text default null,
  p_template_ids uuid[] default null,
  p_exclude uuid default null,
  p_limit integer default 50
)
returns uuid[]
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  v_termino text := coalesce(public.search_normalize(p_query), '');
  v_corto boolean := v_termino <> '' and length(v_termino) < 3;
  v_pattern text := '%' || v_termino || '%';
  v_prefijo text := v_termino || '%';
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  return array(
    select product.id
    from public.products product
    where product.is_active
      and (
        v_termino = ''
        or (v_corto and product.id in (
              select proyeccion.product_id
              from public.variant_search_codes codigo
              join public.variant_search_projection proyeccion
                on proyeccion.variant_id = codigo.variant_id
              where codigo.normalized_code like v_prefijo))
        or (not v_corto and product.search_text like v_pattern)
      )
      and (p_exclude is null or product.id <> p_exclude)
      and (p_template_ids is null or product.template_id = any(p_template_ids))
    order by product.name
    limit v_limit
  );
end;
$function$;

comment on function public.admin_relation_search(text, uuid[], uuid, integer) is
  'Qué productos se pueden relacionar con otro. Devuelve identificadores ya acotados y ordenados; los filtros de plantilla los decide quien pregunta, porque dependen del propósito de la relación.';

revoke execute on function public.admin_relation_search(text, uuid[], uuid, integer) from public;
grant execute on function public.admin_relation_search(text, uuid[], uuid, integer) to authenticated, service_role;

commit;
