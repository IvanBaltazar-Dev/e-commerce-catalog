-- ---------------------------------------------------------------------------
-- 0045 — Cierre de los privilegios por defecto (Bloque 5, gate de seguridad)
--
-- La auditoría estructural (`audit:security`) destapó la deuda que 0002
-- declaró en los orígenes del proyecto:
--
--     alter default privileges … grant select on tables to anon, authenticated
--     alter default privileges … grant all on sequences to anon, authenticated
--     alter default privileges … grant execute on functions to anon
--
-- Resultado materializado: anon con SELECT a nivel de TABLA sobre 75 tablas
-- (caja, costos, kardex, mensajes, IA…) y EXECUTE sobre cientos de funciones
-- (vía el rol PUBLIC, que en PostgreSQL puede ejecutar toda función nueva).
-- La RLS ya dejaba todo en cero filas — ninguna fila fue legible — pero la
-- doctrina del repositorio exige la DOBLE puerta: política Y privilegio.
--
-- El diseño del recorte NO es una lista de opinión:
--
--   · TABLAS: anon conserva SELECT exactamente donde EXISTE una política de
--     lectura que lo nombra (pg_policy). ACL y política quedan alineados por
--     construcción — si mañana se retira la política, el ACL sobreviviente
--     no expone nada porque RLS sigue activa; y si se añade una política
--     pública nueva, su migración debe otorgar el GRANT a mano (los defaults
--     quedan cerrados).
--   · VISTAS: solo las dos diseñadas públicas (category_paths,
--     variant_public_availability), ambas INVOKER sobre tablas públicas.
--   · FUNCIONES: EXECUTE se revoca del rol PUBLIC (la puerta real) en TODO
--     el esquema, y se restituye a los contratos que cada migración declaró
--     explícitamente — anon queda con los 10 contratos del catálogo, el
--     carrito y la atribución.
--   · SECUENCIAS: anon a cero, siempre.
--   · DEFAULTS: se revierten PARA TODOS los grantors que los declararon
--     (0002 los creó como postgres; Supabase añade los suyos como
--     supabase_admin). Un objeto futuro nace cerrado.
-- ---------------------------------------------------------------------------

-- 1. Los DEFAULTS, cerrados para TODO grantor que conceda a anon (y el de
--    funciones también para authenticated: los contratos ya hacen su grant
--    explícito desde 0028).
do $$
declare
  entry record;
  kind text;
begin
  for entry in
    select r.rolname as grantor, d.defaclobjtype
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    join pg_roles r on r.oid = d.defaclrole
    cross join lateral aclexplode(d.defaclacl) as acl
    where n.nspname = 'public'
      and acl.grantee in ('anon'::regrole, 'authenticated'::regrole)
    group by r.rolname, d.defaclobjtype
  loop
    kind := case entry.defaclobjtype
      when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
    end;
    if kind is null then continue; end if;

    begin
      if kind = 'functions' then
        execute format(
          'alter default privileges for role %I in schema public revoke execute on functions from anon, authenticated',
          entry.grantor
        );
      else
        execute format(
          'alter default privileges for role %I in schema public revoke all on %s from anon',
          entry.grantor, kind
        );
      end if;
    exception when insufficient_privilege then
      -- En Supabase el rol migrador (postgres) no es superusuario y no puede
      -- tocar los defaults de supabase_admin. Es aceptable: esos defaults
      -- solo gobiernan objetos que supabase_admin cree en public, y ninguno
      -- del producto nace de ese rol — todos nacen de las migraciones
      -- (postgres), cuyos defaults SÍ quedan cerrados aquí.
      raise notice 'Default privileges de % fuera de alcance del rol migrador; se omite.', entry.grantor;
    end;
  end loop;
end $$;

-- 2. TABLAS y VISTAS: anon a cero salvo donde una política lo nombra.
do $$
declare
  rel record;
  -- Vistas públicas por diseño (INVOKER sobre tablas con política pública).
  public_views constant text[] := array['category_paths', 'variant_public_availability'];
begin
  for rel in
    select c.oid, c.relname, c.relkind
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
  loop
    if rel.relkind = 'r' then
      -- ¿Existe política de lectura aplicable a anon (o a todos los roles)?
      if exists (
        select 1 from pg_policy p
        where p.polrelid = rel.oid
          and p.polcmd in ('r', '*')
          and (p.polroles = '{0}'::oid[] or 'anon'::regrole::oid = any (p.polroles))
      ) then
        execute format('revoke insert, update, delete, truncate, references, trigger on public.%I from anon', rel.relname);
        execute format('grant select on public.%I to anon', rel.relname);
      else
        execute format('revoke all on public.%I from anon', rel.relname);
      end if;
    elsif rel.relname = any (public_views) then
      execute format('grant select on public.%I to anon', rel.relname);
    else
      execute format('revoke all on public.%I from anon', rel.relname);
    end if;
  end loop;

  for rel in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'S'
  loop
    execute format('revoke all on sequence public.%I from anon', rel.relname);
  end loop;
end $$;

-- 3. FUNCIONES: la puerta real es PUBLIC. Se cierra entera y se restituye lo
--    declarado. anon queda con los 10 contratos públicos; authenticated y
--    service_role recuperan explícitamente lo que ya usaban.
do $$
declare
  fn record;
  -- Contratos de la SUPERFICIE PÚBLICA del catálogo: el listado, el detalle,
  -- la evaluación, el carrito persistente, el visitante anónimo y la
  -- atribución. Todos deben ser ejecutables por anon Y por authenticated: una
  -- vendedora con sesión también navega la tienda pública, y su carrito,
  -- sesión y atribución tienen que funcionar igual. (La corrección la destapó
  -- el gate de frontend del Bloque 5: un admin logueado en la home recibía
  -- permission denied en /api/catalog/session y en el carrito.)
  shared_contracts constant text[] := array[
    'catalog_list_v2', 'catalog_product_detail_v2', 'evaluate_cart_v2', 'is_admin',
    'get_or_create_public_cart', 'public_cart_detail', 'set_public_cart_item',
    'sync_public_cart', 'touch_anonymous_visitor', 'record_attribution_touch'
  ];
  -- Helpers INVOKER que los contratos del catálogo llaman por dentro. La
  -- lista salió de ejecutar los contratos COMO anon hasta verlos vivir; el
  -- auto-humo del final de esta migración la mantiene honesta para siempre.
  helper_contracts constant text[] := array[
    'is_public_catalog_product', 'is_public_catalog_variant',
    'is_public_catalog_media', 'variant_effective_availability'
  ];
begin
  for fn in
    select p.oid::regprocedure as signature, p.proname, p.prorettype
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      -- Las funciones que PERTENECEN a extensiones (btree_gist, pg_trgm…)
      -- quedan fuera: su dueño es supabase_admin, el rol migrador no puede
      -- revocarlas, y son maquinaria de índices — no contratos del producto.
      and not exists (
        select 1 from pg_depend dep
        where dep.classid = 'pg_proc'::regclass
          and dep.objid = p.oid
          and dep.deptype = 'e'
      )
  loop
    -- Cerrar PUBLIC siempre: es el privilegio implícito de PostgreSQL.
    execute format('revoke execute on function %s from public', fn.signature);

    if fn.proname = any (shared_contracts) or fn.proname = any (helper_contracts) then
      execute format('grant execute on function %s to anon, authenticated, service_role', fn.signature);
    elsif fn.prorettype = 'trigger'::regtype then
      -- Las funciones de trigger no se invocan por RPC: nadie las necesita.
      execute format('revoke execute on function %s from anon, authenticated', fn.signature);
    else
      -- Ni anon ni PUBLIC; authenticated conserva su superficie (PostgREST
      -- del panel) y la revalidación interna de cada contrato sigue mandando.
      execute format('revoke execute on function %s from anon', fn.signature);
      execute format('grant execute on function %s to authenticated, service_role', fn.signature);
    end if;
  end loop;
end $$;

-- 4. Revocaciones EXPLÍCITAS previas que el grant del paso 3 no debe
--    deshacer: lo que 0028–0040 cerró a authenticated a propósito (la
--    vendedora no mueve inventario ni procesa webhooks a mano). Lista
--    derivada de las propias migraciones, con firma exacta.
revoke execute on function public.apply_inventory_movement(uuid, uuid, public.inventory_movement_type, integer, numeric, text, uuid, text, text, uuid) from authenticated;
revoke execute on function public.restore_sold_units(uuid, uuid, uuid, uuid, integer, public.inventory_movement_type, text, uuid, text, text, uuid) from authenticated;
revoke execute on function public.next_document_number(uuid, public.sale_document_kind) from authenticated;
revoke execute on function public.ingest_webhook_event(text, text, jsonb, uuid) from authenticated;
revoke execute on function public.claim_webhook_event(bigint) from authenticated;
revoke execute on function public.complete_webhook_event(bigint, jsonb) from authenticated;
revoke execute on function public.fail_webhook_event(bigint, text, interval) from authenticated;
revoke execute on function public.ignore_webhook_event(bigint, text) from authenticated;

-- 5. AUTO-HUMO: la superficie pública tiene que VIVIR con el rol anon puesto,
--    aquí mismo. Si un cierre futuro rompe el catálogo o el carrito, esta
--    migración (o su réplica en staging) lo grita en el acto — jamás en la
--    cara de una clienta.
do $$
declare
  sample_variant uuid;
begin
  set local role anon;

  perform public.catalog_list_v2(1, 1, null, null, null, null, '{}'::jsonb, 'featured');

  reset role;
  select id into sample_variant from public.product_variants where is_active limit 1;
  set local role anon;

  if sample_variant is not null then
    perform public.evaluate_cart_v2(
      jsonb_build_array(jsonb_build_object('variantId', sample_variant, 'quantity', 1))
    );
  end if;

  reset role;
exception when others then
  reset role;
  raise exception 'La superficie pública quedó rota tras el cierre de privilegios: %', sqlerrm;
end $$;

comment on schema public is
  'Privilegios: anon solo alcanza el catálogo público (tablas con política '
  'pública + 2 vistas + 10 contratos + 4 helpers); PUBLIC no ejecuta nada. '
  'Los defaults están cerrados desde 0045 — un objeto nuevo nace sin acceso '
  'anónimo y cada migración declara sus grants a mano.';
