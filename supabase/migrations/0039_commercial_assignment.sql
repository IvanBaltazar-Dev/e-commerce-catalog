-- Bloque 3 · Migración 5 de 6 — Asignación comercial con historial.
--
-- El plan lo prohíbe expresamente: nunca un `assigned_user_id = X` sin
-- registrar quién lo hizo, por qué y a quién reemplazó. El puntero vigente
-- vive en la conversación (0036); AQUÍ vive la historia, append-only, y los
-- únicos caminos que mueven el puntero.
--
-- TRES DECISIONES QUE ESTA MIGRACIÓN CIERRA:
--
-- A. LA POLÍTICA INICIAL ES SIMPLE Y DETERMINISTA, Y LA ESTRATEGIA ES UN DATO.
--    1) conservar la vendedora anterior si la relación sigue activa; 2) si no,
--    round-robin entre las vendedoras activas de la sede; 3) sin candidatas,
--    queda sin asignar. assignment_kind es texto validado —no enum— para que
--    una estrategia futura (incluida una IA) sea una fila nueva en la
--    historia, no una migración.
--
-- B. EL ROUND-ROBIN NO NECESITA TABLA DE ESTADO. «La menos recientemente
--    asignada» se deriva de la propia historia con un orden total
--    (última asignación, id de perfil): reproducible, auditable y sin un
--    contador que pueda desincronizarse de lo que registra.
--
-- C. TOMAR UNA CONVERSACIÓN ES UNA TRANSICIÓN CONDICIONAL. Dos vendedoras que
--    pulsan «tomar» a la vez se resuelven con `where assigned_user_id is
--    null`: EvalPlanQual da la conversación a exactamente una y la otra recibe
--    un error de dominio, no un pisotón silencioso.

begin;

-- ---------------------------------------------------------------------------
-- 1. Historia
-- ---------------------------------------------------------------------------

create table public.conversation_assignments (
  id bigint generated always as identity primary key,
  conversation_id uuid not null references public.channel_conversations(id) on delete restrict,
  assigned_user_id uuid,
  assigned_user_label text,
  previous_user_id uuid,
  previous_user_label text,
  -- Texto validado, no enum: la estrategia es un dato (decisión A).
  assignment_kind text not null,
  reason text not null,
  assigned_by uuid,
  assigned_by_label text,
  created_at timestamptz not null default now(),
  constraint conversation_assignments_kind_format check (assignment_kind ~ '^[a-z_]{2,40}$'),
  constraint conversation_assignments_reason_not_blank check (length(trim(reason)) > 0)
);

create index conversation_assignments_conversation_idx
on public.conversation_assignments(conversation_id, id);
create index conversation_assignments_user_idx
on public.conversation_assignments(assigned_user_id, created_at desc)
where assigned_user_id is not null;

create trigger conversation_assignments_no_update
before update on public.conversation_assignments
for each row execute function public.reject_audit_mutation();

comment on table public.conversation_assignments is
  'Historia de asignación, append-only. El puntero vigente vive en la '
  'conversación; esta tabla registra cada movimiento con actor y motivo.';

-- ---------------------------------------------------------------------------
-- 2. El único camino que mueve el puntero
-- ---------------------------------------------------------------------------

create or replace function public.assign_conversation(
  p_conversation_id uuid,
  p_user_id uuid,
  p_reason text,
  p_kind text default 'manual'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation public.channel_conversations%rowtype;
  target_label text;
  actor uuid := auth.uid();
begin
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception using errcode = '22023', message = 'La asignación exige un motivo.';
  end if;

  select * into conversation
  from public.channel_conversations where id = p_conversation_id for update;

  if conversation.id is null then
    raise exception using errcode = '22023', message = 'La conversación no existe.';
  end if;

  perform public.assert_branch_access(conversation.branch_id, 'asignar conversaciones');

  -- La vendedora solo se asigna A SÍ MISMA una conversación libre; mover la de
  -- una compañera es administración.
  if actor is not null and not public.is_admin() then
    if p_user_id is distinct from actor then
      raise exception using errcode = '42501',
        message = 'Solo administración asigna conversaciones a otra persona.';
    end if;

    if conversation.assigned_user_id is not null and conversation.assigned_user_id <> actor then
      raise exception using errcode = '42501',
        message = 'La conversación ya tiene vendedora: reasignarla es administración.';
    end if;
  end if;

  if p_user_id is not null then
    select nullif(trim(coalesce(full_name, '')), '') into target_label
    from public.admin_profiles where id = p_user_id and is_active;

    if target_label is null then
      raise exception using errcode = '22023', message = 'La persona destino no existe o no está activa.';
    end if;
  end if;

  update public.channel_conversations
  set assigned_user_id = p_user_id, assigned_user_label = target_label
  where id = p_conversation_id;

  insert into public.conversation_assignments (
    conversation_id, assigned_user_id, assigned_user_label,
    previous_user_id, previous_user_label,
    assignment_kind, reason, assigned_by, assigned_by_label
  ) values (
    p_conversation_id, p_user_id, target_label,
    conversation.assigned_user_id, conversation.assigned_user_label,
    p_kind, trim(p_reason), actor,
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = actor)
  );

  perform public.record_channel_event(
    case when p_user_id is null then 'conversation.unassigned' else 'conversation.assigned' end,
    p_conversation_id, conversation.channel_account_id,
    'admin_profile', p_user_id, target_label,
    jsonb_build_object('kind', p_kind, 'reason', p_reason), actor
  );

  return jsonb_build_object(
    'conversationId', p_conversation_id,
    'assignedUserId', p_user_id,
    'assignedUserLabel', target_label
  );
end;
$$;

-- Decisión C: tomar es condicional. Exactamente una gana.
create or replace function public.claim_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  conversation public.channel_conversations%rowtype;
  actor_label text;
begin
  if actor is null or not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo toma conversaciones.';
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into actor_label
  from public.admin_profiles where id = actor;

  update public.channel_conversations
  set assigned_user_id = actor, assigned_user_label = actor_label
  where id = p_conversation_id
    and assigned_user_id is null
    and status in ('open', 'pending')
    and branch_id in (select public.staff_branch_ids())
  returning * into conversation;

  if conversation.id is null then
    raise exception using errcode = '23514',
      message = 'La conversación ya fue tomada o no está disponible.';
  end if;

  insert into public.conversation_assignments (
    conversation_id, assigned_user_id, assigned_user_label,
    assignment_kind, reason, assigned_by, assigned_by_label
  ) values (
    p_conversation_id, actor, actor_label,
    'claim', 'Tomada desde la bandeja', actor, actor_label
  );

  perform public.record_channel_event(
    'conversation.assigned', p_conversation_id, conversation.channel_account_id,
    'admin_profile', actor, actor_label,
    jsonb_build_object('kind', 'claim'), actor
  );

  return jsonb_build_object('conversationId', p_conversation_id, 'assignedUserId', actor);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. La política automática
-- ---------------------------------------------------------------------------

create or replace function public.auto_assign_conversation(p_conversation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  conversation public.channel_conversations%rowtype;
  candidate uuid;
  candidate_label text;
  chosen_reason text;
begin
  if auth.uid() is not null and not public.is_staff() then
    raise exception using errcode = '42501', message = 'Solo el personal activo asigna conversaciones.';
  end if;

  select * into conversation
  from public.channel_conversations where id = p_conversation_id for update;

  if conversation.id is null then
    raise exception using errcode = '22023', message = 'La conversación no existe.';
  end if;

  if conversation.assigned_user_id is not null then
    return jsonb_build_object(
      'conversationId', p_conversation_id,
      'assignedUserId', conversation.assigned_user_id,
      'strategy', 'already_assigned'
    );
  end if;

  -- 1) Relación previa: la vendedora que ya atendió a este contacto, si sigue
  --    activa y alcanza esta sede.
  select c.assigned_user_id into candidate
  from public.channel_conversations c
  join public.admin_profiles p on p.id = c.assigned_user_id and p.is_active
  where c.channel_contact_id = conversation.channel_contact_id
    and c.id <> conversation.id
    and c.assigned_user_id is not null
    and exists (
      select 1 from public.staff_branches sb
      where sb.staff_id = c.assigned_user_id and sb.branch_id = conversation.branch_id
    )
  order by c.last_activity_at desc
  limit 1;

  if candidate is not null then
    chosen_reason := 'Relación previa con la clienta';
  else
    -- 2) Round-robin DERIVADO de la historia (decisión B): la vendedora activa
    --    de la sede con la asignación más antigua —o ninguna— primero; a
    --    igualdad, el id menor. Orden total, reproducible.
    select p.id into candidate
    from public.admin_profiles p
    join public.staff_branches sb on sb.staff_id = p.id and sb.branch_id = conversation.branch_id
    where p.is_active and p.role = 'seller'
    order by
      coalesce((
        select max(a.created_at) from public.conversation_assignments a
        where a.assigned_user_id = p.id
      ), '-infinity'::timestamptz),
      p.id
    limit 1;

    chosen_reason := 'Distribución round-robin de la sede';
  end if;

  -- 3) Sin candidatas: queda sin asignar, y eso también es un resultado.
  if candidate is null then
    return jsonb_build_object(
      'conversationId', p_conversation_id, 'assignedUserId', null, 'strategy', 'unassigned'
    );
  end if;

  select nullif(trim(coalesce(full_name, '')), '') into candidate_label
  from public.admin_profiles where id = candidate;

  update public.channel_conversations
  set assigned_user_id = candidate, assigned_user_label = candidate_label
  where id = p_conversation_id;

  insert into public.conversation_assignments (
    conversation_id, assigned_user_id, assigned_user_label,
    assignment_kind, reason, assigned_by, assigned_by_label
  ) values (
    p_conversation_id, candidate, candidate_label,
    case when chosen_reason like 'Relación%' then 'auto_previous' else 'auto_round_robin' end,
    chosen_reason, auth.uid(),
    (select nullif(trim(coalesce(full_name, '')), '') from public.admin_profiles where id = auth.uid())
  );

  perform public.record_channel_event(
    'conversation.assigned', p_conversation_id, conversation.channel_account_id,
    'admin_profile', candidate, candidate_label,
    jsonb_build_object('kind', 'auto', 'reason', chosen_reason), auth.uid()
  );

  return jsonb_build_object(
    'conversationId', p_conversation_id,
    'assignedUserId', candidate,
    'assignedUserLabel', candidate_label,
    'strategy', case when chosen_reason like 'Relación%' then 'previous_relationship' else 'round_robin' end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. RLS y privilegios
-- ---------------------------------------------------------------------------

alter table public.conversation_assignments enable row level security;

create policy "staff read assignment history of reachable conversations"
on public.conversation_assignments for select to authenticated
using (
  public.is_admin()
  or exists (
    select 1 from public.channel_conversations c
    where c.id = conversation_assignments.conversation_id
      and c.branch_id in (select public.staff_branch_ids())
      and (c.assigned_user_id is null or c.assigned_user_id = auth.uid())
  )
);

grant select on public.conversation_assignments to authenticated;
grant select, insert, delete on public.conversation_assignments to service_role;

revoke all on public.conversation_assignments from anon;
revoke truncate on public.conversation_assignments from anon, authenticated, service_role;

revoke all on function public.assign_conversation(uuid, uuid, text, text) from public, anon;
revoke all on function public.claim_conversation(uuid) from public, anon;
revoke all on function public.auto_assign_conversation(uuid) from public, anon;

grant execute on function public.assign_conversation(uuid, uuid, text, text) to authenticated, service_role;
grant execute on function public.claim_conversation(uuid) to authenticated, service_role;
grant execute on function public.auto_assign_conversation(uuid) to authenticated, service_role;

commit;
