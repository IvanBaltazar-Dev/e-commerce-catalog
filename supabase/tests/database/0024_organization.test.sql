begin;

create extension if not exists pgtap with schema extensions;

select plan(18);

-- ---------------------------------------------------------------------------
-- Estructura
-- ---------------------------------------------------------------------------

select ok(
  exists (
    select 1
    from pg_enum value
    join pg_type type on type.oid = value.enumtypid
    join pg_namespace namespace on namespace.oid = type.typnamespace
    where namespace.nspname = 'public'
      and type.typname = 'app_role'
      and value.enumlabel = 'seller'
  ),
  'app_role incluye seller'
);

select has_table('public', 'companies', 'Existe la empresa');
select has_table('public', 'branches', 'Existen las sedes');
select has_table('public', 'staff_branches', 'Existe la asignación de personal a sedes');
-- `orders` se retiró en 0029 y `sales` heredó el concepto de operación de venta
-- con su sede obligatoria: la aserción de 0024 se mantiene, apuntando a la
-- tabla que hoy la sostiene.
select has_column('public', 'sales', 'branch_id', 'Toda venta guarda su sede');
select col_not_null('public', 'sales', 'branch_id', 'La sede de la venta es obligatoria');
select has_function('public', 'staff_branch_ids', array['uuid'], 'Existe la resolución de sedes por persona');
select has_function('public', 'default_branch_id', array['uuid'], 'Existe la sede por defecto');

-- La migración deja la organización utilizable desde el primer arranque.
select is(
  (select count(*)::integer from public.branches where is_active and is_default),
  1,
  'Hay exactamente una sede predeterminada activa'
);

-- ---------------------------------------------------------------------------
-- Personal
-- ---------------------------------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-org-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'seller-org-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'retired-org-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.admin_profiles(id, role, full_name, is_active)
values
  ('20000000-0000-4000-8000-000000000001', 'admin', 'Propietaria de prueba', true),
  ('20000000-0000-4000-8000-000000000002', 'seller', 'Vendedora de prueba', true),
  ('20000000-0000-4000-8000-000000000003', 'admin', 'Administradora retirada', false);

select ok(public.is_staff('20000000-0000-4000-8000-000000000002'), 'La vendedora es personal activo');
select ok(public.is_seller('20000000-0000-4000-8000-000000000002'), 'La vendedora tiene su propio rol');
select isnt(public.is_admin('20000000-0000-4000-8000-000000000002'), true, 'La vendedora no hereda permisos administrativos');
select isnt(public.is_admin('20000000-0000-4000-8000-000000000003'), true, 'Un perfil desactivado pierde el acceso administrativo');
select isnt(public.is_staff('20000000-0000-4000-8000-000000000003'), true, 'Un perfil desactivado deja de ser personal activo');

-- ---------------------------------------------------------------------------
-- Alcance por sede
-- ---------------------------------------------------------------------------

select is(
  (select count(*)::integer from public.staff_branch_ids('20000000-0000-4000-8000-000000000002')),
  0,
  'Una vendedora sin asignación no alcanza ninguna sede'
);

insert into public.staff_branches (staff_id, branch_id, is_primary)
select '20000000-0000-4000-8000-000000000002', id, true
from public.branches
where is_default and is_active;

select is(
  (select count(*)::integer from public.staff_branch_ids('20000000-0000-4000-8000-000000000002')),
  1,
  'Una vez asignada, la vendedora alcanza su sede'
);

select is(
  (select count(*)::integer from public.staff_branch_ids('20000000-0000-4000-8000-000000000001')),
  (select count(*)::integer from public.branches where is_active),
  'La administración alcanza todas las sedes activas'
);

-- ---------------------------------------------------------------------------
-- La empresa no puede quedarse sin sede predeterminada
-- ---------------------------------------------------------------------------

-- La guarda es un trigger diferido: sin esto se evaluaría en el commit, que
-- nunca llega porque la prueba termina en rollback.
set constraints all immediate;

select throws_ok(
  $$
    update public.branches set is_default = false where is_default;
  $$,
  '23514',
  'La empresa debe conservar una sede predeterminada activa.',
  'No se puede dejar a la empresa sin sede predeterminada'
);

select * from finish();

rollback;
