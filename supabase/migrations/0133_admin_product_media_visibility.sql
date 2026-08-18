-- 0133 · Que la lista de productos diga qué falta fotografiar.
--
-- La dueña abre /admin/productos y no ve ni una imagen. No es que falten: hay
-- 228 medios publicables cargados. Es que la lista los busca donde no están.
--
--   products.main_image_path   → null en los 1.051 productos
--   product_images             → 0 filas (tabla heredada; nadie escribe ahí)
--   product_media              → 228 filas, colgadas de VARIANTES
--
-- La lista dibuja la miniatura desde main_image_path y pide la galería a
-- product_images. Dos fuentes vacías mientras la foto vive en una tercera.
--
-- Y el dato de qué falta ya existe: 1.048 de 1.051 productos no tienen ninguna
-- imagen alcanzable. Estaba en la base y no llegaba a ninguna pantalla, así que
-- la única forma de saber qué queda por fotografiar era preguntar a la base.
--
-- Esta migración no carga imágenes ni cambia una sola: expone el estado que ya
-- existe y deja filtrar por él.
--
-- Qué cuenta como «tiene foto» no se decide aquí. Lo decidió 0131 con las clases
-- de evidencia, y catalog_media_publishable_v1 es su única expresión. Esta vista
-- la consume; no reconstruye el criterio ni vuelve a mirar el `publishGate` de
-- los metadatos, que es residuo anterior a esa decisión.

begin;

-- Las vistas cambian de forma —el estado y la portada se separan—, y
-- `create or replace` no puede quitarle una columna a una vista existente.
drop view if exists public.admin_product_media_cover;
drop view if exists public.admin_product_media_state;
drop view if exists public.admin_product_media_alcance;

-- La RLS de media_assets pregunta `is_public_catalog_media(id)`, que busca en
-- product_media por media_asset_id. Esa columna no tenía índice propio: los dos
-- únicos que la incluyen la llevan en segunda posición, detrás de product_id o
-- de variant_id, y no sirven para buscar por ella sola. El catálogo público
-- paga ese barrido en cada lectura de imagen.
create index if not exists product_media_media_asset_idx
  on public.product_media (media_asset_id);

-- Quién puede leer el panel. Se nombra una vez porque lo preguntan tres vistas,
-- y tres copias de una condición de permiso son tres sitios donde puede quedar
-- desactualizada.
--
-- El rol de servicio entra: los scripts de mantenimiento y las pruebas de
-- contrato llaman sin sesión de usuario, y `auth.uid()` es null ahí. Dejarlo
-- fuera no protege nada —el rol de servicio ya puede leerlo todo— y en cambio
-- vacía la vista para el arnés que la verifica.
create or replace function public.is_panel_reader()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select coalesce(auth.role(), '') = 'service_role' or public.is_admin();
$$;

comment on function public.is_panel_reader() is
  'Quién ve los datos del panel: administración o el rol de servicio. Guarda de '
  'las vistas admin_product_media_*, que no son security_invoker a propósito.';

revoke execute on function public.is_panel_reader() from public;
grant execute on function public.is_panel_reader() to authenticated, service_role;

-- Una imagen alcanza a un producto por dos caminos: colgada del producto, o
-- colgada de una de sus variantes. La segunda es la que la lista ignoraba, y es
-- donde están las 228.
--
-- Son dos vistas y no una por una razón de coste, no de gusto. La lista
-- necesita el ESTADO de los 1.051 productos —para contar cobertura y para
-- filtrar— pero la PORTADA solo de los 8 que va a pintar. Juntas en una vista,
-- pedir el estado obligaba a elegir portada para el catálogo entero: 800 ms de
-- trabajo tirado en cada carga.
-- ── Por qué estas tres vistas NO son security_invoker ──────────────────────
--
-- La convención de la casa es security_invoker, y por una razón buena: sin él
-- una vista corre como su dueño y la vendedora vería las cifras de la dueña.
-- Aquí esa razón se respeta por otro camino, y hace falta.
--
-- Con security_invoker, leer media_assets aplica su RLS, que es:
--
--   is_public_catalog_media(id) OR is_admin(...)
--
-- Un OR no se ordena por coste: PostgreSQL evalúa la rama tal como está, y la
-- cara va primera. Medido, para una sesión de administración que iba a pasar
-- por `is_admin` de todas formas:
--
--   Seq Scan on media_assets ... 268 ms   ← is_public_catalog_media por fila
--   Index Scan on product_media ... 205 ms ← y otra vez, anidada
--   Execution Time: 477 ms
--
-- Se paga el permiso del público 228 veces para no usarlo ninguna. Y no se
-- arregla con índices ni con COST: se probaron ambos y el orden del OR no
-- cambia.
--
-- Con la guarda explícita `where public.is_panel_reader()`, la misma pregunta se
-- hace UNA vez para toda la consulta —el plan la muestra como One-Time Filter—
-- y quien no es administración no obtiene ninguna fila: la propiedad que
-- protegía security_invoker sigue en pie, y sin el peaje.
--
-- Estas vistas son del panel y de nadie más. Si alguna vez tienen que servir al
-- catálogo público, no se relaja la guarda: se hace otra vista.
create or replace view public.admin_product_media_alcance as
select
  coalesce(publicable.product_id, variante.product_id) as product_id,
  publicable.media_asset_id,
  publicable.storage_path,
  publicable.evidence_class,
  publicable.is_fallback,
  publicable.media_role,
  publicable.is_primary,
  publicable.product_id is not null as colgada_del_producto
from public.catalog_media_publishable_v1 publicable
left join public.product_variants variante on variante.id = publicable.variant_id
where coalesce(publicable.product_id, variante.product_id) is not null
  and public.is_panel_reader();

comment on view public.admin_product_media_alcance is
  'Qué imagen publicable alcanza a qué producto, directamente o por una de sus '
  'variantes. Base común del estado y de la portada.';

-- El estado: una agregación sobre las imágenes que existen. Barata aunque se
-- pida para el catálogo entero, porque agrupa 228 filas, no 1.051.
create or replace view public.admin_product_media_state as
select
  producto.id as product_id,
  coalesce(conteo.fotos_total, 0) as fotos_total,
  coalesce(conteo.fotos_envase, 0) as fotos_envase,
  coalesce(conteo.fotos_construidas, 0) as fotos_construidas,
  -- Tres estados, no dos. «Solo respaldo» es tener el color pero no el envase:
  -- se puede enseñar, pero sigue faltando la foto del producto.
  case
    when coalesce(conteo.fotos_total, 0) = 0 then 'sin_foto'
    when coalesce(conteo.fotos_de_producto, 0) = 0 then 'solo_respaldo'
    else 'con_foto'
  end as estado_foto
from public.products producto
left join (
  select
    product_id,
    count(*)::integer as fotos_total,
    count(*) filter (where evidence_class = 'FOTO_REAL')::integer as fotos_envase,
    count(*) filter (where evidence_class = 'VISUAL_ESTANDARIZADO')::integer as fotos_construidas,
    count(*) filter (where not is_fallback)::integer as fotos_de_producto
  from public.admin_product_media_alcance
  group by product_id
) conteo on conteo.product_id = producto.id
where public.is_panel_reader();

comment on view public.admin_product_media_state is
  'Estado fotográfico por producto, contando las imágenes que llegan por sus '
  'variantes. Consume catalog_media_publishable_v1: el criterio de qué se puede '
  'enseñar vive en las clases de evidencia (0131), no aquí.';

-- La portada: qué miniatura representa al producto. El orden es el de una
-- vitrina: primero la del envase concreto, luego la del producto antes que la
-- de una variante suelta, y a igualdad de todo, la marcada como principal.
--
-- Sin CTE intermedia a propósito: así el filtro por product_id llega hasta el
-- índice en vez de materializar el catálogo entero para devolver ocho filas.
create or replace view public.admin_product_media_cover as
select distinct on (product_id)
  product_id,
  storage_path as portada_path
from public.admin_product_media_alcance
order by
  product_id,
  is_fallback asc,
  (evidence_class = 'FOTO_REAL') desc,
  colgada_del_producto desc,
  is_primary desc,
  (media_role = 'main') desc,
  storage_path;

comment on view public.admin_product_media_cover is
  'La imagen que representa a cada producto en una lista. Se consulta por los '
  'ids de una página, nunca para el catálogo entero.';

grant select on public.admin_product_media_alcance to authenticated, service_role;
grant select on public.admin_product_media_state to authenticated, service_role;
grant select on public.admin_product_media_cover to authenticated, service_role;

-- El filtro «Sin foto» tiene que decidirse donde se pagina. Resolverlo en el
-- cliente sobre una página de 8 daría un contador que miente: 1.048 productos
-- sin foto no caben en la página que la dueña está mirando.
--
-- Y devuelve los conteos junto con la página, porque «¿cuánto falta?» es la
-- misma pregunta que «¿qué veo?». Pedirlos aparte daría dos números tomados en
-- dos momentos distintos.
--
-- Cada dimensión se cuenta ignorando su propio filtro. Si se contaran sobre el
-- conjunto ya filtrado, elegir «Sin foto» dejaría «Con foto» en cero y la dueña
-- perdería el camino de vuelta: el contador tiene que seguir diciendo cuántos
-- hay del otro lado.
create or replace function public.admin_product_search(
  p_query text default null,
  p_estado text default null,
  p_active boolean default null,
  p_brand_id uuid default null,
  p_limit integer default 24,
  p_offset integer default 0,
  p_foto text default null
)
returns jsonb
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_termino text := coalesce(public.search_normalize(p_query), '');
  v_corto boolean := v_termino <> '' and length(v_termino) < 3;
  v_pattern text := '%' || v_termino || '%';
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 200);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_result jsonb;
begin
  if p_estado is not null and p_estado not in ('publicado', 'borrador', 'oculto') then
    raise exception using errcode = '22023', message = 'Estado de producto no permitido.';
  end if;

  if p_foto is not null and p_foto not in ('con_foto', 'solo_respaldo', 'sin_foto') then
    raise exception using errcode = '22023', message = 'Estado fotográfico no permitido.';
  end if;

  -- `materialized` no es decoración. Sin ella la CTE se vuelve a ejecutar en
  -- cada `count(*)` que la mira —seis veces— y el barrido de 1.051 productos
  -- con RLS por fila se paga seis veces: 850 ms donde debería haber 110.
  with base as materialized (
    select
      product.id,
      product.sort_order,
      product.name,
      media.estado_foto,
      media.fotos_total,
      -- El estado de publicación se nombra una sola vez y de aquí salen tanto
      -- el filtro como el contador. Antes el filtro vivía en un OR de tres
      -- ramas y nadie contaba nada, así que no había dos definiciones que
      -- pudieran discrepar. Ahora que se cuenta, sí las habría.
      case
        when product.editorial_status = 'hidden' or not product.is_active then 'oculto'
        when product.editorial_status = 'published' then 'publicado'
        else 'borrador'
      end as estado_publicacion
    from public.products product
    -- La vista tiene una fila por producto, así que el join no multiplica ni
    -- cambia el total que la paginación ya calculaba.
    join public.admin_product_media_state media on media.product_id = product.id
    where
      -- Misma normalización y misma regla de términos cortos que el POS y el
      -- catálogo. Es el sentido de tener contrato: una sola definición.
      (
        v_termino = ''
        or (v_corto and product.id in (
              select proyeccion.product_id
              from public.variant_ids_by_short_code(case when v_corto then v_termino else null end) as ids(variant_id)
              join public.variant_search_projection proyeccion
                on proyeccion.variant_id = ids.variant_id))
        or (not v_corto and product.search_text like v_pattern)
      )
      and (p_active is null or product.is_active = p_active)
      and (p_brand_id is null or product.brand_id = p_brand_id)
  ),
  -- Los tres conteos y el total salen de UNA pasada sobre `base`. Antes eran
  -- seis subconsultas independientes; el resultado era el mismo y el trabajo
  -- seis veces mayor.
  conteos as (
    select
      count(*) filter (where cumple_estado and cumple_foto)::integer as total,
      count(*) filter (where cumple_estado and estado_foto = 'con_foto')::integer as foto_con,
      count(*) filter (where cumple_estado and estado_foto = 'solo_respaldo')::integer as foto_respaldo,
      count(*) filter (where cumple_estado and estado_foto = 'sin_foto')::integer as foto_sin,
      count(*) filter (where cumple_foto and estado_publicacion = 'publicado')::integer as pub_publicado,
      count(*) filter (where cumple_foto and estado_publicacion = 'borrador')::integer as pub_borrador,
      count(*) filter (where cumple_foto and estado_publicacion = 'oculto')::integer as pub_oculto
    from (
      select
        estado_foto,
        estado_publicacion,
        p_estado is null or estado_publicacion = p_estado as cumple_estado,
        p_foto is null or estado_foto = p_foto as cumple_foto
      from base
    ) marcado
  ),
  pagina as (
    select id, estado_foto, fotos_total, sort_order, name
    from base
    where (p_estado is null or estado_publicacion = p_estado)
      and (p_foto is null or estado_foto = p_foto)
    -- El `id` no es decoración: sin él el orden no es total. Hay seis productos
    -- llamados «Top Coat» con el mismo sort_order, y con empates PostgreSQL
    -- devuelve el que quiera. Eso no solo hacía inestable el orden de una
    -- página: paginando 132 páginas, un producto empatado podía salir dos veces
    -- y otro no salir nunca.
    order by sort_order asc, name asc, id asc
    offset v_offset
    limit v_limit
  ),
  -- La portada se elige solo para las filas que se van a pintar.
  pagina_con_portada as (
    select pagina.*, cover.portada_path
    from pagina
    left join public.admin_product_media_cover cover on cover.product_id = pagina.id
  )
  select jsonb_build_object(
    'ids', coalesce(
      (select jsonb_agg(id order by sort_order asc, name asc, id asc) from pagina_con_portada),
      '[]'::jsonb
    ),
    -- El estado fotográfico de la página viaja aquí, no en una segunda vuelta.
    -- Pedirlo aparte a la vista costaba 1,5–2,6 s: PostgREST no empujaba el
    -- filtro por id y materializaba los 1.051 productos para devolver 8.
    'media', coalesce((select jsonb_object_agg(id, jsonb_build_object(
        'estado_foto', estado_foto,
        'fotos_total', fotos_total,
        'portada_path', portada_path
      )) from pagina_con_portada), '{}'::jsonb),
    'total', (select total from conteos),
    'cobertura', jsonb_build_object(
      'con_foto', (select foto_con from conteos),
      'solo_respaldo', (select foto_respaldo from conteos),
      'sin_foto', (select foto_sin from conteos)
    ),
    'publicacion', jsonb_build_object(
      'publicado', (select pub_publicado from conteos),
      'borrador', (select pub_borrador from conteos),
      'oculto', (select pub_oculto from conteos)
    )
  ) into v_result;

  return v_result;
end;
$function$;

comment on function public.admin_product_search(text, text, boolean, uuid, integer, integer, text) is
  'Búsqueda paginada del panel. Devuelve ids, total, cobertura fotográfica y '
  'reparto de publicación del conjunto filtrado. Cada conteo ignora su propio '
  'filtro para que elegir una opción no borre el camino a las otras.';

revoke execute on function public.admin_product_search(text, text, boolean, uuid, integer, integer, text) from public;
grant execute on function public.admin_product_search(text, text, boolean, uuid, integer, integer, text) to authenticated, service_role;

-- La firma de 6 argumentos queda sin uso: el parámetro nuevo tiene default y
-- toda llamada resuelve a la de 7. Dejarla viva permitiría llamar por accidente
-- a una versión sin cobertura.
drop function if exists public.admin_product_search(text, text, boolean, uuid, integer, integer);

commit;
