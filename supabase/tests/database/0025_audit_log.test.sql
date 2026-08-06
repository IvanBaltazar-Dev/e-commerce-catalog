begin;

create extension if not exists pgtap with schema extensions;

select plan(10);

select has_table('public', 'audit_log', 'Existe la bitácora de auditoría');
select has_function('public', 'record_audit', 'Existe el registrador genérico');

-- Los seeds ya escriben en la bitácora: prueba de que los triggers están vivos
-- sin depender de que la prueba genere el primer movimiento.
select cmp_ok(
  (select count(*)::integer from public.audit_log),
  '>',
  0,
  'Los cambios del seed quedaron registrados'
);

-- ---------------------------------------------------------------------------
-- Solo adición
-- ---------------------------------------------------------------------------

select throws_ok(
  $$ update public.audit_log set action = 'insert' where id = (select min(id) from public.audit_log) $$,
  '42501',
  'La bitácora de auditoría es de solo lectura.',
  'Nadie edita la bitácora, ni la propietaria'
);

select throws_ok(
  $$ delete from public.audit_log where id = (select min(id) from public.audit_log) $$,
  '42501',
  'La bitácora de auditoría es de solo lectura.',
  'Nadie borra la bitácora, ni la propietaria'
);

-- ---------------------------------------------------------------------------
-- Registro de un cambio real
-- ---------------------------------------------------------------------------

create temporary table audit_baseline on commit drop as
select coalesce(max(id), 0) as last_id from public.audit_log;

update public.products
set name = name || ' (auditado)'
where slug = 'demo-masglo-gel-evolution';

select is(
  (
    select count(*)::integer
    from public.audit_log a, audit_baseline b
    where a.id > b.last_id
      and a.table_name = 'products'
      and a.action = 'update'
  ),
  1,
  'Editar un producto deja exactamente un asiento'
);

select ok(
  (
    select 'name' = any(a.changed_fields)
    from public.audit_log a, audit_baseline b
    where a.id > b.last_id and a.table_name = 'products' and a.action = 'update'
    order by a.id desc
    limit 1
  ),
  'El asiento identifica el campo que cambió'
);

-- `updated_at` se mueve solo en cada escritura: si fuese el único cambio, no
-- habría nada que auditar.
update public.products
set updated_at = now()
where slug = 'demo-masglo-gel-evolution';

select is(
  (
    select count(*)::integer
    from public.audit_log a, audit_baseline b
    where a.id > b.last_id
      and a.table_name = 'products'
      and a.action = 'update'
  ),
  1,
  'Un updated_at aislado no genera ruido en la bitácora'
);

-- ---------------------------------------------------------------------------
-- La bitácora sobrevive al borrado de lo que menciona (regresión de 0026)
-- ---------------------------------------------------------------------------
-- Con `actor_id` como FK `on delete set null`, borrar un usuario disparaba un
-- UPDATE interno sobre audit_log que el trigger de solo-adición rechazaba.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
)
values ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'auditoria-borrado@example.invalid', '', now(), '{}', '{}', now(), now(), '', '', '', '');

insert into public.admin_profiles(id, role, full_name)
values ('40000000-0000-4000-8000-000000000001', 'admin', 'Administradora que se va');

set local request.jwt.claims = '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated"}';
update public.products set sort_order = sort_order + 1 where slug = 'demo-masglo-gel-evolution';
reset request.jwt.claims;

select ok(
  (
    select actor_label = 'Administradora que se va'
    from public.audit_log
    where actor_id = '40000000-0000-4000-8000-000000000001'
    order by id desc
    limit 1
  ),
  'El asiento conserva una etiqueta legible del actor'
);

select lives_ok(
  $$ delete from auth.users where id = '40000000-0000-4000-8000-000000000001' $$,
  'Se puede borrar un usuario que ya dejó asientos en la bitácora'
);

select * from finish();

rollback;
