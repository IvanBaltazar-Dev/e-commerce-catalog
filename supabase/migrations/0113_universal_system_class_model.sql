-- 0113 - Etapa 4A: contrato universal sistema -> etapa -> rol -> clase -> requisito.
--
-- Este corte es aditivo. Reutiliza el conocimiento de 0086, conserva las 323
-- candidatas historicas sin decidir y valida el contrato con el vertical real
-- ACRYLIC. Pertenencia y funcion no producen compatibilidad producto-producto.

begin;

-- ---------------------------------------------------------------------------
-- Vocabularios extensibles (la ontologia se dirige por datos, no por familias)
-- ---------------------------------------------------------------------------

create table public.catalog_role_kinds (
  code text primary key,
  name text not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_role_kinds_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint catalog_role_kinds_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_role_kinds_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_role_kinds(code, name, description) values
  ('component', 'Componente', 'Material que integra o forma el resultado.'),
  ('preparation', 'Preparacion', 'Agente o instrumento que prepara el contexto.'),
  ('adhesion', 'Adhesion', 'Funcion declarada de adhesion o anclaje.'),
  ('tool', 'Herramienta', 'Instrumento manual o accesorio de trabajo.'),
  ('consumable', 'Consumible', 'Insumo que se consume durante el proceso.'),
  ('equipment', 'Equipo', 'Maquina o equipo durable, incluido equipo electrico.'),
  ('finishing', 'Acabado', 'Funcion de decoracion, acabado o sellado.'),
  ('care', 'Cuidado', 'Mantenimiento, cuidado posterior o retiro.'),
  ('safety', 'Seguridad', 'Control o proteccion de seguridad.'),
  ('replacement', 'Repuesto', 'Pieza o repuesto con aplicabilidad declarada.')
on conflict (code) do nothing;

alter table public.catalog_roles drop constraint catalog_roles_kind_allowed;
alter table public.catalog_roles
  add constraint catalog_roles_kind_fk foreign key (role_kind)
  references public.catalog_role_kinds(code) on update cascade;

create table public.catalog_relation_kinds (
  code text primary key,
  name text not null,
  inverse_code text,
  is_symmetric boolean not null default false,
  requires_explicit_pair_evidence boolean not null default false,
  legacy_relation_type public.product_relation_type,
  description text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_relation_kinds_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_relation_kinds_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_relation_kinds_inverse_not_self check (
    inverse_code is null or inverse_code <> code or is_symmetric
  ),
  constraint catalog_relation_kinds_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_relation_kinds(
  code, name, inverse_code, is_symmetric, requires_explicit_pair_evidence,
  legacy_relation_type, description
) values
  ('REQUIRES', 'Requiere', null, false, false, 'requires', 'La clase de origen necesita una capacidad cubierta por la clase destino.'),
  ('PRECEDES', 'Precede', 'FOLLOWS', false, false, null, 'Orden parcial: el origen ocurre antes que el destino.'),
  ('FOLLOWS', 'Sigue a', 'PRECEDES', false, false, null, 'Orden parcial: el origen ocurre despues del destino.'),
  ('ALTERNATIVE_TO', 'Alternativa de', 'ALTERNATIVE_TO', true, false, 'alternative_to', 'Opciones funcionales alternativas sin implicar sustitucion universal.'),
  ('SUBSTITUTES_FOR', 'Sustituye a', null, false, true, 'replacement_for', 'Sustitucion concreta sujeta a aplicabilidad y evidencia.'),
  ('EXCLUDES', 'Excluye', 'EXCLUDES', true, true, null, 'Coexistencia excluida por evidencia explicita.'),
  ('COMPATIBLE_WITH', 'Compatible con', 'COMPATIBLE_WITH', true, true, 'compatible_with', 'Compatibilidad concreta que exige evidencia explicita del par.'),
  ('INCOMPATIBLE_WITH', 'Incompatible con', 'INCOMPATIBLE_WITH', true, true, null, 'Incompatibilidad concreta que exige evidencia explicita del par.'),
  ('COMPLEMENTS', 'Complementa', 'COMPLEMENTS', true, false, 'recommended_with', 'Complemento funcional; no prueba compatibilidad tecnica.')
on conflict (code) do nothing;

alter table public.catalog_relation_kinds
  add constraint catalog_relation_kinds_inverse_fk foreign key (inverse_code)
  references public.catalog_relation_kinds(code) on update cascade;

create table public.catalog_requirement_kinds (
  code text primary key,
  name text not null,
  value_schema jsonb not null default '{}'::jsonb,
  description text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_requirement_kinds_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_requirement_kinds_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_requirement_kinds_schema_object check (jsonb_typeof(value_schema) = 'object'),
  constraint catalog_requirement_kinds_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_requirement_kinds(code, name, value_schema, description) values
  ('PROCESS', 'Proceso', '{"type":"object"}', 'Condicion o instruccion del proceso.'),
  ('CAPABILITY', 'Capacidad', '{"type":"object"}', 'Capacidad funcional que la clase debe cubrir.'),
  ('SPECIFICATION', 'Especificacion', '{"type":"object"}', 'Magnitud, material o propiedad tecnica declarada.'),
  ('SAFETY', 'Seguridad', '{"type":"object"}', 'Control o advertencia de seguridad.'),
  ('EVIDENCE', 'Evidencia', '{"type":"object"}', 'Evidencia adicional requerida antes de decidir.'),
  ('COMPATIBILITY', 'Compatibilidad', '{"type":"object"}', 'Prueba explicita de compatibilidad o aplicabilidad concreta.')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- Destinos universales: producto, variante o referencia externa
-- ---------------------------------------------------------------------------

alter table public.catalog_classes drop constraint catalog_classes_scope_allowed;
alter table public.catalog_classes add constraint catalog_classes_scope_allowed check (
  target_scope in ('product', 'variant', 'reference_product', 'reference_variant')
);

alter table public.catalog_class_members
  drop constraint catalog_class_members_one_target,
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete cascade,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete cascade,
  add column knowledge_subject_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      when variant_id is not null then 'variant:' || variant_id::text
      when reference_product_id is not null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  add constraint catalog_class_members_one_target check (
    num_nonnulls(product_id, variant_id, reference_product_id, reference_variant_id) = 1
  );

create unique index catalog_class_members_universal_target_unique_idx
  on public.catalog_class_members(class_id, knowledge_subject_ref);
create index catalog_class_members_universal_target_idx
  on public.catalog_class_members(knowledge_subject_ref, decision_status);

create or replace function public.validate_catalog_class_member()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare class_scope text;
begin
  select target_scope into class_scope from public.catalog_classes where id = new.class_id;
  if class_scope is null or not (
    (class_scope = 'product' and (new.product_id is not null or new.reference_product_id is not null))
    or (class_scope = 'variant' and (new.variant_id is not null or new.reference_variant_id is not null))
    or (class_scope = 'reference_product' and new.reference_product_id is not null)
    or (class_scope = 'reference_variant' and new.reference_variant_id is not null)
  ) then
    raise exception using errcode = '23514', message = 'El miembro no coincide con el alcance de la clase.';
  end if;
  if new.variant_id is not null and not exists (
    select 1 from public.product_variants v where v.id = new.variant_id
  ) then
    raise exception using errcode = '23503', message = 'La variante interna no existe.';
  end if;
  if new.reference_variant_id is not null and not exists (
    select 1 from public.catalog_reference_variants v where v.id = new.reference_variant_id
  ) then
    raise exception using errcode = '23503', message = 'La variante de referencia no existe.';
  end if;
  if new.origin = 'manual' and new.decision_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using errcode = '23514', message = 'Una membresia manual aprobada necesita evidencia aprobada.';
  end if;
  return new;
end;
$function$;

alter table public.product_system_roles
  alter column product_id drop not null,
  add column reference_product_id uuid references public.catalog_reference_products(id) on delete cascade,
  add column reference_variant_id uuid references public.catalog_reference_variants(id) on delete cascade,
  add column knowledge_subject_ref text generated always as (
    case
      when product_id is not null and variant_id is null then 'product:' || product_id::text
      when variant_id is not null then 'variant:' || variant_id::text
      when reference_product_id is not null and reference_variant_id is null then 'reference_product:' || reference_product_id::text
      else 'reference_variant:' || reference_variant_id::text
    end
  ) stored,
  add constraint product_system_roles_one_target check (
    (product_id is not null and reference_product_id is null and reference_variant_id is null)
    or (product_id is null and variant_id is null and reference_product_id is not null)
  ),
  add constraint product_system_roles_reference_variant_parent check (
    reference_variant_id is null or reference_product_id is not null
  );

create unique index product_system_roles_universal_target_unique_idx
  on public.product_system_roles(knowledge_subject_ref, system_id, stage_id, role_id)
  where decision_status in ('proposed', 'needs_evidence', 'approved');

create or replace function public.validate_product_system_role()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.variant_id is not null and not exists (
    select 1 from public.product_variants variant
    where variant.id = new.variant_id and variant.product_id = new.product_id
  ) then
    raise exception using errcode = '23514', message = 'La variante del rol no pertenece al producto indicado.';
  end if;
  if new.reference_variant_id is not null and not exists (
    select 1 from public.catalog_reference_variants variant
    where variant.id = new.reference_variant_id
      and variant.reference_product_id = new.reference_product_id
  ) then
    raise exception using errcode = '23514', message = 'La variante de referencia no pertenece a la referencia indicada.';
  end if;
  if new.decision_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using errcode = '23514', message = 'Un rol aprobado necesita evidencia aprobada.';
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Estado epistemico comun y puente etapa/rol -> clase
-- ---------------------------------------------------------------------------

create or replace function public.catalog_epistemic_link_is_valid_v1(
  p_epistemic_state text,
  p_semantic_claim_id uuid
)
returns boolean
language sql
stable
set search_path = ''
as $function$
  select case p_epistemic_state
    when 'NEEDS_EVIDENCE' then p_semantic_claim_id is null
    when 'SOURCE_CLAIM' then exists (
      select 1 from public.catalog_semantic_claims claim where claim.id = p_semantic_claim_id
        and claim.epistemic_class = 'NORMALIZED_SOURCE_CLAIM' and claim.claim_status = 'ASSERTED'
    )
    when 'DERIVED_INFERRED' then exists (
      select 1 from public.catalog_semantic_claims claim where claim.id = p_semantic_claim_id
        and claim.epistemic_class = 'DERIVED_INFERRED' and claim.claim_status = 'ASSERTED'
    )
    when 'CANONICAL_FACT' then exists (
      select 1 from public.catalog_semantic_claims claim where claim.id = p_semantic_claim_id
        and claim.epistemic_class = 'CANONICAL_FACT' and claim.claim_status = 'ASSERTED'
    )
    else false
  end;
$function$;

create table public.catalog_system_stage_role_classes (
  id uuid primary key default gen_random_uuid(),
  system_stage_role_id uuid not null references public.catalog_system_stage_roles(id) on delete cascade,
  class_id uuid not null references public.catalog_classes(id) on delete cascade,
  coverage_kind text not null default 'covers_role',
  epistemic_state text not null default 'NEEDS_EVIDENCE',
  semantic_claim_id uuid references public.catalog_semantic_claims(id) on delete restrict,
  decision_status text not null default 'needs_evidence',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_stage_role_id, class_id),
  constraint catalog_system_stage_role_classes_coverage_allowed check (
    coverage_kind in ('covers_role', 'alternative_coverage', 'supporting_coverage')
  ),
  constraint catalog_system_stage_role_classes_epistemic_allowed check (
    epistemic_state in ('NEEDS_EVIDENCE', 'SOURCE_CLAIM', 'DERIVED_INFERRED', 'CANONICAL_FACT')
  ),
  constraint catalog_system_stage_role_classes_status_allowed check (
    decision_status in ('proposed', 'needs_evidence', 'approved', 'rejected', 'superseded')
  ),
  constraint catalog_system_stage_role_classes_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_class_requirements (
  id uuid primary key default gen_random_uuid(),
  system_stage_role_class_id uuid not null references public.catalog_system_stage_role_classes(id) on delete cascade,
  requirement_kind_code text not null references public.catalog_requirement_kinds(code) on update cascade,
  code text not null,
  name text not null,
  necessity text not null default 'optional',
  requirement_value jsonb not null,
  epistemic_state text not null default 'NEEDS_EVIDENCE',
  semantic_claim_id uuid references public.catalog_semantic_claims(id) on delete restrict,
  decision_status text not null default 'needs_evidence',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_stage_role_class_id, code),
  constraint catalog_class_requirements_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_class_requirements_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_class_requirements_necessity_allowed check (necessity in ('required', 'recommended', 'optional')),
  constraint catalog_class_requirements_value_object check (jsonb_typeof(requirement_value) = 'object'),
  constraint catalog_class_requirements_epistemic_allowed check (
    epistemic_state in ('NEEDS_EVIDENCE', 'SOURCE_CLAIM', 'DERIVED_INFERRED', 'CANONICAL_FACT')
  ),
  constraint catalog_class_requirements_status_allowed check (
    decision_status in ('proposed', 'needs_evidence', 'approved', 'rejected', 'superseded')
  ),
  constraint catalog_class_requirements_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_stage_transitions (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null references public.catalog_systems(id) on delete cascade,
  source_stage_id uuid not null,
  target_stage_id uuid not null,
  relation_kind_code text not null references public.catalog_relation_kinds(code) on update cascade,
  condition jsonb not null default '{}'::jsonb,
  epistemic_state text not null default 'NEEDS_EVIDENCE',
  semantic_claim_id uuid references public.catalog_semantic_claims(id) on delete restrict,
  decision_status text not null default 'needs_evidence',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (source_stage_id, system_id) references public.catalog_stages(id, system_id) on delete cascade,
  foreign key (target_stage_id, system_id) references public.catalog_stages(id, system_id) on delete cascade,
  unique (system_id, source_stage_id, target_stage_id, relation_kind_code),
  constraint catalog_stage_transitions_not_self check (source_stage_id <> target_stage_id),
  constraint catalog_stage_transitions_sequence_kind check (relation_kind_code in ('PRECEDES', 'FOLLOWS')),
  constraint catalog_stage_transitions_condition_object check (jsonb_typeof(condition) = 'object'),
  constraint catalog_stage_transitions_epistemic_allowed check (
    epistemic_state in ('NEEDS_EVIDENCE', 'SOURCE_CLAIM', 'DERIVED_INFERRED', 'CANONICAL_FACT')
  ),
  constraint catalog_stage_transitions_status_allowed check (
    decision_status in ('proposed', 'needs_evidence', 'approved', 'rejected', 'superseded')
  ),
  constraint catalog_stage_transitions_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create or replace function public.validate_catalog_epistemic_assertion_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if not public.catalog_epistemic_link_is_valid_v1(new.epistemic_state, new.semantic_claim_id) then
    raise exception using errcode = '23514', message = 'El estado epistemico no coincide con el claim enlazado.';
  end if;
  if new.decision_status = 'approved' and new.epistemic_state = 'NEEDS_EVIDENCE' then
    raise exception using errcode = '23514', message = 'Una asercion sin evidencia no puede aprobarse.';
  end if;
  return new;
end;
$function$;

create trigger catalog_system_stage_role_classes_validate_epistemic
before insert or update on public.catalog_system_stage_role_classes
for each row execute function public.validate_catalog_epistemic_assertion_v1();
create trigger catalog_class_requirements_validate_epistemic
before insert or update on public.catalog_class_requirements
for each row execute function public.validate_catalog_epistemic_assertion_v1();
create trigger catalog_stage_transitions_validate_epistemic
before insert or update on public.catalog_stage_transitions
for each row execute function public.validate_catalog_epistemic_assertion_v1();

-- Las reglas entre clases existentes reciben el vocabulario universal sin
-- perder el enum legado que aun consumen lectores anteriores.
alter table public.catalog_relation_rules
  alter column relation_type drop not null,
  add column relation_kind_code text references public.catalog_relation_kinds(code) on update cascade,
  add column epistemic_state text,
  add column semantic_claim_id uuid references public.catalog_semantic_claims(id) on delete restrict;

update public.catalog_relation_rules
set relation_kind_code = case relation_type::text
    when 'requires' then 'REQUIRES'
    when 'alternative_to' then 'ALTERNATIVE_TO'
    when 'compatible_with' then 'COMPATIBLE_WITH'
    when 'replacement_for' then 'SUBSTITUTES_FOR'
    else 'COMPLEMENTS'
  end,
  epistemic_state = 'LEGACY_CANONICAL_PRE_0111';

alter table public.catalog_relation_rules
  alter column relation_kind_code set not null,
  alter column epistemic_state set not null,
  add constraint catalog_relation_rules_epistemic_allowed check (
    epistemic_state in (
      'LEGACY_CANONICAL_PRE_0111', 'NEEDS_EVIDENCE', 'SOURCE_CLAIM',
      'DERIVED_INFERRED', 'CANONICAL_FACT'
    )
  );

create index catalog_relation_rules_universal_lookup_idx
  on public.catalog_relation_rules(source_class_id, relation_kind_code, decision_status)
  where is_active;

create or replace function public.validate_catalog_relation_rule_epistemic_v1()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare relation_kind public.catalog_relation_kinds%rowtype;
begin
  select * into relation_kind from public.catalog_relation_kinds where code = new.relation_kind_code and is_active;
  if not found then
    raise exception using errcode = '23503', message = 'El tipo universal de relacion no existe o esta inactivo.';
  end if;
  if tg_op = 'INSERT' and new.epistemic_state = 'LEGACY_CANONICAL_PRE_0111' then
    raise exception using errcode = '23514', message = 'El estado legado esta cerrado para nuevas aserciones.';
  end if;
  if new.epistemic_state <> 'LEGACY_CANONICAL_PRE_0111'
     and not public.catalog_epistemic_link_is_valid_v1(new.epistemic_state, new.semantic_claim_id) then
    raise exception using errcode = '23514', message = 'La relacion de clase no coincide con su claim epistemico.';
  end if;
  if relation_kind.requires_explicit_pair_evidence then
    if new.brand_policy <> 'explicit_evidence' then
      raise exception using errcode = '23514', message = 'Compatibilidad, incompatibilidad o sustitucion exigen evidencia explicita.';
    end if;
    if new.epistemic_state not in ('NEEDS_EVIDENCE', 'LEGACY_CANONICAL_PRE_0111') and not exists (
      select 1 from public.catalog_semantic_claims claim
      where claim.id = new.semantic_claim_id and claim.dimension_code = 'compatibility'
        and claim.claim_status = 'ASSERTED'
    ) then
      raise exception using errcode = '23514', message = 'Una relacion estricta exige un claim de compatibilidad del par.';
    end if;
  end if;
  return new;
end;
$function$;

create trigger catalog_relation_rules_validate_epistemic
before insert or update of relation_kind_code, epistemic_state, semantic_claim_id, brand_policy
on public.catalog_relation_rules
for each row execute function public.validate_catalog_relation_rule_epistemic_v1();

-- ---------------------------------------------------------------------------
-- Autoridad y reglas genericas para conocimiento de procesos
-- ---------------------------------------------------------------------------

insert into public.catalog_source_predicate_authority(
  source_kind, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale, conditions
) values
  ('official', 'PROCESS', 'process.step.*', 'payload.claims*', 'process', 'preferred', 1,
   'Un manual o ficha oficial es preferente para el paso declarado, no para compatibilidad no declarada.',
   '{"claimScope":"declared_process_only"}'),
  ('official', 'TECHNICAL', 'function.*', 'payload.claims*', 'role', 'preferred', 1,
   'La ficha oficial es preferente para la funcion que declara.',
   '{"claimScope":"declared_function_only"}'),
  ('official', 'TECHNICAL', 'compatibility.pair.*', 'payload.claims*', 'compatibility', 'preferred', 1,
   'La compatibilidad concreta requiere que el fabricante o manual nombre el par o la familia aplicable.',
   '{"requiresExplicitPair":true}'),
  ('official', 'TECHNICAL', 'replacement.part.*', 'payload.claims*', 'compatibility', 'preferred', 1,
   'La sustitucion o repuesto exige manual, despiece o ficha oficial con aplicabilidad concreta.',
   '{"requiresExplicitApplicability":true}'),
  ('marketplace', 'DISCOVERY', 'popularity.*', '*', null, 'prohibited', 0,
   'Popularidad y recomendacion comercial no se convierten en hechos tecnicos.',
   '{"canonicalTechnicalFact":false}')
on conflict do nothing;

-- 0111 ya admite patrones de predicado. El mismo contrato se extiende a
-- campos como payload.claims[0] sin conceder autoridad global a la pagina.
create or replace function public.resolve_catalog_source_authority_v1(
  p_source_id uuid,
  p_predicate text,
  p_source_field text,
  p_dimension_code text
)
returns table(
  policy_id uuid,
  source_role text,
  authority_level text,
  authority_score numeric,
  rationale text
)
language sql
stable
set search_path = ''
as $function$
  select policy.id, policy.source_role, policy.authority_level,
         policy.authority_score, policy.rationale
  from public.catalog_sources source
  join public.catalog_source_predicate_authority policy
    on policy.is_active
   and (policy.source_id = source.id or policy.source_kind = source.authority)
   and (policy.dimension_code is null or policy.dimension_code = p_dimension_code)
   and (
     policy.predicate_pattern = '*'
     or (right(policy.predicate_pattern, 1) = '*'
         and p_predicate like left(policy.predicate_pattern, -1) || '%')
     or policy.predicate_pattern = p_predicate
   )
   and (
     policy.source_field_pattern = '*'
     or (right(policy.source_field_pattern, 1) = '*'
         and p_source_field like left(policy.source_field_pattern, -1) || '%')
     or policy.source_field_pattern = p_source_field
   )
  where source.id = p_source_id
  order by
    (policy.source_id is not null) desc,
    (policy.dimension_code is not null) desc,
    (policy.predicate_pattern <> '*') desc,
    (policy.source_field_pattern <> '*') desc,
    policy.authority_score desc,
    policy.id
  limit 1;
$function$;

insert into public.catalog_semantic_rules(
  rule_code, rule_version, rule_family, description, input_predicates,
  output_predicate, output_dimension_code, scope, confidence, definition
) values
  ('NORMALIZE_PROCESS_DECLARATION', 1, 'NORMALIZATION',
   'Normalizes a declared process excerpt without adding applicability or compatibility.',
   array['process.step.*'], 'process.normalized', 'process',
   '{"dimension":"process","predicate":"process.step.*"}', 1,
   '{"operation":"structured_process_normalization","inferenceAllowed":false}'),
  ('DERIVE_SYSTEM_PROCESS_CONTRACT', 1, 'RELATION',
   'Projects a declared process claim to its system contract while preserving its evidence boundary.',
   array['process.normalized'], 'process.system_contract', 'process',
   '{"dimension":"process","predicate":"process.normalized"}', 0.95,
   '{"operation":"system_process_projection","compatibilityInference":false,"canonicalPromotion":false}')
on conflict (rule_code, rule_version) do nothing;

-- La referencia oficial valida el mismo contrato sin crear un producto
-- comercial, precio, stock ni estado de publicacion.
insert into public.brands(name, slug, sort_order, is_active)
values ('ACRYLOVE', 'acrylove', 900, true)
on conflict (slug) do update set name = excluded.name, is_active = true;

update public.catalog_sources source
set brand_id = brand.id, updated_at = now()
from public.brands brand
where source.source_key = 'acrylove-official-education' and brand.slug = 'acrylove';

insert into public.catalog_research_runs(
  run_key, run_kind, actor_kind, actor_label, status, started_at, finished_at,
  input_fingerprint, result_fingerprint, scope, metrics, result
) values (
  'stage4a-acrylic-real-fixture-v1', 'targeted', 'codex', 'Etapa 4A', 'succeeded',
  now(), now(), md5('stage4a-acrylic-real-fixture-v1'), md5('stage4a-acrylic-real-fixture-v1:result'),
  '{"system":"ACRYLIC","massBrandResearch":false}'::jsonb,
  '{"officialReferences":2}'::jsonb,
  '{"contractValidationOnly":true,"commercialMutation":false}'::jsonb
)
on conflict (run_key) do nothing;

insert into public.catalog_research_run_brands(research_run_id, brand_id)
select run.id, brand.id
from public.catalog_research_runs run
join public.brands brand on brand.slug = 'acrylove'
where run.run_key = 'stage4a-acrylic-real-fixture-v1'
on conflict do nothing;

with fixture(external_id, reference_key, name, product_type) as (
  values
    ('bond-1-14ml', 'stage4a-acrylove-bond-1', 'ACRY LOVE BOND-1 (DESHIDRATADOR)', 'Dehydrator'),
    ('acrylic-remover-8oz', 'stage4a-acrylove-acrylic-remover', 'ACRY LOVE REMOVER ACRYLIC 8oz', 'Remover')
)
insert into public.catalog_reference_products(
  reference_key, brand_id, primary_source_id, primary_source_record_id,
  primary_external_id, name, normalized_name, family, product_type, source_url,
  identity_fingerprint, content_fingerprint, enrichment_level, knowledge_status,
  presence_status, first_seen_run_id, last_seen_run_id, first_seen_at, last_seen_at, metadata
)
select fixture.reference_key, brand.id, source.id, record.id, fixture.external_id,
  fixture.name, lower(fixture.name), 'Acrylic', fixture.product_type, record.source_url,
  md5('identity:' || fixture.reference_key), md5(record.payload::text),
  'REFERENCE_ENRICHED', 'observed', 'present', run.id, run.id,
  record.captured_at, record.captured_at,
  '{"fixture":"real","stage4a":true,"commercialCatalog":false}'::jsonb
from fixture
join public.catalog_sources source on source.source_key = 'acrylove-official-education'
join public.catalog_source_records record on record.source_id = source.id and record.external_id = fixture.external_id
join public.brands brand on brand.slug = 'acrylove'
join public.catalog_research_runs run on run.run_key = 'stage4a-acrylic-real-fixture-v1'
on conflict (reference_key) do nothing;

-- ---------------------------------------------------------------------------
-- Fixture real: Sistema Acrilico. La regla sigue siendo universal; ACRYLIC es
-- solo dato de validacion y conserva brechas como NEEDS_EVIDENCE.
-- ---------------------------------------------------------------------------

-- Macroetapas solicitadas: preparacion, construccion, decoracion/acabado,
-- mantenimiento y retiro. Se conservan las etapas finas ya existentes.
update public.catalog_stages set position = 70 where system_id = (
  select id from public.catalog_systems where code = 'ACRYLIC'
) and code = 'REMOVAL';

insert into public.catalog_stages(system_id, code, name, position, description, metadata)
select id, 'MAINTENANCE', 'Mantenimiento', 60,
  'Cuidado posterior y mantenimiento del resultado.',
  '{"macroStage":"maintenance","fixture":"real"}'::jsonb
from public.catalog_systems where code = 'ACRYLIC'
on conflict (system_id, code) do update set
  name = excluded.name, position = excluded.position, description = excluded.description,
  metadata = excluded.metadata, is_active = true;

update public.catalog_stages set
  name = 'Decoracion y acabado',
  metadata = metadata || '{"macroStage":"decoration_finishing"}'::jsonb
where system_id = (select id from public.catalog_systems where code = 'ACRYLIC')
  and code = 'FINISHING';

-- Mantenimiento deja de confundirse con acabado.
update public.product_system_roles assignment
set stage_id = maintenance.id, updated_at = now()
from public.catalog_stages maintenance, public.catalog_roles role
where maintenance.system_id = assignment.system_id and maintenance.code = 'MAINTENANCE'
  and role.id = assignment.role_id and role.code = 'AFTERCARE_PRODUCT'
  and assignment.system_id = (select id from public.catalog_systems where code = 'ACRYLIC');

update public.catalog_system_stage_roles expectation
set stage_id = maintenance.id, updated_at = now()
from public.catalog_stages maintenance, public.catalog_roles role
where maintenance.system_id = expectation.system_id and maintenance.code = 'MAINTENANCE'
  and role.id = expectation.role_id and role.code = 'AFTERCARE_PRODUCT'
  and expectation.system_id = (select id from public.catalog_systems where code = 'ACRYLIC');

-- Cuatro observaciones oficiales reales; ninguna se canoniza automaticamente.
with fixture(external_id, observation_key, predicate, claim_index, claim_code) as (
  values
    ('workflow-2022-12-06', 'stage4a:acrylic:workflow', 'process.step.workflow', 0, 'WORKFLOW'),
    ('beginner-guide-2023-01-31', 'stage4a:acrylic:construction', 'process.step.construction', 0, 'CONSTRUCTION'),
    ('bond-1-14ml', 'stage4a:acrylic:preparation', 'process.step.preparation', 0, 'PREPARATION'),
    ('acrylic-remover-8oz', 'stage4a:acrylic:removal', 'process.step.removal', 0, 'REMOVAL')
)
insert into public.catalog_observations(
  observation_key, source_record_id, reference_product_id, observation_kind, predicate,
  value_json, observed_at, extraction_method, extractor, confidence, metadata
)
select fixture.observation_key, record.id, reference.id, 'lifecycle', fixture.predicate,
  jsonb_build_object(
    'declarationCode', fixture.claim_code,
    'sourceExcerpt', record.payload->'claims'->>fixture.claim_index,
    'compatibilityAsserted', false
  ),
  record.captured_at, 'official_page', 'stage4a-process-fixture-v1', 0.99,
  jsonb_build_object('fixture', 'ACRYLIC', 'sourceField', 'payload.claims[' || fixture.claim_index || ']')
from fixture
join public.catalog_source_records record on record.external_id = fixture.external_id
join public.catalog_sources source on source.id = record.source_id
  and source.source_key = 'acrylove-official-education'
join public.catalog_reference_products reference on reference.reference_key = 'stage4a-acrylove-bond-1'
on conflict (observation_key) do nothing;

do $migration$
declare
  observation record;
  literal_claim_id uuid;
  normalized_execution_id uuid;
  normalized_claim_id uuid;
  system_execution_id uuid;
  system_claim_id uuid;
  source_excerpt text;
begin
  for observation in
    select o.* from public.catalog_observations o
    where o.observation_key like 'stage4a:acrylic:%'
    order by o.observation_key
  loop
    source_excerpt := observation.value_json->>'sourceExcerpt';
    literal_claim_id := public.register_catalog_literal_claim_v1(
      'stage4a:literal:' || observation.id::text, observation.id, 'process',
      observation.value_json, 'ASSERTED', observation.metadata->>'sourceField',
      source_excerpt, observation.source_record_id::text, source_excerpt,
      'stage4a-literal-entailment-v1'
    );
    normalized_execution_id := public.execute_catalog_semantic_rule_v1(
      'NORMALIZE_PROCESS_DECLARATION', 1, array[literal_claim_id], observation.target_ref,
      'process.normalized', 'process', observation.value_json, 0.99,
      jsonb_build_object('operation', 'preserve_declared_process', 'inferenceAdded', false)
    );
    normalized_claim_id := public.register_catalog_rule_claim_v1(
      'stage4a:normalized:' || observation.id::text, normalized_execution_id,
      'NORMALIZED_SOURCE_CLAIM', 'ASSERTED', observation.metadata->>'sourceField',
      source_excerpt, observation.source_record_id::text, source_excerpt,
      'stage4a-normalization-v1'
    );
    system_execution_id := public.execute_catalog_semantic_rule_v1(
      'DERIVE_SYSTEM_PROCESS_CONTRACT', 1, array[normalized_claim_id],
      'system:' || (select id::text from public.catalog_systems where code = 'ACRYLIC'),
      'process.system_contract', 'process', observation.value_json, 0.94,
      jsonb_build_object(
        'operation', 'project_declared_process_to_system',
        'compatibilityInferred', false, 'canonicalFactCreated', false
      )
    );
    system_claim_id := public.register_catalog_rule_claim_v1(
      'stage4a:system:' || observation.observation_key, system_execution_id,
      'DERIVED_INFERRED', 'ASSERTED'
    );
  end loop;
end;
$migration$;

-- Las referencias cubren el mismo rol/clase que un producto interno, sin
-- adoptarse al catalogo comercial.
with assignment(reference_key, class_code, stage_code, role_code, evidence_key) as (
  values
    ('stage4a-acrylove-bond-1', 'ACRYLIC_DEHYDRATOR', 'PREPARATION', 'PREPARATION_AGENT', 'ACRYLIC_PREPARATION_PRODUCTS'),
    ('stage4a-acrylove-acrylic-remover', 'ACRYLIC_REMOVER', 'REMOVAL', 'REMOVAL_PRODUCT', 'ACRYLIC_WORKFLOW_PRODUCTS')
)
insert into public.catalog_class_members(
  class_id, reference_product_id, origin, decision_status, evidence_set_id, metadata
)
select class.id, reference.id, 'manual', 'approved', evidence.id,
  '{"fixture":"ACRYLIC","commercialAdoption":false}'::jsonb
from assignment
join public.catalog_reference_products reference on reference.reference_key = assignment.reference_key
join public.catalog_classes class on class.code = assignment.class_code
join public.catalog_evidence_sets evidence on evidence.evidence_key = assignment.evidence_key and evidence.version = 1
on conflict (class_id, knowledge_subject_ref) do nothing;

with assignment(reference_key, stage_code, role_code, evidence_key) as (
  values
    ('stage4a-acrylove-bond-1', 'PREPARATION', 'PREPARATION_AGENT', 'ACRYLIC_PREPARATION_PRODUCTS'),
    ('stage4a-acrylove-acrylic-remover', 'REMOVAL', 'REMOVAL_PRODUCT', 'ACRYLIC_WORKFLOW_PRODUCTS')
)
insert into public.product_system_roles(
  reference_product_id, system_id, stage_id, role_id, is_primary, is_required,
  decision_status, evidence_set_id, metadata
)
select reference.id, system.id, stage.id, role.id, true, false,
  'approved', evidence.id,
  '{"fixture":"ACRYLIC","commercialAdoption":false,"compatibilityInferred":false}'::jsonb
from assignment
join public.catalog_reference_products reference on reference.reference_key = assignment.reference_key
join public.catalog_systems system on system.code = 'ACRYLIC'
join public.catalog_stages stage on stage.system_id = system.id and stage.code = assignment.stage_code
join public.catalog_roles role on role.code = assignment.role_code
join public.catalog_evidence_sets evidence on evidence.evidence_key = assignment.evidence_key and evidence.version = 1
on conflict (knowledge_subject_ref, system_id, stage_id, role_id)
where decision_status in ('proposed', 'needs_evidence', 'approved')
do nothing;

-- Clases que pueden cubrir cada rol. Las brechas se mantienen visibles y no
-- generan tareas individuales por producto.
with mapping(stage_code, role_code, class_code, claim_suffix) as (
  values
    ('PREPARATION','SANITIZING_AGENT','ACRYLIC_SANITIZER',null),
    ('PREPARATION','PREPARATION_AGENT','ACRYLIC_DEHYDRATOR','preparation'),
    ('PREPARATION','PREPARATION_TOOL','ACRYLIC_SHAPING_FILE','workflow'),
    ('EXTENSION_SETUP','EXTENSION_SUPPORT','ACRYLIC_NAIL_FORM','workflow'),
    ('EXTENSION_SETUP','EXTENSION_SUPPORT','ACRYLIC_TIP','workflow'),
    ('ADHESION','ADHESION_AGENT','ACRYLIC_PRIMER','workflow'),
    ('CONSTRUCTION','POLYMER_COMPONENT','ACRYLIC_POLYMER','construction'),
    ('CONSTRUCTION','LIQUID_COMPONENT','ACRYLIC_MONOMER','construction'),
    ('CONSTRUCTION','APPLICATION_TOOL','ACRYLIC_BRUSH','workflow'),
    ('CONSTRUCTION','LIQUID_VESSEL','ACRYLIC_LIQUID_VESSEL',null),
    ('SHAPING','SHAPING_TOOL','ACRYLIC_SHAPING_FILE','workflow'),
    ('SHAPING','DUST_REMOVAL_TOOL','ACRYLIC_DUST_BRUSH',null),
    ('SHAPING','SURFACE_CLEANSER','ACRYLIC_CLEANSER','workflow'),
    ('FINISHING','FINISHING_PRODUCT','ACRYLIC_TOP_COAT','workflow'),
    ('MAINTENANCE','AFTERCARE_PRODUCT','ACRYLIC_AFTERCARE','construction'),
    ('REMOVAL','REMOVAL_PRODUCT','ACRYLIC_REMOVER','removal')
), context as (
  select system.id as system_id from public.catalog_systems system where system.code = 'ACRYLIC'
)
insert into public.catalog_system_stage_role_classes(
  system_stage_role_id, class_id, coverage_kind, epistemic_state,
  semantic_claim_id, decision_status, metadata
)
select expectation.id, class.id,
  case when mapping.class_code in ('ACRYLIC_NAIL_FORM','ACRYLIC_TIP') then 'alternative_coverage' else 'covers_role' end,
  case when mapping.claim_suffix is null then 'NEEDS_EVIDENCE' else 'DERIVED_INFERRED' end,
  claim.id,
  case when mapping.claim_suffix is null then 'needs_evidence' else 'proposed' end,
  jsonb_build_object('fixture', 'ACRYLIC', 'compatibilityInferred', false)
from mapping
cross join context
join public.catalog_stages stage on stage.system_id = context.system_id and stage.code = mapping.stage_code
join public.catalog_roles role on role.code = mapping.role_code
join public.catalog_system_stage_roles expectation
  on expectation.system_id = context.system_id and expectation.stage_id = stage.id and expectation.role_id = role.id
join public.catalog_classes class on class.code = mapping.class_code
left join public.catalog_semantic_claims claim
  on claim.claim_key = 'stage4a:system:stage4a:acrylic:' || mapping.claim_suffix
on conflict (system_stage_role_id, class_id) do nothing;

with requirements(stage_code, role_code, class_code, requirement_code, requirement_name,
                  kind_code, necessity, requirement_value, claim_suffix) as (
  values
    ('PREPARATION','PREPARATION_AGENT','ACRYLIC_DEHYDRATOR','DECLARES_PREPARATION_FUNCTION','Funcion de preparacion declarada','CAPABILITY','recommended','{"capability":"surface_preparation"}'::jsonb,'preparation'),
    ('CONSTRUCTION','POLYMER_COMPONENT','ACRYLIC_POLYMER','FORMS_APPLICATION_BEAD','Forma una perla de aplicacion','PROCESS','required','{"withRole":"LIQUID_COMPONENT","result":"application_bead"}'::jsonb,'construction'),
    ('CONSTRUCTION','LIQUID_COMPONENT','ACRYLIC_MONOMER','FORMS_APPLICATION_BEAD','Forma una perla de aplicacion','PROCESS','required','{"withRole":"POLYMER_COMPONENT","result":"application_bead","pairCompatibility":"needs_explicit_evidence"}'::jsonb,'construction'),
    ('CONSTRUCTION','APPLICATION_TOOL','ACRYLIC_BRUSH','PICKUP_WITH_DAMP_TOOL','Recoge material con herramienta humedecida','PROCESS','required','{"action":"pickup_material"}'::jsonb,'workflow'),
    ('REMOVAL','REMOVAL_PRODUCT','ACRYLIC_REMOVER','DECLARES_REMOVAL_FUNCTION','Funcion de retiro declarada','CAPABILITY','optional','{"capability":"system_removal"}'::jsonb,'removal'),
    ('PREPARATION','SANITIZING_AGENT','ACRYLIC_SANITIZER','PROCESS_EVIDENCE_PENDING','Evidencia de sanitizacion pendiente','EVIDENCE','recommended','{"status":"needs_evidence"}'::jsonb,null),
    ('SHAPING','DUST_REMOVAL_TOOL','ACRYLIC_DUST_BRUSH','PROCESS_EVIDENCE_PENDING','Evidencia de retiro de polvo pendiente','EVIDENCE','recommended','{"status":"needs_evidence"}'::jsonb,null),
    ('CONSTRUCTION','LIQUID_VESSEL','ACRYLIC_LIQUID_VESSEL','PROCESS_EVIDENCE_PENDING','Evidencia de recipiente de trabajo pendiente','EVIDENCE','recommended','{"status":"needs_evidence"}'::jsonb,null)
)
insert into public.catalog_class_requirements(
  system_stage_role_class_id, requirement_kind_code, code, name, necessity,
  requirement_value, epistemic_state, semantic_claim_id, decision_status, metadata
)
select bridge.id, requirement.kind_code, requirement.requirement_code,
  requirement.requirement_name, requirement.necessity, requirement.requirement_value,
  case when requirement.claim_suffix is null then 'NEEDS_EVIDENCE' else 'DERIVED_INFERRED' end,
  claim.id,
  case when requirement.claim_suffix is null then 'needs_evidence' else 'proposed' end,
  '{"fixture":"ACRYLIC","publicationBlocking":false,"commercialMutation":false}'::jsonb
from requirements requirement
join public.catalog_systems system on system.code = 'ACRYLIC'
join public.catalog_stages stage on stage.system_id = system.id and stage.code = requirement.stage_code
join public.catalog_roles role on role.code = requirement.role_code
join public.catalog_system_stage_roles expectation
  on expectation.system_id = system.id and expectation.stage_id = stage.id and expectation.role_id = role.id
join public.catalog_classes class on class.code = requirement.class_code
join public.catalog_system_stage_role_classes bridge
  on bridge.system_stage_role_id = expectation.id and bridge.class_id = class.id
left join public.catalog_semantic_claims claim
  on claim.claim_key = 'stage4a:system:stage4a:acrylic:' || requirement.claim_suffix
on conflict (system_stage_role_class_id, code) do nothing;

with transition(source_code, target_code, claim_suffix, condition) as (
  values
    ('PREPARATION','EXTENSION_SETUP','workflow','{"branch":"extension_or_natural"}'::jsonb),
    ('PREPARATION','ADHESION','workflow','{"branch":"direct_after_preparation"}'::jsonb),
    ('EXTENSION_SETUP','ADHESION','workflow','{}'::jsonb),
    ('ADHESION','CONSTRUCTION','workflow','{}'::jsonb),
    ('CONSTRUCTION','SHAPING','workflow','{}'::jsonb),
    ('SHAPING','FINISHING','workflow','{}'::jsonb),
    ('FINISHING','MAINTENANCE','construction','{}'::jsonb),
    ('MAINTENANCE','REMOVAL',null,'{"lifecycle":"eventual_optional_transition"}'::jsonb)
)
insert into public.catalog_stage_transitions(
  system_id, source_stage_id, target_stage_id, relation_kind_code,
  condition, epistemic_state, semantic_claim_id, decision_status, metadata
)
select system.id, source_stage.id, target_stage.id, 'PRECEDES', transition.condition,
  case when transition.claim_suffix is null then 'NEEDS_EVIDENCE' else 'DERIVED_INFERRED' end,
  claim.id,
  case when transition.claim_suffix is null then 'needs_evidence' else 'proposed' end,
  '{"fixture":"ACRYLIC","compatibilityInferred":false}'::jsonb
from transition
join public.catalog_systems system on system.code = 'ACRYLIC'
join public.catalog_stages source_stage on source_stage.system_id = system.id and source_stage.code = transition.source_code
join public.catalog_stages target_stage on target_stage.system_id = system.id and target_stage.code = transition.target_code
left join public.catalog_semantic_claims claim
  on claim.claim_key = 'stage4a:system:stage4a:acrylic:' || transition.claim_suffix
on conflict (system_id, source_stage_id, target_stage_id, relation_kind_code) do nothing;

-- ---------------------------------------------------------------------------
-- Proyeccion grafo: PostgreSQL decide; Neo4j solo recibe nodos/aristas.
-- ---------------------------------------------------------------------------

create or replace view public.graph_system_class_contract_nodes_v1
with (security_invoker = true) as
select 'requirement:' || requirement.id::text as node_key,
       'requirement'::text as node_type, requirement.id as entity_id,
       requirement.name as label,
       case when requirement.epistemic_state = 'CANONICAL_FACT' then 'canonical' else 'evidence' end as layer,
       jsonb_build_object('code', requirement.code, 'kind', requirement.requirement_kind_code,
         'necessity', requirement.necessity, 'epistemicState', requirement.epistemic_state,
         'decisionStatus', requirement.decision_status) as properties
from public.catalog_class_requirements requirement where requirement.is_active;

create or replace view public.graph_system_class_contract_edges_v1
with (security_invoker = true) as
select 'system-role:' || expectation.id::text as edge_key,
       'stage:' || expectation.stage_id::text as source_key, 'EXPECTS_ROLE'::text as predicate,
       'role:' || expectation.role_id::text as target_key,
       'evidence'::text as layer,
       jsonb_build_object('necessity', expectation.necessity, 'status', expectation.decision_status) as properties
from public.catalog_system_stage_roles expectation where expectation.is_active
union all
select 'role-class:' || bridge.id::text,
       'role:' || expectation.role_id::text, 'COVERED_BY_CLASS', 'class:' || bridge.class_id::text,
       case when bridge.epistemic_state = 'CANONICAL_FACT' then 'canonical' else 'evidence' end,
       jsonb_build_object('stageId', expectation.stage_id, 'coverageKind', bridge.coverage_kind,
         'epistemicState', bridge.epistemic_state, 'decisionStatus', bridge.decision_status)
from public.catalog_system_stage_role_classes bridge
join public.catalog_system_stage_roles expectation on expectation.id = bridge.system_stage_role_id
where bridge.is_active
union all
select 'class-requirement:' || requirement.id::text,
       'class:' || bridge.class_id::text, 'HAS_REQUIREMENT', 'requirement:' || requirement.id::text,
       case when requirement.epistemic_state = 'CANONICAL_FACT' then 'canonical' else 'evidence' end,
       jsonb_build_object('epistemicState', requirement.epistemic_state,
         'decisionStatus', requirement.decision_status)
from public.catalog_class_requirements requirement
join public.catalog_system_stage_role_classes bridge on bridge.id = requirement.system_stage_role_class_id
where requirement.is_active
union all
select 'stage-transition:' || transition.id::text,
       'stage:' || transition.source_stage_id::text, transition.relation_kind_code,
       'stage:' || transition.target_stage_id::text,
       case when transition.epistemic_state = 'CANONICAL_FACT' then 'canonical' else 'evidence' end,
       jsonb_build_object('epistemicState', transition.epistemic_state,
         'decisionStatus', transition.decision_status, 'condition', transition.condition)
from public.catalog_stage_transitions transition where transition.is_active;

-- Las proyecciones heredadas usan ahora la clave universal; para productos
-- internos conserva el valor anterior y para referencias evita origenes nulos.
create or replace view public.graph_system_role_edges_v1
with (security_invoker = true) as
select
  'system-role:' || assignment.id::text || ':system' as edge_key,
  assignment.knowledge_subject_ref as source_key,
  'BELONGS_TO'::text as predicate,
  'system:' || assignment.system_id::text as target_key,
  jsonb_build_object('roleId', assignment.role_id, 'isPrimary', assignment.is_primary,
    'isRequired', assignment.is_required) as properties
from public.product_system_roles assignment
where assignment.decision_status = 'approved'
union all
select
  'system-role:' || assignment.id::text || ':stage',
  assignment.knowledge_subject_ref, 'USED_IN', 'stage:' || assignment.stage_id::text,
  jsonb_build_object('systemId', assignment.system_id, 'roleId', assignment.role_id,
    'isPrimary', assignment.is_primary, 'isRequired', assignment.is_required)
from public.product_system_roles assignment
where assignment.decision_status = 'approved';

create or replace view public.graph_class_membership_edges_v1
with (security_invoker = true) as
select
  'class-member:' || membership.id::text as edge_key,
  membership.knowledge_subject_ref as source_key,
  'MEMBER_OF'::text as predicate,
  'class:' || membership.class_id::text as target_key,
  jsonb_build_object('origin', membership.origin, 'ruleGroup', membership.source_rule_group) as properties
from public.catalog_class_members membership
where membership.decision_status = 'approved';

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select node.node_key, node.node_type, node.entity_id, node.label, node.layer,
       node.properties,
       md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|'
         || node.label || '|' || node.properties::text) as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all select * from public.graph_identity_case_nodes_v1
  union all select * from public.graph_review_work_nodes_v1
  union all select * from public.graph_semantic_term_nodes_v1
  union all select * from public.graph_semantic_problem_group_nodes_v1
  union all select * from public.graph_universal_semantic_nodes_v1
  union all select * from public.graph_system_class_contract_nodes_v1
) node;

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select edge.edge_key, edge.source_key, edge.predicate, edge.target_key,
       edge.layer, edge.properties,
       md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|'
         || edge.target_key || '|' || edge.layer || '|' || edge.properties::text)
         as projection_fingerprint
from (
  select * from public.graph_edges_v2_base where edge_key not like 'reference-match:%'
  union all select * from public.graph_identity_case_edges_v1
  union all select * from public.graph_review_work_edges_v1
  union all select * from public.graph_semantic_term_edges_v1
  union all select * from public.graph_semantic_problem_group_edges_v1
  union all select * from public.graph_universal_semantic_edges_v1
  union all select * from public.graph_system_class_contract_edges_v1
) edge;

-- ---------------------------------------------------------------------------
-- Reporte del corte. Las 323 relaciones historicas siguen intactas.
-- ---------------------------------------------------------------------------

create or replace function public.get_catalog_stage4a_report_v1()
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $function$
  select jsonb_build_object(
    'contractVersion', 'stage4a-v1',
    'stage4Authorized', false,
    'scope', jsonb_build_object(
      'systems', (select count(*) from public.catalog_systems where is_active),
      'stages', (select count(*) from public.catalog_stages where is_active),
      'roles', (select count(*) from public.catalog_roles where is_active),
      'classes', (select count(*) from public.catalog_classes where is_active),
      'requirements', (select count(*) from public.catalog_class_requirements where is_active),
      'sequences', (select count(*) from public.catalog_stage_transitions where is_active)
    ),
    'historicalRelations', jsonb_build_object(
      'checkpointDeferred', 323,
      'availableInCurrentDataset', (select count(*) from public.catalog_relation_candidates where status = 'needs_evidence'),
      'untouched', 323,
      'analyzedThisCut', 0,
      'expressibleAsMembershipOrClass', 0,
      'genuinelyProductToProduct', 0,
      'needsEvidenceAtCheckpoint', 323,
      'contradicted', 0,
      'unknown', 0,
      'canonicalizationCandidates', 0,
      'blockedAtCheckpoint', 323,
      'batchMutationPerformed', false
    ),
    'epistemic', jsonb_build_object(
      'literalObservations', (select count(*) from public.catalog_semantic_claims where claim_key like 'stage4a:literal:%'),
      'normalizedSourceClaims', (select count(*) from public.catalog_semantic_claims where claim_key like 'stage4a:normalized:%'),
      'derivedInferences', (select count(*) from public.catalog_semantic_claims where claim_key like 'stage4a:system:%'),
      'canonicalFactsCreated', (select count(*) from public.catalog_semantic_claims where epistemic_class = 'CANONICAL_FACT' and claim_key like 'stage4a:%'),
      'pendingRequirements', (select count(*) from public.catalog_class_requirements where epistemic_state = 'NEEDS_EVIDENCE'),
      'pendingTransitions', (select count(*) from public.catalog_stage_transitions where epistemic_state = 'NEEDS_EVIDENCE')
    ),
    'coverage', jsonb_build_object(
      'internalProducts', (select count(distinct product_id) from public.product_system_roles where product_id is not null and decision_status = 'approved'),
      'internalVariants', (select count(distinct variant_id) from public.product_system_roles where variant_id is not null and decision_status = 'approved'),
      'referenceProducts', (select count(distinct reference_product_id) from public.product_system_roles where reference_product_id is not null),
      'referenceVariants', (select count(distinct reference_variant_id) from public.product_system_roles where reference_variant_id is not null),
      'roleClassMappings', (select count(*) from public.catalog_system_stage_role_classes where is_active)
    ),
    'semanticFunnel', jsonb_build_object(
      'products', (select count(*) from public.products),
      'claims', (select count(*) from public.catalog_semantic_claims),
      'problems', (select count(*) from public.catalog_semantic_problems where status = 'active'),
      'groups', (select count(*) from public.catalog_semantic_problem_groups_v1),
      'rules', (select count(*) from public.catalog_semantic_rules where is_active),
      'humanExceptions', (select count(*) from public.catalog_review_work_items
        where handling_class = 'human_exception' and status not in ('superseded', 'cancelled'))
    ),
    'guards', jsonb_build_object(
      'membershipImpliesCompatibility', false,
      'sameSystemImpliesCompatibility', false,
      'sameBrandImpliesCompatibility', false,
      'humanReviewPerProductGenerated', 0,
      'priceChanged', false,
      'stockChanged', false,
      'publicationChanged', false,
      'postgresqlAuthority', true,
      'neo4jProjectionOnly', true
    )
  );
$function$;

-- Seguridad y privilegios del contrato.
alter table public.catalog_role_kinds enable row level security;
alter table public.catalog_relation_kinds enable row level security;
alter table public.catalog_requirement_kinds enable row level security;
alter table public.catalog_system_stage_role_classes enable row level security;
alter table public.catalog_class_requirements enable row level security;
alter table public.catalog_stage_transitions enable row level security;

create policy "public read role kinds" on public.catalog_role_kinds for select using (is_active);
create policy "public read relation kinds" on public.catalog_relation_kinds for select using (is_active);
create policy "public read requirement kinds" on public.catalog_requirement_kinds for select using (is_active);
create policy "public read active role class mappings" on public.catalog_system_stage_role_classes
for select using (is_active and decision_status in ('proposed','approved'));
create policy "public read active class requirements" on public.catalog_class_requirements
for select using (is_active and decision_status in ('proposed','approved'));
create policy "public read active stage transitions" on public.catalog_stage_transitions
for select using (is_active and decision_status in ('proposed','approved'));

create policy "admins manage role kinds" on public.catalog_role_kinds
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "admins manage relation kinds" on public.catalog_relation_kinds
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "admins manage requirement kinds" on public.catalog_requirement_kinds
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "admins manage role class mappings" on public.catalog_system_stage_role_classes
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "admins manage class requirements" on public.catalog_class_requirements
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));
create policy "admins manage stage transitions" on public.catalog_stage_transitions
for all to authenticated using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

grant select on public.catalog_role_kinds, public.catalog_relation_kinds,
  public.catalog_requirement_kinds, public.catalog_system_stage_role_classes,
  public.catalog_class_requirements, public.catalog_stage_transitions
to authenticated, service_role;
grant select on public.graph_system_class_contract_nodes_v1,
  public.graph_system_class_contract_edges_v1
to authenticated, service_role;
grant insert, update, delete on public.catalog_role_kinds, public.catalog_relation_kinds,
  public.catalog_requirement_kinds, public.catalog_system_stage_role_classes,
  public.catalog_class_requirements, public.catalog_stage_transitions
to authenticated, service_role;
grant execute on function public.get_catalog_stage4a_report_v1() to authenticated, service_role;
grant execute on function public.catalog_epistemic_link_is_valid_v1(text, uuid) to authenticated, service_role;

revoke execute on function public.get_catalog_stage4a_report_v1() from public, anon;
revoke execute on function public.catalog_epistemic_link_is_valid_v1(text, uuid) from public, anon;

revoke all on function public.validate_catalog_epistemic_assertion_v1() from public, anon, authenticated;
revoke all on function public.validate_catalog_relation_rule_epistemic_v1() from public, anon, authenticated;

create trigger catalog_role_kinds_set_updated_at before update on public.catalog_role_kinds
for each row execute function public.set_updated_at();
create trigger catalog_relation_kinds_set_updated_at before update on public.catalog_relation_kinds
for each row execute function public.set_updated_at();
create trigger catalog_requirement_kinds_set_updated_at before update on public.catalog_requirement_kinds
for each row execute function public.set_updated_at();
create trigger catalog_system_stage_role_classes_set_updated_at before update on public.catalog_system_stage_role_classes
for each row execute function public.set_updated_at();
create trigger catalog_class_requirements_set_updated_at before update on public.catalog_class_requirements
for each row execute function public.set_updated_at();
create trigger catalog_stage_transitions_set_updated_at before update on public.catalog_stage_transitions
for each row execute function public.set_updated_at();

comment on table public.catalog_system_stage_role_classes is
  'Universal bridge from an existing system/stage/role expectation to one class that can cover the role.';
comment on table public.catalog_class_requirements is
  'Typed process, capability, specification, safety, evidence or compatibility requirements attached to role-covering classes.';
comment on table public.catalog_stage_transitions is
  'Data-driven process ordering and branching. Stage position alone is not treated as an asserted sequence.';
comment on function public.get_catalog_stage4a_report_v1() is
  'Read-only Stage 4A report. Historical relations remain deferred and stage4Authorized remains false.';

commit;
