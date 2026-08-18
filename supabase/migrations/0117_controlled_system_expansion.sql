-- ---------------------------------------------------------------------------
-- 0117 · Expansión controlada de sistemas mediante manifiestos universales
-- ---------------------------------------------------------------------------
-- Añade vocabulario y estructura de procesos a las tablas universales de
-- 0113. Los manifiestos no clasifican productos, no crean hechos canónicos y
-- no investigan marcas: todo vínculo técnico nuevo queda NEEDS_EVIDENCE.

begin;

create table public.catalog_system_expansion_previews (
  id uuid primary key default gen_random_uuid(),
  manifest_key text not null,
  manifest_version integer not null,
  status text not null default 'previewed',
  manifest jsonb not null,
  input_fingerprint text not null,
  state_fingerprint text not null,
  preview_fingerprint text not null unique,
  preview_idempotency_key text not null unique,
  apply_idempotency_key text unique,
  metrics jsonb not null,
  research_run_id uuid references public.catalog_research_runs(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  applied_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  constraint catalog_system_expansion_manifest_key_not_blank
    check (length(trim(manifest_key)) > 0),
  constraint catalog_system_expansion_manifest_version_positive
    check (manifest_version > 0),
  constraint catalog_system_expansion_status_allowed
    check (status in ('previewed','applied','expired','cancelled')),
  constraint catalog_system_expansion_manifest_object
    check (jsonb_typeof(manifest)='object'),
  constraint catalog_system_expansion_metrics_object
    check (jsonb_typeof(metrics)='object'),
  constraint catalog_system_expansion_fingerprints
    check (length(input_fingerprint)=64 and length(state_fingerprint)=64
      and length(preview_fingerprint)=64),
  constraint catalog_system_expansion_apply_consistent check (
    (status='applied' and applied_at is not null and apply_idempotency_key is not null
      and research_run_id is not null)
    or (status<>'applied' and applied_at is null and research_run_id is null)
  )
);

create index catalog_system_expansion_previews_manifest_idx
  on public.catalog_system_expansion_previews(manifest_key,manifest_version,created_at desc);

create or replace function public.catalog_system_expansion_state_v1()
returns text
language sql
stable
security invoker
set search_path=''
as $function$
  select encode(extensions.digest(convert_to(jsonb_build_object(
    'systems',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,system.domain,system.name,system.is_active,system.metadata
    ) order by system.code) from public.catalog_systems system),'[]'::jsonb),
    'stages',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,stage.code,stage.name,stage.position,stage.is_active,stage.metadata
    ) order by system.code,stage.position,stage.code)
      from public.catalog_stages stage join public.catalog_systems system on system.id=stage.system_id),'[]'::jsonb),
    'roles',coalesce((select jsonb_agg(jsonb_build_array(
      role.code,role.name,role.role_kind,role.is_active,role.metadata
    ) order by role.code) from public.catalog_roles role),'[]'::jsonb),
    'classes',coalesce((select jsonb_agg(jsonb_build_array(
      class.code,class.name,class.target_scope,class.is_active,class.metadata
    ) order by class.code) from public.catalog_classes class),'[]'::jsonb),
    'expectations',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,stage.code,role.code,expectation.necessity,
      expectation.minimum_selections,expectation.maximum_selections,
      expectation.decision_status,expectation.is_active,expectation.metadata
    ) order by system.code,stage.code,role.code)
      from public.catalog_system_stage_roles expectation
      join public.catalog_systems system on system.id=expectation.system_id
      join public.catalog_stages stage on stage.id=expectation.stage_id
      join public.catalog_roles role on role.id=expectation.role_id),'[]'::jsonb),
    'bridges',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,stage.code,role.code,class.code,bridge.coverage_kind,
      bridge.epistemic_state,bridge.decision_status,bridge.is_active,bridge.metadata
    ) order by system.code,stage.code,role.code,class.code)
      from public.catalog_system_stage_role_classes bridge
      join public.catalog_system_stage_roles expectation on expectation.id=bridge.system_stage_role_id
      join public.catalog_systems system on system.id=expectation.system_id
      join public.catalog_stages stage on stage.id=expectation.stage_id
      join public.catalog_roles role on role.id=expectation.role_id
      join public.catalog_classes class on class.id=bridge.class_id),'[]'::jsonb),
    'requirements',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,stage.code,role.code,class.code,requirement.code,
      requirement.requirement_kind_code,requirement.necessity,
      requirement.requirement_value,requirement.epistemic_state,
      requirement.decision_status,requirement.is_active,requirement.metadata
    ) order by system.code,stage.code,role.code,class.code,requirement.code)
      from public.catalog_class_requirements requirement
      join public.catalog_system_stage_role_classes bridge on bridge.id=requirement.system_stage_role_class_id
      join public.catalog_system_stage_roles expectation on expectation.id=bridge.system_stage_role_id
      join public.catalog_systems system on system.id=expectation.system_id
      join public.catalog_stages stage on stage.id=expectation.stage_id
      join public.catalog_roles role on role.id=expectation.role_id
      join public.catalog_classes class on class.id=bridge.class_id),'[]'::jsonb),
    'transitions',coalesce((select jsonb_agg(jsonb_build_array(
      system.code,source.code,target.code,transition.relation_kind_code,
      transition.condition,transition.epistemic_state,
      transition.decision_status,transition.is_active,transition.metadata
    ) order by system.code,source.code,target.code,transition.relation_kind_code)
      from public.catalog_stage_transitions transition
      join public.catalog_systems system on system.id=transition.system_id
      join public.catalog_stages source on source.id=transition.source_stage_id
      join public.catalog_stages target on target.id=transition.target_stage_id),'[]'::jsonb),
    'relations',coalesce((select jsonb_agg(jsonb_build_array(
      rule.code,source.code,target.code,rule.relation_kind_code,
      rule.epistemic_state,rule.decision_status,rule.is_active,rule.metadata
    ) order by rule.code)
      from public.catalog_relation_rules rule
      join public.catalog_classes source on source.id=rule.source_class_id
      join public.catalog_classes target on target.id=rule.target_class_id),'[]'::jsonb)
  )::text,'UTF8'),'sha256'),'hex');
$function$;

create or replace function public.preview_catalog_system_expansion_v1(
  p_manifest jsonb,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  manifest_key text := trim(coalesce(p_manifest->>'manifestKey',''));
  manifest_version integer;
  system_code text := trim(coalesce(p_manifest->'system'->>'code',''));
  input_fingerprint text;
  state_fingerprint text;
  preview_fingerprint text;
  request_fingerprint text;
  existing public.catalog_system_expansion_previews%rowtype;
  created public.catalog_system_expansion_previews%rowtype;
  metrics jsonb;
  conflict_count integer := 0;
begin
  if coalesce(auth.role(),'')<>'service_role' and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede preparar una expansión de sistemas.';
  end if;
  if jsonb_typeof(p_manifest)<>'object'
     or jsonb_typeof(p_manifest->'system')<>'object'
     or jsonb_typeof(p_manifest->'stages')<>'array'
     or jsonb_typeof(p_manifest->'roles')<>'array'
     or jsonb_typeof(p_manifest->'classes')<>'array'
     or jsonb_typeof(p_manifest->'expectations')<>'array'
     or jsonb_typeof(p_manifest->'roleClasses')<>'array'
     or jsonb_typeof(p_manifest->'requirements')<>'array'
     or jsonb_typeof(p_manifest->'transitions')<>'array'
     or jsonb_typeof(p_manifest->'classRelations')<>'array'
     or jsonb_typeof(p_manifest->'evidenceSignatures')<>'array' then
    raise exception using errcode='22023', message='El manifiesto universal está incompleto.';
  end if;
  begin manifest_version := (p_manifest->>'manifestVersion')::integer;
  exception when others then
    raise exception using errcode='22023', message='La versión del manifiesto no es válida.';
  end;
  if manifest_key='' or length(manifest_key)>120 or manifest_version<1
     or system_code !~ '^[A-Z][A-Z0-9_]*$'
     or trim(coalesce(p_manifest->'system'->>'domain','')) !~ '^[A-Z][A-Z0-9_]*$'
     or nullif(trim(p_manifest->'system'->>'name'),'') is null
     or nullif(trim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023', message='La identidad del manifiesto o del sistema no es válida.';
  end if;
  if p_manifest ?| array['products','variants','brands','prices','stock','publication']
     or jsonb_path_exists(p_manifest,'$.**.products')
     or jsonb_path_exists(p_manifest,'$.**.variants')
     or jsonb_path_exists(p_manifest,'$.**.brands')
     or jsonb_path_exists(p_manifest,'$.**.prices')
     or jsonb_path_exists(p_manifest,'$.**.stock')
     or jsonb_path_exists(p_manifest,'$.**.publication') then
    raise exception using errcode='22023', message='El manifiesto de sistemas no admite datos comerciales ni productos.';
  end if;
  if jsonb_array_length(p_manifest->'stages') not between 2 and 30
     or jsonb_array_length(p_manifest->'roles') not between 2 and 60
     or jsonb_array_length(p_manifest->'classes') not between 2 and 100
     or jsonb_array_length(p_manifest->'expectations')>150
     or jsonb_array_length(p_manifest->'roleClasses')>200
     or jsonb_array_length(p_manifest->'requirements')>300
     or jsonb_array_length(p_manifest->'transitions')>100
     or jsonb_array_length(p_manifest->'classRelations')>100
     or jsonb_array_length(p_manifest->'evidenceSignatures')>100 then
    raise exception using errcode='22023', message='El manifiesto excede el alcance de una expansión controlada.';
  end if;

  if exists(select 1 from jsonb_array_elements(p_manifest->'stages') item
    where coalesce(item->>'code','') !~ '^[A-Z][A-Z0-9_]*$'
      or nullif(trim(item->>'name'),'') is null
      or coalesce((item->>'position')::integer,-1)<0)
    or exists(select 1 from jsonb_array_elements(p_manifest->'roles') item
      where coalesce(item->>'code','') !~ '^[A-Z][A-Z0-9_]*$'
        or nullif(trim(item->>'name'),'') is null
        or not exists(select 1 from public.catalog_role_kinds kind where kind.code=item->>'kind'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'classes') item
      where coalesce(item->>'code','') !~ '^[A-Z][A-Z0-9_]*$'
        or nullif(trim(item->>'name'),'') is null
        or coalesce(item->>'scope','') not in ('product','variant','reference_product','reference_variant'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'requirements') item
      where coalesce(item->>'code','') !~ '^[A-Z][A-Z0-9_]*$'
        or not exists(select 1 from public.catalog_requirement_kinds kind where kind.code=item->>'kind'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'transitions') item
      where coalesce(item->>'kind','') not in ('PRECEDES','FOLLOWS'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'classRelations') item
      where not exists(select 1 from public.catalog_relation_kinds kind where kind.code=item->>'kind')) then
    raise exception using errcode='22023', message='El manifiesto contiene códigos, tipos o referencias no permitidos.';
  end if;

  if (select count(*) from jsonb_array_elements(p_manifest->'stages')) <>
       (select count(distinct item->>'code') from jsonb_array_elements(p_manifest->'stages') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'roles')) <>
       (select count(distinct item->>'code') from jsonb_array_elements(p_manifest->'roles') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'classes')) <>
       (select count(distinct item->>'code') from jsonb_array_elements(p_manifest->'classes') item) then
    raise exception using errcode='22023', message='El manifiesto repite etapas, roles o clases.';
  end if;

  if exists(select 1 from jsonb_array_elements(p_manifest->'expectations') item
      where not exists(select 1 from jsonb_array_elements(p_manifest->'stages') stage
              where stage->>'code'=item->>'stageCode')
        or not exists(select 1 from jsonb_array_elements(p_manifest->'roles') role
              where role->>'code'=item->>'roleCode')
        or coalesce(item->>'necessity','') not in ('required','recommended','optional')
        or not case when coalesce(item->>'minimumSelections','') ~ '^[0-9]+$'
              then (item->>'minimumSelections')::integer>=0 else false end
        or (item ? 'maximumSelections' and item->>'maximumSelections' is not null
          and not case when item->>'maximumSelections' ~ '^[0-9]+$'
            then (item->>'maximumSelections')::integer>=(item->>'minimumSelections')::integer
            else false end)
        or (item->>'necessity'='required' and (item->>'minimumSelections')::integer=0))
    or exists(select 1 from jsonb_array_elements(p_manifest->'roleClasses') item
      where not exists(select 1 from jsonb_array_elements(p_manifest->'expectations') expectation
              where expectation->>'stageCode'=item->>'stageCode'
                and expectation->>'roleCode'=item->>'roleCode')
        or not exists(select 1 from jsonb_array_elements(p_manifest->'classes') class
              where class->>'code'=item->>'classCode')
        or coalesce(item->>'coverageKind','covers_role') not in
          ('covers_role','alternative_coverage','supporting_coverage'))
    or exists(select 1 from jsonb_array_elements(p_manifest->'requirements') item
      where not exists(select 1 from jsonb_array_elements(p_manifest->'roleClasses') bridge
              where bridge->>'stageCode'=item->>'stageCode'
                and bridge->>'roleCode'=item->>'roleCode'
                and bridge->>'classCode'=item->>'classCode')
        or nullif(trim(coalesce(item->>'name','')),'') is null
        or coalesce(item->>'necessity','optional') not in ('required','recommended','optional')
        or jsonb_typeof(coalesce(item->'value','{}'::jsonb))<>'object')
    or exists(select 1 from jsonb_array_elements(p_manifest->'transitions') item
      where item->>'sourceStageCode'=item->>'targetStageCode'
        or not exists(select 1 from jsonb_array_elements(p_manifest->'stages') stage
              where stage->>'code'=item->>'sourceStageCode')
        or not exists(select 1 from jsonb_array_elements(p_manifest->'stages') stage
              where stage->>'code'=item->>'targetStageCode')
        or jsonb_typeof(coalesce(item->'condition','{}'::jsonb))<>'object')
    or exists(select 1 from jsonb_array_elements(p_manifest->'classRelations') item
      where coalesce(item->>'code','') !~ '^[A-Z][A-Z0-9_]*$'
        or item->>'sourceClassCode'=item->>'targetClassCode'
        or not exists(select 1 from jsonb_array_elements(p_manifest->'classes') class
              where class->>'code'=item->>'sourceClassCode')
        or not exists(select 1 from jsonb_array_elements(p_manifest->'classes') class
              where class->>'code'=item->>'targetClassCode')
        or not exists(select 1 from jsonb_array_elements(p_manifest->'stages') stage
              where stage->>'code'=item->>'stageCode')
        or coalesce(item->>'requirementLevel','optional') not in ('required','recommended','optional'))
    or exists(select 1 from jsonb_array_elements_text(p_manifest->'evidenceSignatures') signature
      where signature !~ '^[a-z0-9_]+->[a-z0-9_]+$') then
    raise exception using errcode='22023', message='El manifiesto contiene referencias internas incoherentes.';
  end if;

  if (select count(*) from jsonb_array_elements(p_manifest->'expectations')) <>
       (select count(distinct jsonb_build_array(item->>'stageCode',item->>'roleCode'))
        from jsonb_array_elements(p_manifest->'expectations') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'roleClasses')) <>
       (select count(distinct jsonb_build_array(item->>'stageCode',item->>'roleCode',item->>'classCode'))
        from jsonb_array_elements(p_manifest->'roleClasses') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'requirements')) <>
       (select count(distinct jsonb_build_array(item->>'stageCode',item->>'roleCode',item->>'classCode',item->>'code'))
        from jsonb_array_elements(p_manifest->'requirements') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'transitions')) <>
       (select count(distinct jsonb_build_array(item->>'sourceStageCode',item->>'targetStageCode',item->>'kind'))
        from jsonb_array_elements(p_manifest->'transitions') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'classRelations')) <>
       (select count(distinct item->>'code') from jsonb_array_elements(p_manifest->'classRelations') item)
    or (select count(*) from jsonb_array_elements(p_manifest->'evidenceSignatures')) <>
       (select count(distinct item) from jsonb_array_elements_text(p_manifest->'evidenceSignatures') item) then
    raise exception using errcode='22023', message='El manifiesto repite vínculos o firmas de evidencia.';
  end if;

  select count(*) into conflict_count from (
    select 1 from public.catalog_systems system
      where system.code=system_code
        and system.metadata->>'expansionManifestKey' is distinct from manifest_key
    union all
    select 1 from public.catalog_roles role
      join jsonb_array_elements(p_manifest->'roles') item on item->>'code'=role.code
      where role.metadata->>'expansionManifestKey' is distinct from manifest_key
    union all
    select 1 from public.catalog_classes class
      join jsonb_array_elements(p_manifest->'classes') item on item->>'code'=class.code
      where class.metadata->>'expansionManifestKey' is distinct from manifest_key
    union all
    select 1 from public.catalog_relation_rules rule
      join jsonb_array_elements(p_manifest->'classRelations') item on item->>'code'=rule.code
      where rule.metadata->>'expansionManifestKey' is distinct from manifest_key
  ) conflicts;
  if conflict_count>0 then
    raise exception using errcode='23505', message='El manifiesto intenta tomar un código que pertenece a otro origen.';
  end if;

  input_fingerprint := encode(extensions.digest(convert_to(p_manifest::text,'UTF8'),'sha256'),'hex');
  state_fingerprint := public.catalog_system_expansion_state_v1();
  request_fingerprint := encode(extensions.digest(convert_to(
    concat_ws('|',input_fingerprint,p_idempotency_key),'UTF8'),'sha256'),'hex');

  select * into existing from public.catalog_system_expansion_previews preview
  where preview.preview_idempotency_key=p_idempotency_key;
  if found then
    if existing.input_fingerprint<>input_fingerprint then
      raise exception using errcode='23505', message='La clave idempotente ya representa otro manifiesto.';
    end if;
    return jsonb_build_object(
      'contractVersion','stage4g-v1','previewId',existing.id,
      'status',existing.status,'manifestKey',existing.manifest_key,
      'previewFingerprint',existing.preview_fingerprint,
      'metrics',existing.metrics,'idempotentReplay',true
    );
  end if;

  metrics := jsonb_build_object(
    'systems',1,
    'stages',jsonb_array_length(p_manifest->'stages'),
    'roles',jsonb_array_length(p_manifest->'roles'),
    'classes',jsonb_array_length(p_manifest->'classes'),
    'expectations',jsonb_array_length(p_manifest->'expectations'),
    'roleClasses',jsonb_array_length(p_manifest->'roleClasses'),
    'requirements',jsonb_array_length(p_manifest->'requirements'),
    'transitions',jsonb_array_length(p_manifest->'transitions'),
    'classRelations',jsonb_array_length(p_manifest->'classRelations'),
    'evidenceSignatures',jsonb_array_length(p_manifest->'evidenceSignatures'),
    'productMembershipsCreated',0,'humanWorkCreated',0,
    'canonicalFactsCreated',0,'commercialEffects',0
  );
  preview_fingerprint := encode(extensions.digest(convert_to(concat_ws('|',
    manifest_key,manifest_version::text,input_fingerprint,state_fingerprint,metrics::text
  ),'UTF8'),'sha256'),'hex');

  insert into public.catalog_system_expansion_previews(
    manifest_key,manifest_version,manifest,input_fingerprint,state_fingerprint,
    preview_fingerprint,preview_idempotency_key,metrics,created_by
  ) values (
    manifest_key,manifest_version,p_manifest,input_fingerprint,state_fingerprint,
    preview_fingerprint,p_idempotency_key,metrics,actor
  ) returning * into created;

  return jsonb_build_object(
    'contractVersion','stage4g-v1','previewId',created.id,
    'status',created.status,'manifestKey',created.manifest_key,
    'previewFingerprint',created.preview_fingerprint,
    'metrics',created.metrics,'idempotentReplay',false
  );
end;
$function$;

create or replace function public.apply_catalog_system_expansion_v1(
  p_preview_id uuid,
  p_preview_fingerprint text,
  p_idempotency_key text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := coalesce(auth.uid(),p_actor_id);
  preview public.catalog_system_expansion_previews%rowtype;
  manifest jsonb;
  item jsonb;
  system_row public.catalog_systems%rowtype;
  stage_row public.catalog_stages%rowtype;
  target_stage_row public.catalog_stages%rowtype;
  role_row public.catalog_roles%rowtype;
  class_row public.catalog_classes%rowtype;
  target_class_row public.catalog_classes%rowtype;
  expectation_row public.catalog_system_stage_roles%rowtype;
  bridge_row public.catalog_system_stage_role_classes%rowtype;
  research_run public.catalog_research_runs%rowtype;
  expansion_metadata jsonb;
begin
  if coalesce(auth.role(),'')<>'service_role' and (actor is null or not public.is_admin(actor)) then
    raise exception using errcode='42501', message='Solo administración puede aplicar una expansión de sistemas.';
  end if;
  if p_preview_id is null or length(coalesce(p_preview_fingerprint,''))<>64
     or nullif(trim(coalesce(p_idempotency_key,'')),'') is null then
    raise exception using errcode='22023', message='Apply exige preview, huella y clave idempotente.';
  end if;
  select * into preview from public.catalog_system_expansion_previews current
  where current.id=p_preview_id for update;
  if not found then
    raise exception using errcode='P0002', message='El preview de expansión no existe.';
  end if;
  if preview.status='applied' then
    if preview.preview_fingerprint<>p_preview_fingerprint
       or preview.apply_idempotency_key<>p_idempotency_key then
      raise exception using errcode='23505', message='El preview ya fue aplicado con otra confirmación.';
    end if;
    return jsonb_build_object(
      'contractVersion','stage4g-v1','previewId',preview.id,'status','applied',
      'manifestKey',preview.manifest_key,'metrics',preview.metrics,
      'researchRunId',preview.research_run_id,'graphSyncRequired',true,
      'idempotentReplay',true
    );
  end if;
  if preview.status<>'previewed' or preview.preview_fingerprint<>p_preview_fingerprint then
    raise exception using errcode='40001', message='La confirmación no coincide con el preview de expansión.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('system-expansion:'||preview.manifest_key,0));
  if public.catalog_system_expansion_state_v1()<>preview.state_fingerprint then
    raise exception using errcode='40001', message='El modelo universal cambió desde el preview; genera uno nuevo.';
  end if;

  manifest := preview.manifest;
  expansion_metadata := jsonb_build_object(
    'expansionManifestKey',preview.manifest_key,
    'expansionManifestVersion',preview.manifest_version,
    'controlledExpansion',true,'canonicalPromotion',false
  );

  insert into public.catalog_systems(domain,code,name,description,sort_order,metadata)
  values (
    manifest->'system'->>'domain',manifest->'system'->>'code',
    manifest->'system'->>'name',manifest->'system'->>'description',
    coalesce((manifest->'system'->>'sortOrder')::integer,0),
    coalesce(manifest->'system'->'metadata','{}'::jsonb)||expansion_metadata
  ) on conflict (code) do update set
    domain=excluded.domain,name=excluded.name,description=excluded.description,
    sort_order=excluded.sort_order,metadata=excluded.metadata,is_active=true,updated_at=now()
  returning * into system_row;

  for item in select * from jsonb_array_elements(manifest->'stages') loop
    insert into public.catalog_stages(system_id,code,name,position,description,metadata)
    values (system_row.id,item->>'code',item->>'name',(item->>'position')::integer,
      item->>'description',coalesce(item->'metadata','{}'::jsonb)||expansion_metadata)
    on conflict (system_id,code) do update set
      name=excluded.name,position=excluded.position,description=excluded.description,
      metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'roles') loop
    insert into public.catalog_roles(code,name,role_kind,description,metadata)
    values (item->>'code',item->>'name',item->>'kind',item->>'description',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata)
    on conflict (code) do update set
      name=excluded.name,role_kind=excluded.role_kind,description=excluded.description,
      metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'classes') loop
    insert into public.catalog_classes(code,name,target_scope,description,metadata)
    values (item->>'code',item->>'name',item->>'scope',item->>'description',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata)
    on conflict (code) do update set
      name=excluded.name,target_scope=excluded.target_scope,description=excluded.description,
      metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'expectations') loop
    select * into stage_row from public.catalog_stages stage
      where stage.system_id=system_row.id and stage.code=item->>'stageCode';
    select * into role_row from public.catalog_roles role where role.code=item->>'roleCode';
    if stage_row.id is null or role_row.id is null then
      raise exception using errcode='22023', message='Una expectativa referencia una etapa o rol fuera del manifiesto.';
    end if;
    insert into public.catalog_system_stage_roles(
      system_id,stage_id,role_id,necessity,minimum_selections,maximum_selections,
      decision_status,metadata
    ) values (
      system_row.id,stage_row.id,role_row.id,coalesce(item->>'necessity','optional'),
      coalesce((item->>'minimumSelections')::integer,0),
      (item->>'maximumSelections')::integer,'needs_evidence',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata
    ) on conflict (system_id,stage_id,role_id) do update set
      necessity=excluded.necessity,minimum_selections=excluded.minimum_selections,
      maximum_selections=excluded.maximum_selections,decision_status='needs_evidence',
      evidence_set_id=null,metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'roleClasses') loop
    select expectation.* into expectation_row
    from public.catalog_system_stage_roles expectation
    join public.catalog_stages stage on stage.id=expectation.stage_id
    join public.catalog_roles role on role.id=expectation.role_id
    where expectation.system_id=system_row.id and stage.code=item->>'stageCode'
      and role.code=item->>'roleCode';
    select * into class_row from public.catalog_classes class where class.code=item->>'classCode';
    if expectation_row.id is null or class_row.id is null then
      raise exception using errcode='22023', message='Un vínculo rol–clase referencia vocabulario fuera del manifiesto.';
    end if;
    insert into public.catalog_system_stage_role_classes(
      system_stage_role_id,class_id,coverage_kind,epistemic_state,
      decision_status,metadata
    ) values (
      expectation_row.id,class_row.id,coalesce(item->>'coverageKind','covers_role'),
      'NEEDS_EVIDENCE','needs_evidence',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata
    ) on conflict (system_stage_role_id,class_id) do update set
      coverage_kind=excluded.coverage_kind,epistemic_state='NEEDS_EVIDENCE',
      semantic_claim_id=null,decision_status='needs_evidence',metadata=excluded.metadata,
      is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'requirements') loop
    select bridge.* into bridge_row
    from public.catalog_system_stage_role_classes bridge
    join public.catalog_system_stage_roles expectation on expectation.id=bridge.system_stage_role_id
    join public.catalog_stages stage on stage.id=expectation.stage_id
    join public.catalog_roles role on role.id=expectation.role_id
    join public.catalog_classes class on class.id=bridge.class_id
    where expectation.system_id=system_row.id and stage.code=item->>'stageCode'
      and role.code=item->>'roleCode' and class.code=item->>'classCode';
    if bridge_row.id is null then
      raise exception using errcode='22023', message='Un requisito referencia un vínculo rol–clase inexistente.';
    end if;
    insert into public.catalog_class_requirements(
      system_stage_role_class_id,requirement_kind_code,code,name,necessity,
      requirement_value,epistemic_state,decision_status,metadata
    ) values (
      bridge_row.id,item->>'kind',item->>'code',item->>'name',
      coalesce(item->>'necessity','optional'),coalesce(item->'value','{}'::jsonb),
      'NEEDS_EVIDENCE','needs_evidence',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata
    ) on conflict (system_stage_role_class_id,code) do update set
      requirement_kind_code=excluded.requirement_kind_code,name=excluded.name,
      necessity=excluded.necessity,requirement_value=excluded.requirement_value,
      epistemic_state='NEEDS_EVIDENCE',semantic_claim_id=null,
      decision_status='needs_evidence',metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'transitions') loop
    select * into stage_row from public.catalog_stages stage
      where stage.system_id=system_row.id and stage.code=item->>'sourceStageCode';
    select * into target_stage_row from public.catalog_stages stage
      where stage.system_id=system_row.id and stage.code=item->>'targetStageCode';
    if stage_row.id is null or target_stage_row.id is null then
      raise exception using errcode='22023', message='Una transición referencia una etapa inexistente.';
    end if;
    insert into public.catalog_stage_transitions(
      system_id,source_stage_id,target_stage_id,relation_kind_code,condition,
      epistemic_state,decision_status,metadata
    ) values (
      system_row.id,stage_row.id,target_stage_row.id,item->>'kind',
      coalesce(item->'condition','{}'::jsonb),'NEEDS_EVIDENCE','needs_evidence',
      coalesce(item->'metadata','{}'::jsonb)||expansion_metadata
    ) on conflict (system_id,source_stage_id,target_stage_id,relation_kind_code) do update set
      condition=excluded.condition,epistemic_state='NEEDS_EVIDENCE',semantic_claim_id=null,
      decision_status='needs_evidence',metadata=excluded.metadata,is_active=true,updated_at=now();
  end loop;

  for item in select * from jsonb_array_elements(manifest->'classRelations') loop
    select * into class_row from public.catalog_classes class where class.code=item->>'sourceClassCode';
    select * into target_class_row from public.catalog_classes class where class.code=item->>'targetClassCode';
    if class_row.id is null or target_class_row.id is null then
      raise exception using errcode='22023', message='Una relación referencia una clase inexistente.';
    end if;
    select * into stage_row from public.catalog_stages stage
      where stage.system_id=system_row.id and stage.code=item->>'stageCode';
    insert into public.catalog_relation_rules(
      code,source_class_id,target_class_id,relation_type,compatibility_status,
      system_id,stage_id,requirement_level,brand_policy,decision_status,
      notes,metadata,relation_kind_code,epistemic_state,semantic_claim_id
    ) values (
      item->>'code',class_row.id,target_class_row.id,null,'unknown',system_row.id,stage_row.id,
      coalesce(item->>'requirementLevel','optional'),'explicit_evidence','needs_evidence',
      item->>'notes',coalesce(item->'metadata','{}'::jsonb)||expansion_metadata,
      item->>'kind','NEEDS_EVIDENCE',null
    ) on conflict (code) do update set
      source_class_id=excluded.source_class_id,target_class_id=excluded.target_class_id,
      relation_type=null,compatibility_status='unknown',system_id=excluded.system_id,
      stage_id=excluded.stage_id,requirement_level=excluded.requirement_level,
      brand_policy='explicit_evidence',decision_status='needs_evidence',
      evidence_set_id=null,notes=excluded.notes,metadata=excluded.metadata,
      relation_kind_code=excluded.relation_kind_code,epistemic_state='NEEDS_EVIDENCE',
      semantic_claim_id=null,is_active=true,updated_at=now();
  end loop;

  insert into public.catalog_research_runs(
    run_key,run_kind,actor_kind,actor_user_id,actor_label,status,started_at,finished_at,
    input_fingerprint,result_fingerprint,scope,metrics,result
  ) values (
    'system-expansion:'||preview.manifest_key||':v'||preview.manifest_version,
    'targeted',case when actor is null then 'system' else 'human' end,actor,
    'Expansión controlada de sistemas','succeeded',now(),now(),
    preview.input_fingerprint,preview.preview_fingerprint,
    jsonb_build_object('manifestKey',preview.manifest_key,'systemCode',manifest->'system'->>'code',
      'massBrandResearch',false,'productClassification',false),
    preview.metrics,
    jsonb_build_object('canonicalPromotion',false,'commercialMutation',false,
      'allAssertionsNeedEvidence',true)
  ) on conflict (run_key) do update set
    actor_kind=excluded.actor_kind,actor_user_id=excluded.actor_user_id,
    status='succeeded',finished_at=now(),input_fingerprint=excluded.input_fingerprint,
    result_fingerprint=excluded.result_fingerprint,scope=excluded.scope,
    metrics=excluded.metrics,result=excluded.result,errors='[]'::jsonb,updated_at=now()
  returning * into research_run;

  update public.catalog_system_expansion_previews set
    status='applied',apply_idempotency_key=p_idempotency_key,
    research_run_id=research_run.id,applied_by=actor,applied_at=now()
  where id=preview.id returning * into preview;

  return jsonb_build_object(
    'contractVersion','stage4g-v1','previewId',preview.id,'status','applied',
    'manifestKey',preview.manifest_key,'systemCode',manifest->'system'->>'code',
    'metrics',preview.metrics,'researchRunId',research_run.id,
    'graphSyncRequired',true,'canonicalPromotion',false,
    'commercialEffects',0,'idempotentReplay',false
  );
end;
$function$;

create or replace function public.get_catalog_controlled_expansion_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path=''
as $function$
  with applied as (
    select * from public.catalog_system_expansion_previews where status='applied'
  ), expanded_systems as (
    select * from public.catalog_systems system
    where system.metadata ? 'expansionManifestKey' and system.is_active
  ), covered_decisions as (
    select distinct decision.public_decision_id,decision.family_code
    from public.catalog_relation_decisions decision
    where exists (
      select 1 from applied preview
      cross join lateral jsonb_array_elements_text(preview.manifest->'evidenceSignatures') signature
      where decision.read_model->'evidence_summary'->'ruleCodes' ? signature
    )
  ), canonical_leaks as (
    select count(*)::integer as total from (
      select bridge.id from public.catalog_system_stage_role_classes bridge
        where bridge.metadata ? 'expansionManifestKey' and bridge.epistemic_state='CANONICAL_FACT'
      union all select requirement.id from public.catalog_class_requirements requirement
        where requirement.metadata ? 'expansionManifestKey' and requirement.epistemic_state='CANONICAL_FACT'
      union all select transition.id from public.catalog_stage_transitions transition
        where transition.metadata ? 'expansionManifestKey' and transition.epistemic_state='CANONICAL_FACT'
      union all select rule.id from public.catalog_relation_rules rule
        where rule.metadata ? 'expansionManifestKey' and rule.epistemic_state='CANONICAL_FACT'
    ) leaked
  ), totals as (
    select
      (select count(*)::integer from applied) manifests,
      (select count(*)::integer from expanded_systems) systems,
      (select count(distinct domain)::integer from expanded_systems) domains,
      (select count(*)::integer from public.catalog_stages where metadata ? 'expansionManifestKey') stages,
      (select count(*)::integer from public.catalog_roles where metadata ? 'expansionManifestKey') roles,
      (select count(*)::integer from public.catalog_classes where metadata ? 'expansionManifestKey') classes,
      (select count(*)::integer from public.catalog_system_stage_roles where metadata ? 'expansionManifestKey') expectations,
      (select count(*)::integer from public.catalog_system_stage_role_classes where metadata ? 'expansionManifestKey') bridges,
      (select count(*)::integer from public.catalog_class_requirements where metadata ? 'expansionManifestKey') requirements,
      (select count(*)::integer from public.catalog_stage_transitions where metadata ? 'expansionManifestKey') transitions,
      (select count(*)::integer from public.catalog_relation_rules where metadata ? 'expansionManifestKey') relation_proposals,
      (select count(*)::integer from covered_decisions) covered_decisions,
      (select count(distinct family_code)::integer from covered_decisions) covered_families,
      (select total from canonical_leaks) canonical_leaks
  )
  select jsonb_build_object(
    'contractVersion','stage4g-v1','stage4Authorized',false,
    'metrics',jsonb_build_object(
      'manifests',totals.manifests,'systems',totals.systems,'domains',totals.domains,
      'stages',totals.stages,'roles',totals.roles,'classes',totals.classes,
      'expectations',totals.expectations,'bridges',totals.bridges,
      'requirements',totals.requirements,'transitions',totals.transitions,
      'relationProposals',totals.relation_proposals,
      'coveredDecisions',totals.covered_decisions,
      'coveredFamilies',totals.covered_families,'canonicalLeaks',totals.canonical_leaks
    ),
    'guards',jsonb_build_object(
      'massBrandResearch',false,'productMembershipsCreated',0,
      'humanWorkPerProductCreated',0,'canonicalFactsCreated',totals.canonical_leaks,
      'commercialEffects',0,'priceChanged',false,'stockChanged',false,
      'publicationChanged',false,'graphDecisionMaking',false
    ),
    'passes',totals.manifests>=2 and totals.systems>=2 and totals.domains>=2
      and totals.covered_decisions>=2 and totals.canonical_leaks=0
  ) from totals;
$function$;

alter table public.catalog_system_expansion_previews enable row level security;
create policy "admins read system expansion previews"
on public.catalog_system_expansion_previews for select to authenticated
using (public.is_admin());

grant select on public.catalog_system_expansion_previews to authenticated,service_role;
revoke all on function public.catalog_system_expansion_state_v1() from public,anon;
revoke all on function public.preview_catalog_system_expansion_v1(jsonb,text,uuid) from public,anon;
revoke all on function public.apply_catalog_system_expansion_v1(uuid,text,text,uuid) from public,anon;
revoke all on function public.get_catalog_controlled_expansion_report_v1() from public,anon;
grant execute on function public.catalog_system_expansion_state_v1(),
  public.preview_catalog_system_expansion_v1(jsonb,text,uuid),
  public.apply_catalog_system_expansion_v1(uuid,text,text,uuid),
  public.get_catalog_controlled_expansion_report_v1()
to authenticated,service_role;

commit;
