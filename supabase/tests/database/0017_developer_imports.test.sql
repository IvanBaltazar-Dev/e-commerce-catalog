begin;

create extension if not exists pgtap with schema extensions;

select plan(9);

select ok(
  exists (
    select 1
    from pg_enum value
    join pg_type type on type.oid = value.enumtypid
    join pg_namespace namespace on namespace.oid = type.typnamespace
    where namespace.nspname = 'public'
      and type.typname = 'app_role'
      and value.enumlabel = 'developer'
  ),
  'app_role incluye developer'
);
select has_function('public', 'is_developer', array['uuid'], 'Existe el control de rol developer');
select has_column('public', 'import_batches', 'file_sha256', 'La auditoría conserva SHA-256');
select has_column('public', 'import_batches', 'security_report', 'La auditoría conserva el reporte de seguridad');
select has_column('public', 'import_batches', 'committed_at', 'La auditoría registra la confirmación');

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'developer-import-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', ''),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'admin-import-test@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.admin_profiles(id, role, full_name)
values
  ('10000000-0000-4000-8000-000000000001', 'developer', 'Developer import test'),
  ('10000000-0000-4000-8000-000000000002', 'admin', 'Admin import test');

select ok(public.is_admin('10000000-0000-4000-8000-000000000001'), 'developer conserva permisos administrativos');
select ok(public.is_developer('10000000-0000-4000-8000-000000000001'), 'developer puede usar rutas exclusivas');
select isnt(public.is_developer('10000000-0000-4000-8000-000000000002'), true, 'admin no recibe permiso developer implícito');

select throws_ok(
  $$
    insert into public.import_batches(source_type, source_name, file_sha256)
    values ('xlsx', 'test', 'hash-invalido')
  $$,
  '23514',
  null,
  'La auditoría rechaza hashes que no sean SHA-256 hexadecimal'
);

select * from finish();

rollback;
