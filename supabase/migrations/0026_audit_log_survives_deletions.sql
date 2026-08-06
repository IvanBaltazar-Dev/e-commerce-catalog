-- Corrección de un defecto introducido en 0025_audit_log.sql.
--
-- `actor_id` y `branch_id` se declararon como claves foráneas `on delete set
-- null`. Al borrar un usuario o una sede, PostgreSQL ejecuta internamente
-- `update only public.audit_log set actor_id = null`, y el trigger
-- `audit_log_append_only` —que existe justamente para impedir cualquier
-- UPDATE— lo rechaza con 42501. Resultado: era imposible borrar un usuario o
-- una sede que tuviera cualquier asiento en la bitácora.
--
-- Reproducido en local antes de corregir:
--   delete from auth.users where id = '…'
--   → SQLSTATE 42501 «La bitácora de auditoría es de solo lectura.»
--
-- La corrección de fondo no es aflojar el trigger, sino reconocer qué es una
-- bitácora: un registro histórico que debe SOBREVIVIR a la desaparición de todo
-- lo que menciona. Un asiento que dice «la vendedora X bajó este precio» sigue
-- siendo cierto aunque X ya no exista. Por eso `actor_id` y `branch_id` pasan a
-- ser identificadores sueltos, sin integridad referencial, y se acompañan de una
-- etiqueta legible capturada en el momento del hecho.

begin;

alter table public.audit_log drop constraint if exists audit_log_actor_id_fkey;
alter table public.audit_log drop constraint if exists audit_log_branch_id_fkey;

comment on column public.audit_log.actor_id is
  'Identificador del usuario que actuó. Sin FK a propósito: la bitácora debe '
  'sobrevivir al borrado del usuario.';
comment on column public.audit_log.branch_id is
  'Sede donde operaba la persona. Sin FK a propósito, por la misma razón.';

-- Sin FK, el identificador puede quedar huérfano y dejar de ser legible. La
-- etiqueta conserva a quién correspondía en el momento del hecho.
alter table public.audit_log
  add column if not exists actor_label text;

comment on column public.audit_log.actor_label is
  'Nombre o correo del actor tal como estaba al registrarse el asiento. '
  'Es una foto, no una referencia: no se actualiza si la persona cambia de nombre.';

create or replace function public.record_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_app_role public.app_role;
  actor_name text;
  actor_branch_id uuid;
  affected_record_id uuid;
  old_json jsonb;
  new_json jsonb;
  changed text[];
begin
  select p.role, nullif(trim(coalesce(p.full_name, '')), '')
    into actor_app_role, actor_name
  from public.admin_profiles p
  where p.id = actor;

  -- Si el perfil no declara nombre, el correo de la cuenta sirve de etiqueta.
  if actor is not null and actor_name is null then
    select u.email into actor_name from auth.users u where u.id = actor;
  end if;

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
    actor_id, actor_role, actor_label, branch_id, table_name, record_id,
    action, changed_fields, old_values, new_values
  ) values (
    actor, actor_app_role, actor_name, actor_branch_id, tg_table_name, affected_record_id,
    lower(tg_op), changed, old_json, new_json
  );

  return null;
end;
$$;

revoke all on function public.record_audit() from public;

commit;
