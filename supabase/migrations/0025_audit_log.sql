-- Vertical 1 · Organización, sede y rol de vendedora (3 de 3).
--
-- Antes de esta migración, en 32 tablas solo existían tres columnas de autoría
-- (orders.created_by, import_batches.created_by y pdf_exports.generated_by). No
-- se podía saber quién modificó un producto, un precio o una disponibilidad.
--
-- El Bloque 2 exige que las vendedoras registren anulaciones y devoluciones sin
-- aprobación previa, con trazabilidad completa (reglas 7 y 8 del plan). Eso es
-- inauditable sin una bitácora, y añadirla después, con datos reales, cuesta
-- mucho más. Ver docs/arquitectura.md, Organización y seguridad.

begin;

create table public.audit_log (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id uuid references auth.users(id) on delete set null,
  actor_role public.app_role,
  branch_id uuid references public.branches(id) on delete set null,
  table_name text not null,
  record_id uuid,
  action text not null,
  changed_fields text[],
  old_values jsonb,
  new_values jsonb,
  constraint audit_log_action_check check (action in ('insert', 'update', 'delete')),
  constraint audit_log_table_not_blank check (length(trim(table_name)) > 0)
);

comment on table public.audit_log is
  'Bitácora de cambios, de solo adición. Ni la propietaria puede editarla ni borrarla.';

create index audit_log_record_idx on public.audit_log(table_name, record_id, occurred_at desc);
create index audit_log_actor_idx on public.audit_log(actor_id, occurred_at desc);
create index audit_log_occurred_idx on public.audit_log(occurred_at desc);
create index audit_log_branch_idx on public.audit_log(branch_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Registro genérico
-- ---------------------------------------------------------------------------

create or replace function public.record_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_app_role public.app_role;
  actor_branch_id uuid;
  affected_record_id uuid;
  old_json jsonb;
  new_json jsonb;
  changed text[];
begin
  select p.role into actor_app_role
  from public.admin_profiles p
  where p.id = actor;

  -- La sede no se deduce de la fila: es dónde estaba operando la persona.
  actor_branch_id := public.default_branch_id(actor);

  if tg_op = 'DELETE' then
    -- `search_document` es un tsvector generado: ruido enorme y sin valor forense.
    old_json := to_jsonb(old) - 'search_document';
    affected_record_id := (old_json ->> 'id')::uuid;
  elsif tg_op = 'INSERT' then
    new_json := to_jsonb(new) - 'search_document';
    affected_record_id := (new_json ->> 'id')::uuid;
  else
    old_json := to_jsonb(old) - 'search_document';
    new_json := to_jsonb(new) - 'search_document';
    affected_record_id := (new_json ->> 'id')::uuid;

    select array_agg(entry.key order by entry.key) into changed
    from jsonb_each(new_json) entry
    where entry.value is distinct from (old_json -> entry.key)
      and entry.key <> 'updated_at';

    -- Un `updated_at` que se mueve solo no es un cambio que auditar.
    if changed is null then
      return null;
    end if;
  end if;

  insert into public.audit_log (
    actor_id, actor_role, branch_id, table_name, record_id,
    action, changed_fields, old_values, new_values
  ) values (
    actor, actor_app_role, actor_branch_id, tg_table_name, affected_record_id,
    lower(tg_op), changed, old_json, new_json
  );

  return null;
end;
$$;

revoke all on function public.record_audit() from public;

-- ---------------------------------------------------------------------------
-- Solo adición: nadie edita ni borra la bitácora
-- ---------------------------------------------------------------------------

create or replace function public.reject_audit_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using
    errcode = '42501',
    message = 'La bitácora de auditoría es de solo lectura.';
end;
$$;

revoke all on function public.reject_audit_mutation() from public;

create trigger audit_log_append_only
before update or delete on public.audit_log
for each row execute function public.reject_audit_mutation();

-- ---------------------------------------------------------------------------
-- Tablas auditadas
-- ---------------------------------------------------------------------------
-- Catálogo comercial, pedidos y la propia organización. Las tablas de
-- diccionario (plantillas, atributos, opciones) quedan fuera a propósito:
-- cambian por migración, no por operación diaria.

do $$
declare
  audited text;
begin
  foreach audited in array array[
    'products',
    'product_variants',
    'variant_prices',
    'wholesale_rules',
    'orders',
    'order_items',
    'companies',
    'branches',
    'staff_branches',
    'admin_profiles'
  ]
  loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I
       for each row execute function public.record_audit()',
      'audit_' || audited,
      audited
    );
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table public.audit_log enable row level security;

-- Solo lectura, y solo para administración. No se declara ninguna política de
-- escritura: el registro entra por un trigger `security definer`, nunca por
-- PostgREST.
create policy "admins read audit log"
on public.audit_log for select to authenticated
using (public.is_admin());

grant select on public.audit_log to authenticated;
revoke insert, update, delete on public.audit_log from authenticated, anon, service_role;

commit;
