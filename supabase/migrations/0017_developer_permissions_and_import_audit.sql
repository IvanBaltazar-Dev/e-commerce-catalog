begin;

create or replace function public.is_admin(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = user_id
      and role in ('admin', 'developer')
  );
$$;

create or replace function public.is_developer(user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.admin_profiles
    where id = user_id
      and role = 'developer'
  );
$$;

revoke all on function public.is_developer(uuid) from public;
grant execute on function public.is_developer(uuid) to authenticated, service_role;

alter table public.import_batches
  add column if not exists file_sha256 text,
  add column if not exists security_report jsonb not null default '{}'::jsonb,
  add column if not exists committed_at timestamptz;

alter table public.import_batches
  drop constraint if exists import_batches_file_sha256_format,
  add constraint import_batches_file_sha256_format check (
    file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$'
  ),
  drop constraint if exists import_batches_security_report_object,
  add constraint import_batches_security_report_object check (
    jsonb_typeof(security_report) = 'object'
  );

commit;
