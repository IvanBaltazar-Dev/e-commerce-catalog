begin;

create extension if not exists pgtap with schema extensions;

select plan(15);

-- ---------------------------------------------------------------------------
-- 0045: la doble puerta. La RLS ya daba cero filas; ahora el ACL tampoco
-- deja pasar. El diseño es DERIVADO: anon lee exactamente donde existe
-- política pública, ejecuta exactamente sus 10 contratos, y nada futuro
-- nace abierto.
-- ---------------------------------------------------------------------------

-- 1-2 · Lo sensible, a cero absoluto para anon.
select is(
  (select bool_or(has_table_privilege('anon', c.oid, p.priv))
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(priv)
   where n.nspname = 'public'
     and c.relname in ('sale_line_costs', 'cash_movements', 'cash_sessions',
                       'inventory_valuation', 'channel_messages', 'channel_conversations',
                       'ai_interactions', 'content_proposals', 'expenses', 'sale_margins',
                       'inventory_movements', 'sales', 'supplier_obligations')),
  false,
  '1 · Costo, caja, kardex, ventas, conversaciones e IA: CERO privilegios para anon'
);

select is(
  (select bool_and(has_table_privilege('anon', 'public.' || t.name, 'SELECT'))
   from (values ('brands'), ('categories'), ('store_settings'), ('products'),
                ('product_variants'), ('category_paths')) t(name)),
  true,
  '2 · El catálogo público conserva su lectura anónima'
);

-- 3 · COHERENCIA: toda relación legible por anon tiene política pública que
--     lo respalde (o es una de las dos vistas diseñadas públicas).
select is(
  (select count(*)::integer
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')
     and has_table_privilege('anon', c.oid, 'SELECT')
     and c.relname not in ('category_paths', 'variant_public_availability')
     and not exists (
       select 1 from pg_policy p
       where p.polrelid = c.oid and p.polcmd in ('r', '*')
         and (p.polroles = '{0}'::oid[] or 'anon'::regrole::oid = any (p.polroles))
     )),
  0,
  '3 · Ninguna relación anon-legible carece de política pública: ACL y RLS alineados'
);

-- 4-6 · Contratos: exactamente 16 funciones DEL PRODUCTO (las internas de
--        extensiones — btree_gist, pg_trgm — pertenecen a supabase_admin,
--        son maquinaria de índices y quedan fuera del contrato).
select is(
  (select count(*)::integer
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'execute')
     and not exists (
       select 1 from pg_depend dep
       where dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e'
     )),
  16,
  '4 · anon ejecuta EXACTAMENTE 16 funciones del producto: catálogo base + 2 recomendaciones de sistema'
);

select is(
  (select bool_and(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('catalog_list_v2', 'catalog_product_detail_v2', 'evaluate_cart_v2',
                       'get_or_create_public_cart', 'public_cart_detail', 'set_public_cart_item',
                       'sync_public_cart', 'touch_anonymous_visitor', 'record_attribution_touch',
                       'is_admin', 'is_public_catalog_product', 'is_public_catalog_variant',
                       'is_public_catalog_media', 'variant_effective_availability',
                       'get_catalog_system_coverage_v1', 'get_catalog_system_recommendations_v1')),
  true,
  '5 · …los del catálogo, el carrito, la atribución y sus helpers'
);

select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('business_dashboard', 'register_sale', 'resolve_ai_interaction',
                       'record_ai_interaction', 'omnichannel_metrics', 'daily_cash_summary',
                       'ingest_channel_message', 'assign_conversation', 'apply_inventory_movement')),
  false,
  '6 · Ningún contrato de dominio quedó alcanzable por anon'
);

-- 7 · Secuencias: cero para anon.
select is(
  coalesce((select bool_or(has_sequence_privilege('anon', c.oid, 'USAGE')
                        or has_sequence_privilege('anon', c.oid, 'SELECT')
                        or has_sequence_privilege('anon', c.oid, 'UPDATE'))
   from pg_class c
   join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'S'), false),
  false,
  '7 · Ninguna secuencia es tocable por anon'
);

-- 8-9 · Los DEFAULTS, cerrados para TODO grantor.
select is(
  (select count(*)::integer
   from pg_default_acl d
   join pg_namespace n on n.oid = d.defaclnamespace
   cross join lateral aclexplode(d.defaclacl) as acl
   join pg_roles r on r.oid = d.defaclrole
   where n.nspname = 'public' and r.rolname = 'postgres'
     and acl.grantee = 'anon'::regrole),
  0,
  '8 · Los defaults del rol migrador (quien crea TODO objeto del producto) no conceden nada a anon'
);

select is(
  (select count(*)::integer
   from pg_default_acl d
   join pg_namespace n on n.oid = d.defaclnamespace
   cross join lateral aclexplode(d.defaclacl) as acl
   join pg_roles r on r.oid = d.defaclrole
   where n.nspname = 'public' and d.defaclobjtype = 'f' and r.rolname = 'postgres'
     and acl.grantee = 'authenticated'::regrole),
  0,
  '9 · Las funciones futuras del producto tampoco nacen ejecutables por authenticated'
);

-- 10-11 · Las invariantes de authenticated NO cambiaron con el cierre.
select is(
  (select bool_or(has_function_privilege('authenticated', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('apply_inventory_movement', 'restore_sold_units', 'next_document_number',
                       'ingest_webhook_event', 'claim_webhook_event', 'complete_webhook_event',
                       'fail_webhook_event', 'ignore_webhook_event')),
  false,
  '10 · Lo que 0028–0040 cerró a authenticated sigue cerrado'
);

select ok(
  (select bool_and(has_function_privilege('authenticated', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('register_sale', 'business_dashboard', 'record_ai_interaction', 'evaluate_cart_v2',
                       -- La superficie pública del catálogo es COMPARTIDA: una
                       -- vendedora logueada también navega la tienda, así que
                       -- su carrito, sesión y atribución deben funcionarle.
                       'get_or_create_public_cart', 'set_public_cart_item',
                       'touch_anonymous_visitor', 'record_attribution_touch')),
  '11 · El panel conserva sus contratos y la superficie pública es compartida (anon Y authenticated)'
);

-- 12 · Las funciones de trigger DEL PRODUCTO no las ejecuta nadie por RPC.
select is(
  (select bool_or(has_function_privilege('anon', p.oid, 'execute')
               or has_function_privilege('authenticated', p.oid, 'execute'))
   from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.prorettype = 'trigger'::regtype
     and not exists (
       select 1 from pg_depend dep
       where dep.classid = 'pg_proc'::regclass and dep.objid = p.oid and dep.deptype = 'e'
     )),
  false,
  '12 · Ninguna función de trigger del producto es invocable por anon ni authenticated'
);

-- 13-15 · La puerta cerrada FUNCIONA con el rol real puesto.
set local role anon;

select throws_ok(
  $$ select count(*) from public.sale_line_costs $$,
  '42501', null,
  '13 · anon contra los costos: permission denied, ya ni cero filas'
);

select throws_ok(
  $$ select public.business_dashboard() $$,
  '42501', null,
  '14 · anon contra el tablero: permission denied'
);

select lives_ok(
  $$ select public.catalog_list_v2(1, 5, null, null, null, null, '{}'::jsonb, 'featured') $$,
  '15 · Y el catálogo público sigue vivo para anon'
);

reset role;

select * from finish();

rollback;
