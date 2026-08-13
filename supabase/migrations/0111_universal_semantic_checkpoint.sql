-- 0111 - Checkpoint Semantico Universal
--
-- Cierra el contrato epistemologico antes de conocimiento masivo. La verdad
-- permanece en PostgreSQL y el grafo sigue siendo una proyeccion reconstruible.

begin;

-- ---------------------------------------------------------------------------
-- Dimensiones extensibles y reglas universales versionadas
-- ---------------------------------------------------------------------------

create table public.catalog_semantic_dimensions (
  code text primary key,
  label text not null,
  description text,
  value_kind text not null default 'term',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_dimensions_code_format check (code ~ '^[a-z][a-z0-9_]*$'),
  constraint catalog_semantic_dimensions_label_not_blank check (length(trim(label)) > 0),
  constraint catalog_semantic_dimensions_value_kind_allowed check (
    value_kind in ('term', 'scalar', 'quantity', 'range', 'relation', 'document', 'media', 'structured')
  ),
  constraint catalog_semantic_dimensions_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_semantic_dimensions(code, label, value_kind, description)
values
  ('type', 'Type', 'term', 'Technical identity at the broadest useful level.'),
  ('subtype', 'Subtype', 'term', 'Technical identity below type.'),
  ('concern', 'Concern', 'term', 'Condition or problem explicitly addressed.'),
  ('benefit', 'Benefit', 'term', 'Declared outcome or benefit.'),
  ('ingredient', 'Ingredient', 'structured', 'Declared material, ingredient or component.'),
  ('use', 'Use', 'term', 'Declared intended use.'),
  ('role', 'Role', 'term', 'Role inside a system or workflow.'),
  ('stage', 'Stage', 'term', 'Stage in which the subject participates.'),
  ('system', 'System', 'relation', 'System membership or compatibility context.'),
  ('formulation', 'Formulation', 'structured', 'Formulation or composition properties.'),
  ('finish', 'Finish', 'term', 'Surface or visual finish.'),
  ('relation', 'Relation', 'relation', 'Typed relation to another subject.'),
  ('identity', 'Identity', 'structured', 'Names, codes and identity evidence.'),
  ('specification', 'Specification', 'structured', 'General technical specification.'),
  ('composition', 'Composition', 'structured', 'Chemical or material composition.'),
  ('process', 'Process', 'structured', 'Manufacturing or application process.'),
  ('price', 'Price', 'quantity', 'Commercial price observation.'),
  ('media', 'Media', 'media', 'Images, documents or other media.'),
  ('dimensions', 'Dimensions', 'quantity', 'Physical dimensions or capacity.'),
  ('electrical', 'Electrical', 'quantity', 'Electrical characteristics.'),
  ('compatibility', 'Compatibility', 'relation', 'Strict compatibility assertion.'),
  ('packaging', 'Packaging', 'structured', 'Packaging and bundle composition.')
on conflict (code) do nothing;

alter table public.catalog_semantic_terms
  drop constraint catalog_semantic_terms_dimension_allowed;

alter table public.catalog_semantic_terms
  add constraint catalog_semantic_terms_dimension_fk
  foreign key (dimension) references public.catalog_semantic_dimensions(code) on update cascade;

create table public.catalog_semantic_rules (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null,
  rule_version integer not null,
  rule_family text not null,
  description text not null,
  input_predicates text[] not null,
  output_predicate text not null,
  output_dimension_code text not null references public.catalog_semantic_dimensions(code) on update cascade,
  scope jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) not null,
  definition jsonb not null,
  is_active boolean not null default true,
  supersedes_rule_id uuid references public.catalog_semantic_rules(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_rules_identity_unique unique (rule_code, rule_version),
  constraint catalog_semantic_rules_code_format check (rule_code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_semantic_rules_version_positive check (rule_version > 0),
  constraint catalog_semantic_rules_family_allowed check (rule_family in (
    'NORMALIZATION', 'DERIVATION', 'APPLICABILITY', 'EXCLUSION',
    'CONTRADICTION', 'UNIT', 'RELATION', 'AUTHORITY'
  )),
  constraint catalog_semantic_rules_description_not_blank check (length(trim(description)) > 0),
  constraint catalog_semantic_rules_inputs_present check (cardinality(input_predicates) > 0),
  constraint catalog_semantic_rules_output_not_blank check (length(trim(output_predicate)) > 0),
  constraint catalog_semantic_rules_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint catalog_semantic_rules_scope_object check (jsonb_typeof(scope) = 'object'),
  constraint catalog_semantic_rules_definition_object check (jsonb_typeof(definition) = 'object'),
  constraint catalog_semantic_rules_scope_universal check (
    scope::text !~* '"(brand|brand_id|brandId|sku|product|product_id|productId|reference_product_id|referenceProductId)"[[:space:]]*:'
  ),
  constraint catalog_semantic_rules_definition_universal check (
    definition::text !~* '"(brand|brand_id|brandId|sku|product_id|productId|reference_product_id|referenceProductId)"[[:space:]]*:'
  )
);

insert into public.catalog_semantic_rules(
  rule_code, rule_version, rule_family, description, input_predicates,
  output_predicate, output_dimension_code, scope, confidence, definition
) values
  ('NORMALIZE_LITERAL_TERM', 1, 'NORMALIZATION',
   'Normalizes a literally entailed source token without adding meaning.',
   array['semantic.*'], 'semantic.normalized', 'type',
   '{"dimension":"*","predicate":"semantic.*"}', 1,
   '{"operation":"lexical_normalization","inferenceAllowed":false}'),
  ('DERIVE_LOGICAL_CLAIM', 1, 'DERIVATION',
   'Derives a new assertion only from declared inputs with an explicit explanation.',
   array['claim.value'], 'semantic.derived', 'benefit',
   '{"technicalType":"*","dimension":"benefit","predicate":"*"}', 0.8,
   '{"operation":"logical_derivation","literalSourceClaim":false}'),
  ('APPLY_CONDITIONAL_DIMENSION', 1, 'APPLICABILITY',
   'Evaluates a conditional dimension policy from technical-type data.',
   array['technical_type','dimension'], 'semantic.applicability', 'type',
   '{"technicalType":"*","dimension":"*"}', 1,
   '{"operation":"profile_condition","default":"not_applicable"}'),
  ('DETECT_EXCLUSIVE_VALUES', 1, 'EXCLUSION',
   'Registers mutually exclusive values without discarding either evidence chain.',
   array['claim.value','claim.value'], 'semantic.exclusion', 'relation',
   '{"dimension":"*","predicate":"*"}', 1,
   '{"operation":"explicit_relation","relation":"EXCLUDES"}'),
  ('DETECT_CONTRADICTORY_VALUES', 1, 'CONTRADICTION',
   'Registers incompatible assertions as an explicit contradiction.',
   array['claim.value','claim.value'], 'semantic.contradiction', 'relation',
   '{"dimension":"*","predicate":"*"}', 1,
   '{"operation":"explicit_relation","relation":"CONTRADICTS"}'),
  ('NORMALIZE_QUANTITY_UNIT', 1, 'UNIT',
   'Converts quantities only when dimension and unit families are compatible.',
   array['quantity.value','quantity.unit'], 'semantic.quantity', 'specification',
   '{"dimension":"*","predicate":"*"}', 1,
   '{"operation":"unit_conversion","crossDimension":false}'),
  ('DERIVE_TYPED_RELATION', 1, 'RELATION',
   'Derives a typed relation from declared inputs and an explicit rule.',
   array['claim.subject','claim.object'], 'semantic.relation', 'relation',
   '{"technicalType":"*","dimension":"relation"}', 0.9,
   '{"operation":"typed_relation","compatibility":"strict"}'),
  ('RESOLVE_SOURCE_PREDICATE_AUTHORITY', 1, 'AUTHORITY',
   'Evaluates authority for a source, predicate and source field.',
   array['source.kind','claim.predicate','source.field'], 'semantic.authority', 'identity',
   '{"sourceKind":"*","sourceField":"*","predicate":"*"}', 1,
   '{"operation":"authority_matrix"}'),
  ('PROMOTE_CANONICAL_ASSERTION', 1, 'AUTHORITY',
   'Promotes an asserted candidate only after evidence, authority and contradiction gates.',
   array['claim.asserted','claim.authority','claim.contradictions'], 'semantic.canonical', 'identity',
   '{"technicalType":"*","dimension":"*","predicate":"*"}', 1,
   '{"operation":"canonical_promotion","requiresExplicitGate":true}')
on conflict (rule_code, rule_version) do nothing;

-- ---------------------------------------------------------------------------
-- Perfiles por tipo tecnico (mapeados a las plantillas operativas existentes)
-- ---------------------------------------------------------------------------

create table public.catalog_technical_type_profiles (
  id uuid primary key default gen_random_uuid(),
  technical_type_code text not null unique,
  label text not null,
  template_id uuid unique references public.attribute_templates(id) on delete restrict,
  parent_profile_id uuid references public.catalog_technical_type_profiles(id) on delete restrict,
  description text,
  is_abstract boolean not null default false,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_technical_type_profiles_code_format check (technical_type_code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_technical_type_profiles_label_not_blank check (length(trim(label)) > 0),
  constraint catalog_technical_type_profiles_not_self_parent check (parent_profile_id is null or parent_profile_id <> id),
  constraint catalog_technical_type_profiles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

insert into public.catalog_technical_type_profiles(
  technical_type_code, label, description, is_abstract
) values (
  'UNIVERSAL_PRODUCT', 'Universal product',
  'Abstract root profile. Child types inherit policies and override them with data.', true
);

create or replace function public.sync_catalog_technical_type_profile_from_template()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare root_profile_id uuid;
begin
  select id into root_profile_id
  from public.catalog_technical_type_profiles
  where technical_type_code = 'UNIVERSAL_PRODUCT';

  insert into public.catalog_technical_type_profiles(
    technical_type_code, label, template_id, parent_profile_id, description
  ) values (
    new.code, new.name, new.id, root_profile_id,
    coalesce(new.description, 'Operational technical type profile.')
  )
  on conflict (technical_type_code) do update
  set label = excluded.label,
      template_id = excluded.template_id,
      parent_profile_id = excluded.parent_profile_id,
      description = excluded.description,
      updated_at = now();
  return new;
end;
$function$;

create trigger attribute_templates_sync_semantic_profile
after insert on public.attribute_templates
for each row execute function public.sync_catalog_technical_type_profile_from_template();

create or replace function public.sync_all_catalog_technical_type_profiles_v1()
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  root_profile_id uuid;
  synchronized_count integer;
begin
  select id into root_profile_id
  from public.catalog_technical_type_profiles
  where technical_type_code = 'UNIVERSAL_PRODUCT';

  insert into public.catalog_technical_type_profiles(
    technical_type_code, label, template_id, parent_profile_id, description
  )
  select template.code, template.name, template.id, root_profile_id,
         coalesce(template.description, 'Operational technical type profile.')
  from public.attribute_templates template
  on conflict (technical_type_code) do update
  set label = excluded.label,
      template_id = excluded.template_id,
      parent_profile_id = excluded.parent_profile_id,
      description = excluded.description,
      updated_at = now();
  get diagnostics synchronized_count = row_count;
  return synchronized_count;
end;
$function$;

insert into public.catalog_technical_type_profiles(
  technical_type_code, label, template_id, parent_profile_id, description
)
select template.code, template.name, template.id, root.id,
       coalesce(template.description, 'Operational technical type profile.')
from public.attribute_templates template
cross join public.catalog_technical_type_profiles root
where root.technical_type_code = 'UNIVERSAL_PRODUCT'
on conflict (technical_type_code) do update
set template_id = excluded.template_id,
    label = excluded.label,
    parent_profile_id = excluded.parent_profile_id;

insert into public.catalog_technical_type_profiles(
  technical_type_code, label, parent_profile_id, description
)
select archetype.code, archetype.label, root.id, archetype.description
from public.catalog_technical_type_profiles root
cross join (values
  ('COSMETIC_CHEMICAL', 'Cosmetic or chemical', 'Synthetic archetype for composition and process claims.'),
  ('DIMENSIONAL_CONSUMABLE', 'Dimensional consumable', 'Synthetic archetype for dimensions and unit normalization.'),
  ('VARIANT_PRODUCT', 'Product with variants', 'Synthetic archetype for product and variant scopes.'),
  ('ELECTRICAL_EQUIPMENT', 'Electrical equipment', 'Synthetic archetype for electrical specifications.'),
  ('TOOL', 'Tool', 'Synthetic archetype for use and compatibility.'),
  ('SPARE_PART', 'Spare part', 'Synthetic archetype for strict compatibility.'),
  ('KIT_BUNDLE', 'Kit or bundle', 'Synthetic archetype for component composition.'),
  ('MULTIPURPOSE_PRODUCT', 'Multipurpose product', 'Synthetic archetype with multiple explicit uses.'),
  ('CONTRADICTORY_MULTI_SOURCE', 'Contradictory multi-source product', 'Synthetic archetype preserving incompatible evidence.'),
  ('INCOMPLETE_DATA_PRODUCT', 'Incomplete-data product', 'Synthetic archetype for absence-state semantics.')
) archetype(code, label, description)
where root.technical_type_code = 'UNIVERSAL_PRODUCT'
on conflict (technical_type_code) do nothing;

create table public.catalog_technical_type_dimension_policies (
  profile_id uuid not null references public.catalog_technical_type_profiles(id) on delete cascade,
  dimension_code text not null references public.catalog_semantic_dimensions(code) on update cascade,
  applicability text not null,
  condition_rule_code text,
  condition_rule_version integer,
  rationale text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (profile_id, dimension_code),
  foreign key (condition_rule_code, condition_rule_version)
    references public.catalog_semantic_rules(rule_code, rule_version) on delete restrict,
  constraint catalog_technical_type_dimension_applicability_allowed check (
    applicability in ('required', 'optional', 'conditional', 'not_applicable', 'forbidden')
  ),
  constraint catalog_technical_type_dimension_condition_consistent check (
    (applicability = 'conditional' and condition_rule_code is not null and condition_rule_version is not null)
    or (applicability <> 'conditional' and condition_rule_code is null and condition_rule_version is null)
  ),
  constraint catalog_technical_type_dimension_rationale_not_blank check (length(trim(rationale)) > 0),
  constraint catalog_technical_type_dimension_metadata_object check (jsonb_typeof(metadata) = 'object')
);

-- Every registered dimension is data-driven and inherited as optional by default.
insert into public.catalog_technical_type_dimension_policies(
  profile_id, dimension_code, applicability, rationale
)
select profile.id, dimension.code, 'optional',
       'Universal default; the technical type may override this policy with data.'
from public.catalog_technical_type_profiles profile
cross join public.catalog_semantic_dimensions dimension
where profile.technical_type_code = 'UNIVERSAL_PRODUCT'
on conflict do nothing;

-- Archetype-specific requirements. Nothing here references a brand, SKU or product.
insert into public.catalog_technical_type_dimension_policies(
  profile_id, dimension_code, applicability, condition_rule_code, condition_rule_version, rationale
)
select profile.id, policy.dimension_code, policy.applicability,
       policy.condition_rule_code, policy.condition_rule_version, policy.rationale
from public.catalog_technical_type_profiles profile
join (values
  ('COSMETIC_CHEMICAL','type','required',null::text,null::integer,'Technical identity is required.'),
  ('COSMETIC_CHEMICAL','composition','required',null,null,'Composition is required for this technical type.'),
  ('COSMETIC_CHEMICAL','process','conditional','APPLY_CONDITIONAL_DIMENSION',1,'Process applies when the formulation declares a process dependency.'),
  ('DIMENSIONAL_CONSUMABLE','type','required',null,null,'Technical identity is required.'),
  ('DIMENSIONAL_CONSUMABLE','dimensions','required',null,null,'Physical dimensions are required.'),
  ('VARIANT_PRODUCT','type','required',null,null,'Technical identity is required.'),
  ('VARIANT_PRODUCT','identity','required',null,null,'Variant identity must remain distinct from product identity.'),
  ('ELECTRICAL_EQUIPMENT','type','required',null,null,'Technical identity is required.'),
  ('ELECTRICAL_EQUIPMENT','electrical','required',null,null,'Electrical ratings are required.'),
  ('ELECTRICAL_EQUIPMENT','ingredient','not_applicable',null,null,'Ingredient semantics do not apply to this technical type.'),
  ('TOOL','type','required',null,null,'Technical identity is required.'),
  ('TOOL','use','required',null,null,'Intended use is required.'),
  ('SPARE_PART','type','required',null,null,'Technical identity is required.'),
  ('SPARE_PART','compatibility','required',null,null,'Compatibility is strict and required.'),
  ('KIT_BUNDLE','type','required',null,null,'Technical identity is required.'),
  ('KIT_BUNDLE','packaging','required',null,null,'Bundle components are required.'),
  ('MULTIPURPOSE_PRODUCT','type','required',null,null,'Technical identity is required.'),
  ('MULTIPURPOSE_PRODUCT','use','required',null,null,'Multiple uses remain explicit values.'),
  ('CONTRADICTORY_MULTI_SOURCE','type','required',null,null,'Technical identity is required.'),
  ('CONTRADICTORY_MULTI_SOURCE','specification','required',null,null,'Contradictory specifications must remain explicit.'),
  ('INCOMPLETE_DATA_PRODUCT','type','required',null,null,'Technical identity is required.'),
  ('INCOMPLETE_DATA_PRODUCT','specification','optional',null,null,'Missing optional specifications remain absence states.'),
  ('COSMETIC_CHEMICAL','electrical','forbidden',null,null,'Electrical semantics are forbidden for this technical type.')
) policy(technical_type_code, dimension_code, applicability, condition_rule_code, condition_rule_version, rationale)
  on policy.technical_type_code = profile.technical_type_code
on conflict (profile_id, dimension_code) do update
set applicability = excluded.applicability,
    condition_rule_code = excluded.condition_rule_code,
    condition_rule_version = excluded.condition_rule_version,
    rationale = excluded.rationale;

create or replace view public.catalog_technical_type_dimension_contract_v1
with (security_invoker = true) as
with recursive ancestry as (
  select profile.id as requested_profile_id, profile.id as policy_profile_id, 0 as depth
  from public.catalog_technical_type_profiles profile
  where profile.is_active
  union all
  select ancestry.requested_profile_id, parent.id, ancestry.depth + 1
  from ancestry
  join public.catalog_technical_type_profiles child on child.id = ancestry.policy_profile_id
  join public.catalog_technical_type_profiles parent on parent.id = child.parent_profile_id
  where ancestry.depth < 32
), ranked as (
  select ancestry.requested_profile_id, policy.*, ancestry.depth,
         row_number() over (
           partition by ancestry.requested_profile_id, policy.dimension_code
           order by ancestry.depth
         ) as rank
  from ancestry
  join public.catalog_technical_type_dimension_policies policy
    on policy.profile_id = ancestry.policy_profile_id
)
select profile.technical_type_code, profile.template_id, ranked.dimension_code,
       ranked.applicability, ranked.condition_rule_code, ranked.condition_rule_version,
       ranked.rationale, ranked.profile_id as declared_by_profile_id,
       ranked.depth as inheritance_depth
from ranked
join public.catalog_technical_type_profiles profile on profile.id = ranked.requested_profile_id
where ranked.rank = 1;

-- ---------------------------------------------------------------------------
-- Autoridad por fuente, predicado y campo
-- ---------------------------------------------------------------------------

create table public.catalog_source_predicate_authority (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.catalog_sources(id) on delete cascade,
  source_kind text,
  source_role text not null,
  predicate_pattern text not null,
  source_field_pattern text not null default '*',
  dimension_code text references public.catalog_semantic_dimensions(code) on update cascade,
  authority_level text not null,
  authority_score numeric(5,4) not null,
  rationale text not null,
  conditions jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_source_predicate_authority_scope check (num_nonnulls(source_id, source_kind) = 1),
  constraint catalog_source_predicate_authority_kind_allowed check (
    source_kind is null or source_kind in (
      'official', 'authorized_distributor', 'marketplace', 'internal_document', 'physical_packaging'
    )
  ),
  constraint catalog_source_predicate_authority_role_allowed check (source_role in (
    'DISCOVERY', 'IDENTITY', 'MERCHANDISING', 'TECHNICAL',
    'PROCESS', 'COMMERCIAL', 'MEDIA'
  )),
  constraint catalog_source_predicate_authority_predicate_not_blank check (length(trim(predicate_pattern)) > 0),
  constraint catalog_source_predicate_authority_field_not_blank check (length(trim(source_field_pattern)) > 0),
  constraint catalog_source_predicate_authority_level_allowed check (
    authority_level in ('prohibited', 'supplemental', 'acceptable', 'preferred')
  ),
  constraint catalog_source_predicate_authority_score_range check (authority_score >= 0 and authority_score <= 1),
  constraint catalog_source_predicate_authority_rationale_not_blank check (length(trim(rationale)) > 0),
  constraint catalog_source_predicate_authority_conditions_object check (jsonb_typeof(conditions) = 'object'),
  constraint catalog_source_predicate_authority_identity_unique unique nulls not distinct (
    source_id, source_kind, predicate_pattern, source_field_pattern, dimension_code
  )
);

insert into public.catalog_source_predicate_authority(
  source_kind, source_role, predicate_pattern, source_field_pattern,
  dimension_code, authority_level, authority_score, rationale
) values
  ('official','IDENTITY','identity.*','*','identity','preferred',1,'Official sources are preferred for declared identity.'),
  ('official','TECHNICAL','technical.*','*','specification','preferred',1,'Official sources are preferred for declared technical specifications.'),
  ('official','PROCESS','process.*','*','process','preferred',1,'Official process declarations are preferred.'),
  ('official','COMMERCIAL','price.*','*','price','acceptable',0.85,'Official prices are authoritative only as captured commercial observations.'),
  ('official','MEDIA','media.*','*','media','preferred',1,'Official media are preferred for source media.'),
  ('physical_packaging','IDENTITY','identity.*','*','identity','preferred',1,'Physical packaging is preferred for printed identity.'),
  ('physical_packaging','TECHNICAL','technical.*','*','specification','preferred',1,'Physical packaging is preferred for printed specifications.'),
  ('physical_packaging','PROCESS','process.*','*','process','preferred',1,'Physical packaging is preferred for declared process instructions.'),
  ('authorized_distributor','DISCOVERY','*','*',null,'acceptable',0.75,'Authorized distributors are acceptable for discovery and corroboration.'),
  ('marketplace','DISCOVERY','*','*',null,'supplemental',0.4,'Marketplace data is supplemental unless a predicate-specific policy overrides it.'),
  ('marketplace','TECHNICAL','technical.*','*','specification','prohibited',0,'Marketplace technical claims cannot be canonical without a more specific policy.'),
  ('internal_document','TECHNICAL','technical.*','*','specification','acceptable',0.9,'Controlled internal documents may support technical specifications.'),
  ('internal_document','COMMERCIAL','price.*','*','price','preferred',1,'Controlled internal documents are preferred for internal commercial facts.')
on conflict do nothing;

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

-- ---------------------------------------------------------------------------
-- Claims, ejecuciones de reglas y entailment
-- ---------------------------------------------------------------------------

create table public.catalog_semantic_rule_executions (
  id uuid primary key default gen_random_uuid(),
  rule_code text not null,
  rule_version integer not null,
  input_claim_ids uuid[] not null,
  output_subject_ref text not null,
  output_predicate text not null,
  output_dimension_code text not null references public.catalog_semantic_dimensions(code) on update cascade,
  output_value jsonb,
  execution_status text not null default 'succeeded',
  confidence numeric(5,4) not null,
  explanation jsonb not null,
  executed_at timestamptz not null default now(),
  foreign key (rule_code, rule_version)
    references public.catalog_semantic_rules(rule_code, rule_version) on delete restrict,
  constraint catalog_semantic_rule_executions_inputs_present check (cardinality(input_claim_ids) > 0),
  constraint catalog_semantic_rule_executions_subject_not_blank check (length(trim(output_subject_ref)) > 0),
  constraint catalog_semantic_rule_executions_predicate_not_blank check (length(trim(output_predicate)) > 0),
  constraint catalog_semantic_rule_executions_status_allowed check (
    execution_status in ('succeeded', 'rejected', 'superseded')
  ),
  constraint catalog_semantic_rule_executions_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint catalog_semantic_rule_executions_explanation_object check (jsonb_typeof(explanation) = 'object'),
  constraint catalog_semantic_rule_executions_explanation_present check (explanation <> '{}'::jsonb)
);

create table public.catalog_semantic_claims (
  id uuid primary key default gen_random_uuid(),
  claim_key text not null unique,
  subject_ref text not null,
  predicate text not null,
  dimension_code text not null references public.catalog_semantic_dimensions(code) on update cascade,
  value_json jsonb,
  epistemic_class text not null,
  claim_status text not null,
  source_observation_id uuid references public.catalog_observations(id) on delete restrict,
  source_id uuid references public.catalog_sources(id) on delete restrict,
  source_snapshot_id uuid references public.catalog_source_snapshots(id) on delete restrict,
  source_record_id uuid references public.catalog_source_records(id) on delete restrict,
  source_field text,
  source_url text,
  source_excerpt text,
  raw_reference text,
  extraction_method text,
  normalization_method text,
  rule_execution_id uuid references public.catalog_semantic_rule_executions(id) on delete restrict,
  rule_code text,
  rule_version integer,
  confidence numeric(5,4) not null,
  authority_level text,
  evidence_fingerprint text,
  claim_fingerprint text not null,
  supersedes_claim_id uuid references public.catalog_semantic_claims(id) on delete restrict,
  canonical_promotion_id uuid,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (rule_code, rule_version)
    references public.catalog_semantic_rules(rule_code, rule_version) on delete restrict,
  constraint catalog_semantic_claims_key_not_blank check (length(trim(claim_key)) > 0),
  constraint catalog_semantic_claims_subject_not_blank check (length(trim(subject_ref)) > 0),
  constraint catalog_semantic_claims_predicate_not_blank check (length(trim(predicate)) > 0),
  constraint catalog_semantic_claims_epistemic_class_allowed check (epistemic_class in (
    'OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM', 'DERIVED_INFERRED', 'CANONICAL_FACT'
  )),
  constraint catalog_semantic_claims_status_allowed check (claim_status in (
    'ASSERTED', 'UNKNOWN', 'NOT_STATED', 'NOT_APPLICABLE', 'CONTRADICTED',
    'NEEDS_EVIDENCE', 'REJECTED', 'SUPERSEDED'
  )),
  constraint catalog_semantic_claims_absence_value check (
    claim_status not in ('UNKNOWN', 'NOT_STATED', 'NOT_APPLICABLE') or value_json is null
  ),
  constraint catalog_semantic_claims_asserted_value check (
    claim_status not in ('ASSERTED', 'CONTRADICTED') or value_json is not null
  ),
  constraint catalog_semantic_claims_confidence_range check (confidence >= 0 and confidence <= 1),
  constraint catalog_semantic_claims_authority_allowed check (
    authority_level is null or authority_level in ('prohibited', 'supplemental', 'acceptable', 'preferred')
  ),
  constraint catalog_semantic_claims_fingerprint_not_blank check (length(trim(claim_fingerprint)) > 0),
  constraint catalog_semantic_claims_seen_order check (last_seen_at >= first_seen_at),
  constraint catalog_semantic_claims_metadata_object check (jsonb_typeof(metadata) = 'object'),
  constraint catalog_semantic_claims_source_shape check (
    (epistemic_class in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM')
      and source_observation_id is not null and source_id is not null
      and source_snapshot_id is not null and source_record_id is not null
      and source_field is not null and source_url is not null
      and source_excerpt is not null and raw_reference is not null
      and evidence_fingerprint is not null)
    or (epistemic_class not in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM'))
  ),
  constraint catalog_semantic_claims_rule_shape check (
    (epistemic_class = 'OBSERVATION_LITERAL'
      and rule_execution_id is null and rule_code is null and rule_version is null
      and normalization_method is null)
    or (epistemic_class in ('NORMALIZED_SOURCE_CLAIM', 'DERIVED_INFERRED')
      and rule_execution_id is not null and rule_code is not null and rule_version is not null)
    or epistemic_class = 'CANONICAL_FACT'
  ),
  constraint catalog_semantic_claims_not_self_superseding check (
    supersedes_claim_id is null or supersedes_claim_id <> id
  ),
  constraint catalog_semantic_claims_fingerprint_unique unique (claim_fingerprint)
);

create unique index catalog_semantic_claims_one_canonical_fact_idx
  on public.catalog_semantic_claims(subject_ref, predicate)
  where epistemic_class = 'CANONICAL_FACT' and claim_status = 'ASSERTED';
create index catalog_semantic_claims_subject_dimension_idx
  on public.catalog_semantic_claims(subject_ref, dimension_code, predicate, claim_status);
create index catalog_semantic_claims_observation_idx
  on public.catalog_semantic_claims(source_observation_id)
  where source_observation_id is not null;

create table public.catalog_claim_entailments (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null unique references public.catalog_semantic_claims(id) on delete cascade,
  validation_method text not null,
  supported_text text not null,
  result text not null,
  inference_required boolean not null default false,
  explanation text not null,
  validator text not null,
  validated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint catalog_claim_entailments_method_allowed check (
    validation_method in ('exact_excerpt', 'structured_field', 'human_verified')
  ),
  constraint catalog_claim_entailments_supported_not_blank check (length(trim(supported_text)) > 0),
  constraint catalog_claim_entailments_result_allowed check (result in ('passed', 'failed')),
  constraint catalog_claim_entailments_explanation_not_blank check (length(trim(explanation)) > 0),
  constraint catalog_claim_entailments_validator_not_blank check (length(trim(validator)) > 0),
  constraint catalog_claim_entailments_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create or replace function public.validate_catalog_semantic_rule_execution()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  rule public.catalog_semantic_rules%rowtype;
  input_count integer;
  distinct_subject_count integer;
begin
  select * into rule from public.catalog_semantic_rules
  where rule_code = new.rule_code and rule_version = new.rule_version and is_active;
  if not found then
    raise exception using errcode = '23503', message = 'La regla semantica no existe o esta inactiva.';
  end if;

  select count(*), count(distinct subject_ref)
  into input_count, distinct_subject_count
  from public.catalog_semantic_claims where id = any(new.input_claim_ids);

  if input_count <> cardinality(new.input_claim_ids) then
    raise exception using errcode = '23503', message = 'Toda entrada de regla debe referir a un claim persistido.';
  end if;
  if rule.rule_family <> 'RELATION' and (
    distinct_subject_count <> 1
    or not exists (
      select 1 from public.catalog_semantic_claims
      where id = any(new.input_claim_ids) and subject_ref = new.output_subject_ref
    )
  ) then
    raise exception using errcode = '23514', message = 'Una regla no relacional no puede cruzar sujetos.';
  end if;
  if new.output_predicate <> rule.output_predicate
     and rule.output_predicate not like '%*'
     and rule.output_predicate not in ('semantic.normalized', 'semantic.quantity', 'semantic.canonical') then
    raise exception using errcode = '23514', message = 'La salida no coincide con el contrato versionado de la regla.';
  end if;
  if new.output_dimension_code <> rule.output_dimension_code then
    raise exception using errcode = '23514', message = 'La dimension de salida no coincide con la regla versionada.';
  end if;
  return new;
end;
$function$;

create trigger catalog_semantic_rule_executions_validate
before insert or update on public.catalog_semantic_rule_executions
for each row execute function public.validate_catalog_semantic_rule_execution();

create or replace function public.validate_catalog_semantic_claim()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  observation public.catalog_observations%rowtype;
  record public.catalog_source_records%rowtype;
  execution public.catalog_semantic_rule_executions%rowtype;
  rule public.catalog_semantic_rules%rowtype;
begin
  if new.epistemic_class in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM') then
    select * into observation from public.catalog_observations where id = new.source_observation_id;
    select * into record from public.catalog_source_records where id = observation.source_record_id;
    if not found or observation.source_record_id <> new.source_record_id
       or record.source_id <> new.source_id or record.snapshot_id <> new.source_snapshot_id
       or record.source_url <> new.source_url or observation.target_ref <> new.subject_ref then
      raise exception using errcode = '23514', message = 'La procedencia persistida del claim no coincide con su observacion literal.';
    end if;
    if new.claim_status = 'ASSERTED' and not exists (
      select 1 from public.catalog_claim_entailments entailment
      where entailment.claim_id = new.id and entailment.result = 'passed'
        and not entailment.inference_required
    ) then
      raise exception using errcode = '23514', message = 'Un source claim no puede afirmarse sin entailment aprobado por su excerpt.';
    end if;
  end if;

  if new.epistemic_class in ('NORMALIZED_SOURCE_CLAIM', 'DERIVED_INFERRED') then
    select * into execution from public.catalog_semantic_rule_executions where id = new.rule_execution_id;
    select * into rule from public.catalog_semantic_rules
      where rule_code = execution.rule_code and rule_version = execution.rule_version;
    if execution.execution_status <> 'succeeded'
       or execution.rule_code <> new.rule_code or execution.rule_version <> new.rule_version
       or execution.output_subject_ref <> new.subject_ref
       or execution.output_predicate <> new.predicate
       or execution.output_dimension_code <> new.dimension_code
       or execution.output_value is distinct from new.value_json then
      raise exception using errcode = '23514', message = 'El claim no coincide con la ejecucion explicable de su regla.';
    end if;
    if new.epistemic_class = 'NORMALIZED_SOURCE_CLAIM' and rule.rule_family <> 'NORMALIZATION' then
      raise exception using errcode = '23514', message = 'Solo una regla NORMALIZATION puede producir un claim normalizado de fuente.';
    elsif new.epistemic_class = 'DERIVED_INFERRED' and rule.rule_family = 'NORMALIZATION' then
      raise exception using errcode = '23514', message = 'Una inferencia debe declarar una familia de regla distinta de NORMALIZATION.';
    end if;
  end if;

  if new.epistemic_class = 'CANONICAL_FACT' and new.canonical_promotion_id is null then
    raise exception using errcode = '23514', message = 'Un hecho canonico exige una promocion explicita.';
  end if;
  return new;
end;
$function$;

create trigger catalog_semantic_claims_validate
before insert or update on public.catalog_semantic_claims
for each row execute function public.validate_catalog_semantic_claim();

create or replace function public.validate_catalog_claim_entailment()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  claim public.catalog_semantic_claims%rowtype;
begin
  select * into claim from public.catalog_semantic_claims where id = new.claim_id;
  if claim.epistemic_class not in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM') then
    raise exception using errcode = '23514', message = 'Entailment aplica solo a observaciones literales y claims normalizados de fuente.';
  end if;
  if new.inference_required then
    raise exception using errcode = '23514', message = 'Si la conclusion requiere inferencia debe registrarse como DERIVED_INFERRED.';
  end if;
  if new.result = 'passed' and new.validation_method <> 'human_verified'
     and position(lower(new.supported_text) in lower(claim.source_excerpt)) = 0 then
    raise exception using errcode = '23514', message = 'El texto respaldatorio no esta contenido en el excerpt de la fuente.';
  end if;
  return new;
end;
$function$;

create trigger catalog_claim_entailments_validate
before insert or update on public.catalog_claim_entailments
for each row execute function public.validate_catalog_claim_entailment();

create or replace function public.register_catalog_literal_claim_v1(
  p_claim_key text,
  p_observation_id uuid,
  p_dimension_code text,
  p_value_json jsonb,
  p_claim_status text,
  p_source_field text,
  p_source_excerpt text,
  p_raw_reference text,
  p_supported_text text,
  p_validator text default 'literal-entailment-v1'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  observation public.catalog_observations%rowtype;
  source_record public.catalog_source_records%rowtype;
  authority record;
  created_claim_id uuid;
  fingerprint text;
begin
  select * into observation from public.catalog_observations where id = p_observation_id;
  if not found then
    raise exception using errcode = '23503', message = 'La observacion literal no existe.';
  end if;
  select * into source_record from public.catalog_source_records where id = observation.source_record_id;

  select * into authority from public.resolve_catalog_source_authority_v1(
    source_record.source_id, observation.predicate, p_source_field, p_dimension_code
  );
  fingerprint := md5(
    observation.target_ref || '|' || observation.predicate || '|' || p_dimension_code || '|'
    || coalesce(p_value_json::text, p_claim_status) || '|' || p_observation_id::text
  );

  insert into public.catalog_semantic_claims(
    claim_key, subject_ref, predicate, dimension_code, value_json,
    epistemic_class, claim_status, source_observation_id, source_id,
    source_snapshot_id, source_record_id, source_field, source_url,
    source_excerpt, raw_reference, extraction_method, confidence,
    authority_level, evidence_fingerprint, claim_fingerprint, metadata
  ) values (
    trim(p_claim_key), observation.target_ref, observation.predicate, p_dimension_code, p_value_json,
    'OBSERVATION_LITERAL',
    case when p_claim_status = 'ASSERTED' then 'NEEDS_EVIDENCE' else p_claim_status end,
    observation.id, source_record.source_id, source_record.snapshot_id, source_record.id,
    trim(p_source_field), source_record.source_url, p_source_excerpt, p_raw_reference,
    observation.extraction_method, observation.confidence,
    authority.authority_level,
    md5(p_source_excerpt || '|' || p_raw_reference), fingerprint,
    jsonb_build_object(
      'authorityPolicyId', authority.policy_id,
      'authorityRole', authority.source_role,
      'authorityScore', authority.authority_score,
      'literalSourceObservation', true
    )
  ) returning id into created_claim_id;

  if p_claim_status = 'ASSERTED' then
    insert into public.catalog_claim_entailments(
      claim_id, validation_method, supported_text, result,
      inference_required, explanation, validator
    ) values (
      created_claim_id, 'exact_excerpt', p_supported_text, 'passed', false,
      'The supported text is literally present in the persisted source excerpt.', p_validator
    );
    update public.catalog_semantic_claims
    set claim_status = 'ASSERTED', updated_at = now()
    where id = created_claim_id;
  end if;
  return created_claim_id;
end;
$function$;

create or replace function public.execute_catalog_semantic_rule_v1(
  p_rule_code text,
  p_rule_version integer,
  p_input_claim_ids uuid[],
  p_output_subject_ref text,
  p_output_predicate text,
  p_output_dimension_code text,
  p_output_value jsonb,
  p_confidence numeric,
  p_explanation jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare created_execution_id uuid;
begin
  insert into public.catalog_semantic_rule_executions(
    rule_code, rule_version, input_claim_ids, output_subject_ref,
    output_predicate, output_dimension_code, output_value,
    confidence, explanation
  ) values (
    p_rule_code, p_rule_version, p_input_claim_ids, trim(p_output_subject_ref),
    trim(p_output_predicate), p_output_dimension_code, p_output_value,
    p_confidence, p_explanation
  ) returning id into created_execution_id;
  return created_execution_id;
end;
$function$;

create or replace function public.register_catalog_rule_claim_v1(
  p_claim_key text,
  p_execution_id uuid,
  p_epistemic_class text,
  p_claim_status text default 'ASSERTED',
  p_source_field text default null,
  p_source_excerpt text default null,
  p_raw_reference text default null,
  p_supported_text text default null,
  p_validator text default 'rule-claim-v1'
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  execution public.catalog_semantic_rule_executions%rowtype;
  source_claim public.catalog_semantic_claims%rowtype;
  output_authority record;
  created_claim_id uuid;
  derived_authority text;
begin
  if p_epistemic_class not in ('NORMALIZED_SOURCE_CLAIM', 'DERIVED_INFERRED') then
    raise exception using errcode = '22023', message = 'Esta funcion solo registra claims normalizados o derivados.';
  end if;
  select * into execution from public.catalog_semantic_rule_executions where id = p_execution_id;
  if not found then
    raise exception using errcode = '23503', message = 'La ejecucion de regla no existe.';
  end if;

  select * into source_claim
  from public.catalog_semantic_claims
  where id = any(execution.input_claim_ids)
    and epistemic_class in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM')
  order by case authority_level
    when 'prohibited' then 1 when 'supplemental' then 2
    when 'acceptable' then 3 when 'preferred' then 4 else 0 end
  limit 1;

  select case min(case authority_level
    when 'prohibited' then 1 when 'supplemental' then 2
    when 'acceptable' then 3 when 'preferred' then 4 else 0 end)
    when 1 then 'prohibited' when 2 then 'supplemental'
    when 3 then 'acceptable' when 4 then 'preferred' else null end
  into derived_authority
  from public.catalog_semantic_claims where id = any(execution.input_claim_ids);

  if p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' and source_claim.id is null then
    raise exception using errcode = '23514', message = 'Un claim normalizado exige una entrada literal con procedencia.';
  elsif p_epistemic_class = 'DERIVED_INFERRED' and source_claim.id is not null then
    select * into output_authority from public.resolve_catalog_source_authority_v1(
      source_claim.source_id, execution.output_predicate,
      source_claim.source_field, execution.output_dimension_code
    );
    derived_authority := output_authority.authority_level;
  end if;

  insert into public.catalog_semantic_claims(
    claim_key, subject_ref, predicate, dimension_code, value_json,
    epistemic_class, claim_status,
    source_observation_id, source_id, source_snapshot_id, source_record_id,
    source_field, source_url, source_excerpt, raw_reference,
    extraction_method, normalization_method,
    rule_execution_id, rule_code, rule_version, confidence,
    authority_level, evidence_fingerprint, claim_fingerprint, metadata
  ) values (
    trim(p_claim_key), execution.output_subject_ref, execution.output_predicate,
    execution.output_dimension_code, execution.output_value,
    p_epistemic_class,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' and p_claim_status = 'ASSERTED'
      then 'NEEDS_EVIDENCE' else p_claim_status end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.source_observation_id end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.source_id end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.source_snapshot_id end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.source_record_id end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then coalesce(p_source_field, source_claim.source_field) end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.source_url end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then coalesce(p_source_excerpt, source_claim.source_excerpt) end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then coalesce(p_raw_reference, source_claim.raw_reference) end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then source_claim.extraction_method end,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' then execution.rule_code || '@' || execution.rule_version::text end,
    execution.id, execution.rule_code, execution.rule_version, execution.confidence,
    derived_authority,
    case when p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM'
      then source_claim.evidence_fingerprint end,
    md5(execution.output_subject_ref || '|' || execution.output_predicate || '|'
      || execution.output_dimension_code || '|' || coalesce(execution.output_value::text, p_claim_status)
      || '|' || execution.id::text),
    jsonb_build_object('ruleExecutionId', execution.id, 'inputClaimIds', execution.input_claim_ids)
  ) returning id into created_claim_id;

  if p_epistemic_class = 'NORMALIZED_SOURCE_CLAIM' and p_claim_status = 'ASSERTED' then
    insert into public.catalog_claim_entailments(
      claim_id, validation_method, supported_text, result,
      inference_required, explanation, validator
    ) values (
      created_claim_id, 'exact_excerpt', p_supported_text, 'passed', false,
      'Normalization preserves meaning and the supported token occurs in the excerpt.', p_validator
    );
    update public.catalog_semantic_claims set claim_status = 'ASSERTED', updated_at = now()
    where id = created_claim_id;
  end if;
  return created_claim_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Contradicciones, exclusiones y relaciones semanticas explicitas
-- ---------------------------------------------------------------------------

create table public.catalog_semantic_claim_relations (
  id uuid primary key default gen_random_uuid(),
  left_claim_id uuid not null references public.catalog_semantic_claims(id) on delete restrict,
  right_claim_id uuid not null references public.catalog_semantic_claims(id) on delete restrict,
  relation_type text not null,
  rule_code text,
  rule_version integer,
  rationale text not null,
  status text not null default 'active',
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (rule_code, rule_version)
    references public.catalog_semantic_rules(rule_code, rule_version) on delete restrict,
  constraint catalog_semantic_claim_relations_not_self check (left_claim_id <> right_claim_id),
  constraint catalog_semantic_claim_relations_type_allowed check (relation_type in (
    'EXCLUDES', 'CONTRADICTS', 'BROADER_THAN', 'NARROWER_THAN',
    'EQUIVALENT_TO', 'RELATED_TO'
  )),
  constraint catalog_semantic_claim_relations_rule_required check (
    relation_type not in ('EXCLUDES', 'CONTRADICTS')
    or (rule_code is not null and rule_version is not null)
  ),
  constraint catalog_semantic_claim_relations_rationale_not_blank check (length(trim(rationale)) > 0),
  constraint catalog_semantic_claim_relations_status_allowed check (status in ('active', 'rejected', 'superseded')),
  constraint catalog_semantic_claim_relations_evidence_object check (jsonb_typeof(evidence) = 'object'),
  constraint catalog_semantic_claim_relations_unique unique (left_claim_id, right_claim_id, relation_type)
);

create or replace function public.register_catalog_claim_relation_v1(
  p_left_claim_id uuid,
  p_right_claim_id uuid,
  p_relation_type text,
  p_rule_code text,
  p_rule_version integer,
  p_rationale text,
  p_evidence jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  left_claim public.catalog_semantic_claims%rowtype;
  right_claim public.catalog_semantic_claims%rowtype;
  created_relation_id uuid;
  v_rule_family text;
begin
  select * into left_claim from public.catalog_semantic_claims where id = p_left_claim_id;
  select * into right_claim from public.catalog_semantic_claims where id = p_right_claim_id;
  if left_claim.id is null or right_claim.id is null then
    raise exception using errcode = '23503', message = 'Ambos claims de la relacion deben existir.';
  end if;
  if p_relation_type in ('CONTRADICTS', 'EXCLUDES') then
    select rule.rule_family into v_rule_family from public.catalog_semantic_rules rule
    where rule.rule_code = p_rule_code and rule.rule_version = p_rule_version and rule.is_active;
    if (p_relation_type = 'CONTRADICTS' and v_rule_family <> 'CONTRADICTION')
       or (p_relation_type = 'EXCLUDES' and v_rule_family <> 'EXCLUSION') then
      raise exception using errcode = '23514', message = 'La relacion incompatible exige una regla de la familia correspondiente.';
    end if;
    if left_claim.subject_ref <> right_claim.subject_ref
       or left_claim.dimension_code <> right_claim.dimension_code
       or (p_relation_type = 'CONTRADICTS' and left_claim.predicate <> right_claim.predicate) then
      raise exception using errcode = '23514', message = 'Una incompatibilidad debe comparar claims del mismo sujeto y dominio semantico.';
    end if;
    if left_claim.value_json = right_claim.value_json then
      raise exception using errcode = '23514', message = 'Valores identicos no forman una contradiccion o exclusion.';
    end if;
  end if;

  insert into public.catalog_semantic_claim_relations(
    left_claim_id, right_claim_id, relation_type, rule_code,
    rule_version, rationale, evidence
  ) values (
    p_left_claim_id, p_right_claim_id, p_relation_type, p_rule_code,
    p_rule_version, trim(p_rationale), coalesce(p_evidence, '{}'::jsonb)
  ) returning id into created_relation_id;

  if p_relation_type in ('CONTRADICTS', 'EXCLUDES') then
    update public.catalog_semantic_claims
    set claim_status = 'CONTRADICTED', updated_at = now()
    where id in (p_left_claim_id, p_right_claim_id)
      and claim_status = 'ASSERTED';
  end if;
  return created_relation_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Promocion canonica explicita
-- ---------------------------------------------------------------------------

create table public.catalog_canonical_promotions (
  id uuid primary key default gen_random_uuid(),
  candidate_claim_id uuid not null references public.catalog_semantic_claims(id) on delete restrict,
  technical_type_code text not null references public.catalog_technical_type_profiles(technical_type_code) on update cascade,
  promotion_method text not null,
  promotion_rule_code text,
  promotion_rule_version integer,
  review_work_item_id uuid references public.catalog_review_work_items(id) on delete restrict,
  decision_status text not null,
  rationale text not null,
  canonical_claim_id uuid unique references public.catalog_semantic_claims(id) on delete restrict,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (promotion_rule_code, promotion_rule_version)
    references public.catalog_semantic_rules(rule_code, rule_version) on delete restrict,
  constraint catalog_canonical_promotions_method_allowed check (promotion_method in ('RULE', 'HUMAN_GATE')),
  constraint catalog_canonical_promotions_method_consistent check (
    (promotion_method = 'RULE' and promotion_rule_code is not null
      and promotion_rule_version is not null and review_work_item_id is null)
    or (promotion_method = 'HUMAN_GATE' and review_work_item_id is not null)
  ),
  constraint catalog_canonical_promotions_status_allowed check (decision_status in ('approved', 'rejected', 'superseded')),
  constraint catalog_canonical_promotions_rationale_not_blank check (length(trim(rationale)) >= 20),
  constraint catalog_canonical_promotions_metadata_object check (jsonb_typeof(metadata) = 'object')
);

alter table public.catalog_semantic_claims
  add constraint catalog_semantic_claims_canonical_promotion_fk
  foreign key (canonical_promotion_id) references public.catalog_canonical_promotions(id) on delete restrict;

create or replace function public.promote_catalog_canonical_claim_v1(
  p_candidate_claim_id uuid,
  p_technical_type_code text,
  p_promotion_method text,
  p_rationale text,
  p_promotion_rule_code text default null,
  p_promotion_rule_version integer default null,
  p_review_work_item_id uuid default null,
  p_decided_by uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  candidate public.catalog_semantic_claims%rowtype;
  policy record;
  promotion_id uuid;
  v_canonical_claim_id uuid;
  v_rule_family text;
  review_status text;
begin
  select * into candidate from public.catalog_semantic_claims where id = p_candidate_claim_id for update;
  if not found or candidate.claim_status <> 'ASSERTED'
     or candidate.epistemic_class = 'CANONICAL_FACT' then
    raise exception using errcode = '23514', message = 'Solo un claim no canonico y afirmado puede promoverse.';
  end if;
  if candidate.authority_level not in ('acceptable', 'preferred') then
    raise exception using errcode = '23514', message = 'La autoridad fuente por predicado no permite promocion canonica.';
  end if;
  if exists (
    select 1 from public.catalog_semantic_claim_relations relation
    where relation.status = 'active' and relation.relation_type in ('CONTRADICTS', 'EXCLUDES')
      and candidate.id in (relation.left_claim_id, relation.right_claim_id)
  ) then
    raise exception using errcode = '23514', message = 'Un claim contradicho conserva evidencia pero no puede promoverse silenciosamente.';
  end if;
  select * into policy from public.catalog_technical_type_dimension_contract_v1
  where technical_type_code = p_technical_type_code and dimension_code = candidate.dimension_code;
  if not found or policy.applicability in ('not_applicable', 'forbidden') then
    raise exception using errcode = '23514', message = 'El perfil tecnico no permite este predicado canonico.';
  end if;

  if p_promotion_method = 'RULE' then
    select rule.rule_family into v_rule_family from public.catalog_semantic_rules rule
    where rule.rule_code = p_promotion_rule_code
      and rule.rule_version = p_promotion_rule_version and rule.is_active;
    if v_rule_family <> 'AUTHORITY' then
      raise exception using errcode = '23514', message = 'La promocion automatica exige una regla AUTHORITY activa.';
    end if;
  elsif p_promotion_method = 'HUMAN_GATE' then
    select status into review_status from public.catalog_review_work_items where id = p_review_work_item_id;
    if review_status <> 'resolved' then
      raise exception using errcode = '23514', message = 'La promocion humana exige una decision de Mesa resuelta.';
    end if;
  else
    raise exception using errcode = '22023', message = 'Metodo de promocion canonica invalido.';
  end if;

  insert into public.catalog_canonical_promotions(
    candidate_claim_id, technical_type_code, promotion_method,
    promotion_rule_code, promotion_rule_version, review_work_item_id,
    decision_status, rationale, decided_by,
    metadata
  ) values (
    candidate.id, p_technical_type_code, p_promotion_method,
    p_promotion_rule_code, p_promotion_rule_version, p_review_work_item_id,
    'approved', trim(p_rationale), p_decided_by,
    jsonb_build_object('candidateClaimFingerprint', candidate.claim_fingerprint)
  ) returning id into promotion_id;

  insert into public.catalog_semantic_claims(
    claim_key, subject_ref, predicate, dimension_code, value_json,
    epistemic_class, claim_status, rule_code, rule_version,
    confidence, authority_level, claim_fingerprint,
    canonical_promotion_id, metadata
  ) values (
    'canonical:' || promotion_id::text, candidate.subject_ref, candidate.predicate,
    candidate.dimension_code, candidate.value_json,
    'CANONICAL_FACT', 'ASSERTED', p_promotion_rule_code, p_promotion_rule_version,
    candidate.confidence, candidate.authority_level,
    md5(candidate.subject_ref || '|' || candidate.predicate || '|canonical|'
      || candidate.value_json::text || '|' || promotion_id::text),
    promotion_id,
    jsonb_build_object('candidateClaimId', candidate.id, 'promotionMethod', p_promotion_method)
  ) returning id into v_canonical_claim_id;

  update public.catalog_canonical_promotions
  set canonical_claim_id = v_canonical_claim_id
  where id = promotion_id;
  return v_canonical_claim_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- Certificacion universal y golden regression set
-- ---------------------------------------------------------------------------

create table public.catalog_semantic_archetypes (
  archetype_code text primary key,
  label text not null,
  technical_type_code text not null references public.catalog_technical_type_profiles(technical_type_code) on update cascade,
  required_capabilities text[] not null,
  fixture_contract jsonb not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_archetypes_code_format check (archetype_code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_semantic_archetypes_label_not_blank check (length(trim(label)) > 0),
  constraint catalog_semantic_archetypes_capabilities_present check (cardinality(required_capabilities) > 0),
  constraint catalog_semantic_archetypes_fixture_object check (jsonb_typeof(fixture_contract) = 'object'),
  constraint catalog_semantic_archetypes_universal check (
    fixture_contract::text !~* '"(brand|brand_id|brandId|sku|product_id|productId|reference_product_id|referenceProductId)"[[:space:]]*:'
  )
);

insert into public.catalog_semantic_archetypes(
  archetype_code, label, technical_type_code, required_capabilities, fixture_contract
) values
  ('COSMETIC_CHEMICAL','Cosmetic or chemical','COSMETIC_CHEMICAL',
   array['literal_evidence','composition','conditional_applicability'],
   '{"synthetic":true,"requiredDimensions":["type","composition"]}'),
  ('DIMENSIONAL_CONSUMABLE','Dimensional consumable','DIMENSIONAL_CONSUMABLE',
   array['literal_evidence','unit_normalization','dimension_safety'],
   '{"synthetic":true,"requiredDimensions":["type","dimensions"]}'),
  ('VARIANT_PRODUCT','Product with variants','VARIANT_PRODUCT',
   array['product_scope','variant_scope','identity'],
   '{"synthetic":true,"requiredDimensions":["type","identity"]}'),
  ('ELECTRICAL_EQUIPMENT','Electrical equipment','ELECTRICAL_EQUIPMENT',
   array['literal_evidence','electrical_specification','source_authority'],
   '{"synthetic":true,"requiredDimensions":["type","electrical"]}'),
  ('TOOL','Tool','TOOL',
   array['literal_evidence','use','strict_compatibility'],
   '{"synthetic":true,"requiredDimensions":["type","use"]}'),
  ('SPARE_PART','Spare part','SPARE_PART',
   array['identity','strict_compatibility','exclusion'],
   '{"synthetic":true,"requiredDimensions":["type","compatibility"]}'),
  ('KIT_BUNDLE','Kit or bundle','KIT_BUNDLE',
   array['bundle_components','relation','cardinality'],
   '{"synthetic":true,"requiredDimensions":["type","packaging"]}'),
  ('MULTIPURPOSE_PRODUCT','Multipurpose product','MULTIPURPOSE_PRODUCT',
   array['multivalue','use','no_false_contradiction'],
   '{"synthetic":true,"requiredDimensions":["type","use"]}'),
  ('CONTRADICTORY_MULTI_SOURCE','Contradictory multi-source','CONTRADICTORY_MULTI_SOURCE',
   array['two_evidence_chains','explicit_contradiction','canonical_block'],
   '{"synthetic":true,"requiredDimensions":["type","specification"]}'),
  ('INCOMPLETE_DATA_PRODUCT','Incomplete data','INCOMPLETE_DATA_PRODUCT',
   array['unknown','not_stated','not_applicable','no_human_exception'],
   '{"synthetic":true,"requiredDimensions":["type"]}')
on conflict (archetype_code) do update
set label = excluded.label,
    technical_type_code = excluded.technical_type_code,
    required_capabilities = excluded.required_capabilities,
    fixture_contract = excluded.fixture_contract;

create table public.catalog_semantic_golden_invariants (
  invariant_code text primary key,
  invariant_family text not null,
  description text not null,
  assertion_kind text not null,
  invariant_definition jsonb not null,
  is_active boolean not null default true,
  discovered_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_golden_invariants_code_format check (invariant_code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_semantic_golden_invariants_family_allowed check (invariant_family in (
    'EPISTEMIC', 'DIMENSION', 'PROFILE', 'RULE', 'AUTHORITY',
    'CONTRADICTION', 'ENTAILMENT', 'ABSENCE', 'PROMOTION', 'HUMAN_SCALE'
  )),
  constraint catalog_semantic_golden_invariants_description_not_blank check (length(trim(description)) > 0),
  constraint catalog_semantic_golden_invariants_assertion_allowed check (
    assertion_kind in ('schema_constraint', 'data_invariant', 'gate_scenario', 'projection_invariant')
  ),
  constraint catalog_semantic_golden_invariants_definition_object check (jsonb_typeof(invariant_definition) = 'object'),
  constraint catalog_semantic_golden_invariants_universal check (
    invariant_definition::text !~* '"(brand|brand_id|brandId|sku|product|product_id|productId|reference_product_id|referenceProductId|name)"[[:space:]]*:'
  )
);

insert into public.catalog_semantic_golden_invariants(
  invariant_code, invariant_family, description, assertion_kind, invariant_definition
) values
  ('SOURCE_NEVER_IMPERSONATES_INFERENCE','EPISTEMIC',
   'A source claim never carries a derivation that changes its asserted meaning.',
   'schema_constraint','{"classes":["OBSERVATION_LITERAL","NORMALIZED_SOURCE_CLAIM","DERIVED_INFERRED"]}'),
  ('DIMENSIONS_GROW_BY_DATA','DIMENSION',
   'A dimension is registered as data and does not require a schema constraint change.',
   'gate_scenario','{"operation":"insert_dimension_and_policy"}'),
  ('TECHNICAL_TYPE_DECLARATION_IS_DATA','PROFILE',
   'Every active technical type resolves dimension applicability from profile data.',
   'data_invariant','{"statuses":["required","optional","conditional","not_applicable","forbidden"]}'),
  ('RULE_SCOPE_IS_UNIVERSAL','RULE',
   'Semantic rules cannot be scoped by a brand, SKU or individual product.',
   'schema_constraint','{"scopeKeys":["technicalType","ancestorTechnicalType","dimension","sourceKind","sourceField","predicate"]}'),
  ('AUTHORITY_IS_PREDICATE_SCOPED','AUTHORITY',
   'A source authority decision includes predicate and source field.',
   'data_invariant','{"matrix":["source","predicate","sourceField"]}'),
  ('INCOMPATIBLE_VALUES_REMAIN_VISIBLE','CONTRADICTION',
   'Contradictory values retain both claims and an explicit relation.',
   'gate_scenario','{"relationTypes":["CONTRADICTS","EXCLUDES"]}'),
  ('EXCERPT_ENTAILS_SOURCE_CLAIM','ENTAILMENT',
   'An asserted source claim has a passing non-inferential entailment record.',
   'data_invariant','{"requiredResult":"passed","inferenceRequired":false}'),
  ('ABSENCE_IS_NOT_FALSE_OR_HUMAN_WORK','ABSENCE',
   'UNKNOWN, NOT_STATED and NOT_APPLICABLE carry no value and create no Mesa work by themselves.',
   'gate_scenario','{"states":["UNKNOWN","NOT_STATED","NOT_APPLICABLE"]}'),
  ('CANONICAL_FACT_REQUIRES_PROMOTION','PROMOTION',
   'A canonical fact always points to an approved rule or human promotion gate.',
   'schema_constraint','{"methods":["RULE","HUMAN_GATE"]}'),
  ('SHARED_FAILURE_AGGREGATES_BEFORE_MESA','HUMAN_SCALE',
   'Repeated failures share one problem group before any human exception.',
   'projection_invariant','{"aggregation":["rule_code","technical_type","dimension","root_cause"]}')
on conflict (invariant_code) do update
set description = excluded.description,
    invariant_family = excluded.invariant_family,
    assertion_kind = excluded.assertion_kind,
    invariant_definition = excluded.invariant_definition;

create table public.catalog_semantic_certification_runs (
  id uuid primary key default gen_random_uuid(),
  run_key text not null unique,
  status text not null default 'running',
  contract_version text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  result_fingerprint text,
  created_at timestamptz not null default now(),
  constraint catalog_semantic_certification_runs_key_not_blank check (length(trim(run_key)) > 0),
  constraint catalog_semantic_certification_runs_status_allowed check (status in ('running', 'passed', 'failed')),
  constraint catalog_semantic_certification_runs_completion check (
    (status = 'running' and finished_at is null)
    or (status in ('passed', 'failed') and finished_at is not null)
  ),
  constraint catalog_semantic_certification_runs_metrics_object check (jsonb_typeof(metrics) = 'object')
);

create table public.catalog_semantic_certification_results (
  run_id uuid not null references public.catalog_semantic_certification_runs(id) on delete cascade,
  archetype_code text not null references public.catalog_semantic_archetypes(archetype_code) on update cascade,
  capability_code text not null,
  status text not null,
  evidence jsonb not null,
  created_at timestamptz not null default now(),
  primary key (run_id, archetype_code, capability_code),
  constraint catalog_semantic_certification_results_capability_not_blank check (length(trim(capability_code)) > 0),
  constraint catalog_semantic_certification_results_status_allowed check (status in ('passed', 'failed')),
  constraint catalog_semantic_certification_results_evidence_object check (jsonb_typeof(evidence) = 'object')
);

-- Violations are deliberately queryable: certification fails closed instead of
-- relying on a prose checklist.
create or replace view public.catalog_semantic_contract_violations_v1
with (security_invoker = true) as
select 'ASSERTED_SOURCE_WITHOUT_ENTAILMENT'::text as violation_code,
       claim.id::text as entity_ref,
       jsonb_build_object('epistemicClass', claim.epistemic_class, 'claimKey', claim.claim_key) as details
from public.catalog_semantic_claims claim
where claim.epistemic_class in ('OBSERVATION_LITERAL', 'NORMALIZED_SOURCE_CLAIM')
  and claim.claim_status = 'ASSERTED'
  and not exists (
    select 1 from public.catalog_claim_entailments entailment
    where entailment.claim_id = claim.id and entailment.result = 'passed'
      and not entailment.inference_required
  )
union all
select 'ACTIVE_PROFILE_WITHOUT_DIMENSION_POLICY', profile.id::text,
       jsonb_build_object('technicalTypeCode', profile.technical_type_code, 'dimension', dimension.code)
from public.catalog_technical_type_profiles profile
cross join public.catalog_semantic_dimensions dimension
where profile.is_active and dimension.is_active
  and not exists (
    select 1 from public.catalog_technical_type_dimension_contract_v1 contract
    where contract.technical_type_code = profile.technical_type_code
      and contract.dimension_code = dimension.code
  )
union all
select 'CANONICAL_WITHOUT_APPROVED_PROMOTION', claim.id::text,
       jsonb_build_object('claimKey', claim.claim_key)
from public.catalog_semantic_claims claim
where claim.epistemic_class = 'CANONICAL_FACT'
  and not exists (
    select 1 from public.catalog_canonical_promotions promotion
    where promotion.id = claim.canonical_promotion_id
      and promotion.canonical_claim_id = claim.id
      and promotion.decision_status = 'approved'
  );

create or replace view public.catalog_semantic_claim_explanations_v1
with (security_invoker = true) as
select claim.id, claim.claim_key, claim.subject_ref, claim.predicate,
       claim.dimension_code, claim.value_json, claim.epistemic_class,
       claim.claim_status, claim.confidence, claim.authority_level,
       claim.source_id, claim.source_snapshot_id, claim.source_record_id,
       claim.source_field, claim.source_url, claim.source_excerpt,
       claim.raw_reference, claim.extraction_method, claim.normalization_method,
       claim.rule_code, claim.rule_version, claim.rule_execution_id,
       execution.input_claim_ids,
       entailment.result as entailment_result,
       entailment.inference_required,
       claim.canonical_promotion_id,
       promotion.promotion_method,
       promotion.technical_type_code,
       claim.claim_fingerprint, claim.evidence_fingerprint,
       claim.first_seen_at, claim.last_seen_at, claim.metadata
from public.catalog_semantic_claims claim
left join public.catalog_semantic_rule_executions execution on execution.id = claim.rule_execution_id
left join public.catalog_claim_entailments entailment on entailment.claim_id = claim.id
left join public.catalog_canonical_promotions promotion on promotion.id = claim.canonical_promotion_id;

create or replace view public.catalog_semantic_certification_summary_v1
with (security_invoker = true) as
select run.id, run.run_key, run.status, run.contract_version,
       count(result.*)::bigint as checks,
       count(*) filter (where result.status = 'passed')::bigint as passed,
       count(*) filter (where result.status = 'failed')::bigint as failed,
       count(distinct result.archetype_code)::bigint as archetypes_covered,
       run.started_at, run.finished_at, run.metrics, run.result_fingerprint
from public.catalog_semantic_certification_runs run
left join public.catalog_semantic_certification_results result on result.run_id = run.id
group by run.id;

create or replace function public.get_catalog_semantic_checkpoint_report_v1()
returns jsonb
language sql
stable
set search_path = ''
as $function$
  select jsonb_build_object(
    'contractVersion', 'universal-semantic-v1',
    'stage4Authorized', false,
    'registries', jsonb_build_object(
      'dimensions', (select count(*) from public.catalog_semantic_dimensions where is_active),
      'technicalTypes', (select count(*) from public.catalog_technical_type_profiles where is_active),
      'dimensionPolicies', (select count(*) from public.catalog_technical_type_dimension_contract_v1),
      'rules', (select count(*) from public.catalog_semantic_rules where is_active),
      'authorityPolicies', (select count(*) from public.catalog_source_predicate_authority where is_active),
      'goldenInvariants', (select count(*) from public.catalog_semantic_golden_invariants where is_active),
      'archetypes', (select count(*) from public.catalog_semantic_archetypes where is_active)
    ),
    'claims', jsonb_build_object(
      'literalObservations', (select count(*) from public.catalog_semantic_claims where epistemic_class = 'OBSERVATION_LITERAL'),
      'normalizedSourceClaims', (select count(*) from public.catalog_semantic_claims where epistemic_class = 'NORMALIZED_SOURCE_CLAIM'),
      'derivedInferred', (select count(*) from public.catalog_semantic_claims where epistemic_class = 'DERIVED_INFERRED'),
      'canonicalFacts', (select count(*) from public.catalog_semantic_claims where epistemic_class = 'CANONICAL_FACT'),
      'contradictions', (select count(*) from public.catalog_semantic_claim_relations where relation_type = 'CONTRADICTS' and status = 'active'),
      'exclusions', (select count(*) from public.catalog_semantic_claim_relations where relation_type = 'EXCLUDES' and status = 'active')
    ),
    'contractViolations', (select count(*) from public.catalog_semantic_contract_violations_v1),
    'latestCertification', (
      select to_jsonb(summary) from public.catalog_semantic_certification_summary_v1 summary
      order by summary.started_at desc limit 1
    )
  );
$function$;

-- Coverage now follows the registry; adding a dimension is a data operation.
create or replace view public.catalog_reference_semantic_coverage_v1
with (security_invoker = true) as
with reference_products as (
  select id as reference_product_id from public.catalog_reference_products
), covered as (
  select dimension, count(distinct reference_product_id)::bigint as covered_products
  from public.catalog_reference_product_semantics_v1
  where normalization_status in ('observed', 'reviewed')
  group by dimension
)
select dimension.code as dimension,
       coalesce(covered.covered_products, 0) as covered_products,
       (select count(*) from reference_products)::bigint as total_products,
       round(100 * coalesce(covered.covered_products, 0)::numeric
         / nullif((select count(*) from reference_products), 0), 2) as coverage_percent
from public.catalog_semantic_dimensions dimension
left join covered on covered.dimension = dimension.code
where dimension.is_active;

-- ---------------------------------------------------------------------------
-- Proyeccion explicable. PostgreSQL sigue siendo la autoridad unica.
-- ---------------------------------------------------------------------------

create or replace view public.graph_universal_semantic_nodes_v1
with (security_invoker = true) as
select 'semantic_dimension:' || dimension.code as node_key,
       'SemanticDimension'::text as node_type, null::uuid as entity_id,
       dimension.label, 'knowledge'::text as layer,
       jsonb_build_object('code', dimension.code, 'valueKind', dimension.value_kind,
         'extensible', true) as properties
from public.catalog_semantic_dimensions dimension where dimension.is_active
union all
select 'semantic_rule:' || rule.id::text, 'SemanticRule', rule.id,
       rule.rule_code || '@' || rule.rule_version::text, 'knowledge',
       jsonb_build_object('ruleCode', rule.rule_code, 'ruleVersion', rule.rule_version,
         'family', rule.rule_family, 'scope', rule.scope, 'confidence', rule.confidence)
from public.catalog_semantic_rules rule where rule.is_active
union all
select 'technical_type:' || profile.id::text, 'TechnicalType', profile.id,
       profile.label, 'knowledge',
       jsonb_build_object('technicalTypeCode', profile.technical_type_code,
         'templateId', profile.template_id, 'abstract', profile.is_abstract)
from public.catalog_technical_type_profiles profile where profile.is_active
union all
select 'semantic_claim:' || claim.id::text, 'SemanticClaim', claim.id,
       claim.predicate, case when claim.epistemic_class = 'CANONICAL_FACT' then 'canonical' else 'evidence' end,
       jsonb_build_object('claimKey', claim.claim_key, 'subjectRef', claim.subject_ref,
         'dimension', claim.dimension_code, 'epistemicClass', claim.epistemic_class,
         'status', claim.claim_status, 'value', claim.value_json,
         'confidence', claim.confidence, 'authorityLevel', claim.authority_level,
         'claimFingerprint', claim.claim_fingerprint)
from public.catalog_semantic_claims claim;

create or replace view public.graph_universal_semantic_edges_v1
with (security_invoker = true) as
select 'technical-type-parent:' || profile.id::text as edge_key,
       'technical_type:' || profile.id::text as source_key,
       'IS_A'::text as predicate,
       'technical_type:' || profile.parent_profile_id::text as target_key,
       'knowledge'::text as layer,
       '{}'::jsonb as properties
from public.catalog_technical_type_profiles profile where profile.parent_profile_id is not null
union all
select 'technical-type-dimension:' || profile.id::text || ':' || contract.dimension_code,
       'technical_type:' || profile.id::text, 'DECLARES_DIMENSION',
       'semantic_dimension:' || contract.dimension_code, 'knowledge',
       jsonb_build_object('applicability', contract.applicability,
         'conditionRuleCode', contract.condition_rule_code,
         'conditionRuleVersion', contract.condition_rule_version,
         'inheritanceDepth', contract.inheritance_depth)
from public.catalog_technical_type_dimension_contract_v1 contract
join public.catalog_technical_type_profiles profile
  on profile.technical_type_code = contract.technical_type_code
union all
select 'semantic-rule-output:' || rule.id::text,
       'semantic_rule:' || rule.id::text, 'OUTPUTS_DIMENSION',
       'semantic_dimension:' || rule.output_dimension_code, 'knowledge', '{}'::jsonb
from public.catalog_semantic_rules rule where rule.is_active
union all
select 'observation-literal-claim:' || claim.id::text,
       'observation:' || claim.source_observation_id::text, 'ASSERTS_LITERAL',
       'semantic_claim:' || claim.id::text, 'evidence',
       jsonb_build_object('entailment', entailment.result,
         'inferenceRequired', entailment.inference_required,
         'evidenceFingerprint', claim.evidence_fingerprint)
from public.catalog_semantic_claims claim
left join public.catalog_claim_entailments entailment on entailment.claim_id = claim.id
where claim.epistemic_class = 'OBSERVATION_LITERAL'
union all
select 'semantic-rule-claim:' || claim.id::text,
       'semantic_rule:' || rule.id::text, 'PRODUCED',
       'semantic_claim:' || claim.id::text, 'evidence',
       jsonb_build_object('executionId', claim.rule_execution_id,
         'epistemicClass', claim.epistemic_class)
from public.catalog_semantic_claims claim
join public.catalog_semantic_rules rule
  on rule.rule_code = claim.rule_code and rule.rule_version = claim.rule_version
where claim.rule_execution_id is not null
union all
select 'semantic-derivation:' || output_claim.id::text || ':' || input_claim.id::text,
       'semantic_claim:' || input_claim.id::text, 'DERIVES_TO',
       'semantic_claim:' || output_claim.id::text, 'evidence',
       jsonb_build_object('executionId', execution.id,
         'ruleCode', execution.rule_code, 'ruleVersion', execution.rule_version)
from public.catalog_semantic_claims output_claim
join public.catalog_semantic_rule_executions execution on execution.id = output_claim.rule_execution_id
join public.catalog_semantic_claims input_claim on input_claim.id = any(execution.input_claim_ids)
union all
select 'semantic-claim-relation:' || relation.id::text,
       'semantic_claim:' || relation.left_claim_id::text, relation.relation_type,
       'semantic_claim:' || relation.right_claim_id::text, 'evidence',
       jsonb_build_object('ruleCode', relation.rule_code, 'ruleVersion', relation.rule_version,
         'rationale', relation.rationale, 'status', relation.status)
from public.catalog_semantic_claim_relations relation
union all
select 'semantic-promotion:' || promotion.id::text,
       'semantic_claim:' || promotion.candidate_claim_id::text, 'PROMOTED_TO',
       'semantic_claim:' || promotion.canonical_claim_id::text, 'canonical',
       jsonb_build_object('method', promotion.promotion_method,
         'technicalTypeCode', promotion.technical_type_code,
         'decisionStatus', promotion.decision_status)
from public.catalog_canonical_promotions promotion
where promotion.canonical_claim_id is not null;

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
) edge;

-- ---------------------------------------------------------------------------
-- Seguridad, privilegios y documentacion de contrato
-- ---------------------------------------------------------------------------

alter table public.catalog_semantic_dimensions enable row level security;
alter table public.catalog_semantic_rules enable row level security;
alter table public.catalog_technical_type_profiles enable row level security;
alter table public.catalog_technical_type_dimension_policies enable row level security;
alter table public.catalog_source_predicate_authority enable row level security;
alter table public.catalog_semantic_rule_executions enable row level security;
alter table public.catalog_semantic_claims enable row level security;
alter table public.catalog_claim_entailments enable row level security;
alter table public.catalog_semantic_claim_relations enable row level security;
alter table public.catalog_canonical_promotions enable row level security;
alter table public.catalog_semantic_archetypes enable row level security;
alter table public.catalog_semantic_golden_invariants enable row level security;
alter table public.catalog_semantic_certification_runs enable row level security;
alter table public.catalog_semantic_certification_results enable row level security;

create policy "admins read semantic dimensions" on public.catalog_semantic_dimensions
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic rules" on public.catalog_semantic_rules
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read technical type profiles" on public.catalog_technical_type_profiles
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read technical dimension policies" on public.catalog_technical_type_dimension_policies
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read source predicate authority" on public.catalog_source_predicate_authority
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic rule executions" on public.catalog_semantic_rule_executions
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic claims" on public.catalog_semantic_claims
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read claim entailments" on public.catalog_claim_entailments
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic claim relations" on public.catalog_semantic_claim_relations
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read canonical promotions" on public.catalog_canonical_promotions
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic archetypes" on public.catalog_semantic_archetypes
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic golden invariants" on public.catalog_semantic_golden_invariants
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic certification runs" on public.catalog_semantic_certification_runs
for select to authenticated using (public.is_admin(auth.uid()));
create policy "admins read semantic certification results" on public.catalog_semantic_certification_results
for select to authenticated using (public.is_admin(auth.uid()));

grant select on public.catalog_semantic_dimensions, public.catalog_semantic_rules,
  public.catalog_technical_type_profiles, public.catalog_technical_type_dimension_policies,
  public.catalog_source_predicate_authority, public.catalog_semantic_rule_executions,
  public.catalog_semantic_claims, public.catalog_claim_entailments,
  public.catalog_semantic_claim_relations, public.catalog_canonical_promotions,
  public.catalog_semantic_archetypes, public.catalog_semantic_golden_invariants,
  public.catalog_semantic_certification_runs, public.catalog_semantic_certification_results,
  public.catalog_technical_type_dimension_contract_v1,
  public.catalog_semantic_contract_violations_v1,
  public.catalog_semantic_claim_explanations_v1,
  public.catalog_semantic_certification_summary_v1,
  public.graph_universal_semantic_nodes_v1,
  public.graph_universal_semantic_edges_v1
to authenticated, service_role;

grant insert, update on public.catalog_semantic_dimensions, public.catalog_semantic_rules,
  public.catalog_technical_type_profiles, public.catalog_technical_type_dimension_policies,
  public.catalog_source_predicate_authority, public.catalog_semantic_rule_executions,
  public.catalog_semantic_claims, public.catalog_claim_entailments,
  public.catalog_semantic_claim_relations, public.catalog_canonical_promotions,
  public.catalog_semantic_archetypes, public.catalog_semantic_golden_invariants,
  public.catalog_semantic_certification_runs, public.catalog_semantic_certification_results
to service_role;

revoke all on function public.validate_catalog_semantic_rule_execution() from public, anon, authenticated;
revoke all on function public.sync_catalog_technical_type_profile_from_template() from public, anon, authenticated;
revoke all on function public.sync_all_catalog_technical_type_profiles_v1() from public, anon, authenticated;
grant execute on function public.sync_all_catalog_technical_type_profiles_v1() to service_role;
revoke all on function public.validate_catalog_semantic_claim() from public, anon, authenticated;
revoke all on function public.validate_catalog_claim_entailment() from public, anon, authenticated;
revoke execute on function public.resolve_catalog_source_authority_v1(uuid,text,text,text) from public, anon;
grant execute on function public.resolve_catalog_source_authority_v1(uuid,text,text,text) to authenticated, service_role;
revoke execute on function public.register_catalog_literal_claim_v1(text,uuid,text,jsonb,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.register_catalog_literal_claim_v1(text,uuid,text,jsonb,text,text,text,text,text,text)
  to service_role;
revoke execute on function public.execute_catalog_semantic_rule_v1(text,integer,uuid[],text,text,text,jsonb,numeric,jsonb)
  from public, anon, authenticated;
grant execute on function public.execute_catalog_semantic_rule_v1(text,integer,uuid[],text,text,text,jsonb,numeric,jsonb)
  to service_role;
revoke execute on function public.register_catalog_rule_claim_v1(text,uuid,text,text,text,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.register_catalog_rule_claim_v1(text,uuid,text,text,text,text,text,text,text)
  to service_role;
revoke execute on function public.register_catalog_claim_relation_v1(uuid,uuid,text,text,integer,text,jsonb)
  from public, anon, authenticated;
grant execute on function public.register_catalog_claim_relation_v1(uuid,uuid,text,text,integer,text,jsonb)
  to service_role;
revoke execute on function public.promote_catalog_canonical_claim_v1(uuid,text,text,text,text,integer,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.promote_catalog_canonical_claim_v1(uuid,text,text,text,text,integer,uuid,uuid)
  to service_role;
revoke execute on function public.get_catalog_semantic_checkpoint_report_v1() from public, anon;
grant execute on function public.get_catalog_semantic_checkpoint_report_v1() to authenticated, service_role;

comment on table public.catalog_semantic_claims is
  'Epistemic chain: literal observation, normalized source claim, derived/inferred claim, or explicitly promoted canonical fact.';
comment on table public.catalog_semantic_dimensions is
  'Extensible semantic-dimension registry. New dimensions are rows, not schema migrations.';
comment on table public.catalog_semantic_rules is
  'Universal versioned rules. Brand, SKU and product scopes are structurally forbidden.';
comment on table public.catalog_source_predicate_authority is
  'Authority matrix by source or source kind, predicate, field and dimension; source authority is never global.';
comment on table public.catalog_semantic_claim_relations is
  'Explicit exclusions, contradictions and semantic relations preserving both evidence chains.';
comment on table public.catalog_canonical_promotions is
  'Only explicit rule or resolved-human gates may promote an asserted claim to a canonical fact.';
comment on view public.catalog_semantic_contract_violations_v1 is
  'Fail-closed read model consumed by semantic certification.';

commit;
