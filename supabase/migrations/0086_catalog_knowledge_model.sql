-- ---------------------------------------------------------------------------
-- 0086 · Ontología canónica del catálogo
-- ---------------------------------------------------------------------------
-- PostgreSQL sigue siendo la única fuente de verdad. Sistemas, etapas, clases
-- y relaciones son tablas de dominio tipadas; la representación de grafo se
-- construye después como una proyección descartable.

begin;

create or replace function public.validate_catalog_assertion_evidence()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  status_value text := to_jsonb(new) ->> tg_argv[0];
  evidence_value uuid := nullif(to_jsonb(new) ->> tg_argv[1], '')::uuid;
begin
  if status_value = 'approved'
     and not public.catalog_assert_approved_evidence(evidence_value) then
    raise exception using
      errcode = '23514',
      message = 'Una afirmación aprobada necesita un conjunto de evidencia aprobado.';
  end if;
  return new;
end;
$function$;

create table public.catalog_systems (
  id uuid primary key default gen_random_uuid(),
  domain text not null,
  code text not null unique,
  name text not null,
  description text,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_systems_domain_code check (domain ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_systems_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_systems_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_systems_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_stages (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null references public.catalog_systems(id) on delete cascade,
  code text not null,
  name text not null,
  position integer not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (system_id, code),
  unique (system_id, position),
  unique (id, system_id),
  constraint catalog_stages_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_stages_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_stages_position_non_negative check (position >= 0),
  constraint catalog_stages_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  role_kind text not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_roles_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_roles_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_roles_kind_allowed check (role_kind in (
    'component', 'preparation', 'adhesion', 'tool', 'consumable', 'equipment', 'finishing', 'care'
  )),
  constraint catalog_roles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_system_stage_roles (
  id uuid primary key default gen_random_uuid(),
  system_id uuid not null,
  stage_id uuid not null,
  role_id uuid not null references public.catalog_roles(id) on delete restrict,
  necessity text not null default 'optional',
  minimum_selections integer not null default 0,
  maximum_selections integer,
  decision_status text not null default 'proposed',
  evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stage_id, system_id) references public.catalog_stages(id, system_id) on delete cascade,
  unique (system_id, stage_id, role_id),
  constraint catalog_system_stage_roles_necessity_allowed check (necessity in ('required', 'recommended', 'optional')),
  constraint catalog_system_stage_roles_status_allowed check (decision_status in ('proposed', 'needs_evidence', 'approved', 'rejected', 'superseded')),
  constraint catalog_system_stage_roles_minimum_non_negative check (minimum_selections >= 0),
  constraint catalog_system_stage_roles_maximum_valid check (
    maximum_selections is null or maximum_selections >= minimum_selections
  ),
  constraint catalog_system_stage_roles_required_minimum check (
    necessity <> 'required' or minimum_selections > 0
  ),
  constraint catalog_system_stage_roles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create trigger catalog_system_stage_roles_validate_evidence
before insert or update on public.catalog_system_stage_roles
for each row execute function public.validate_catalog_assertion_evidence('decision_status', 'evidence_set_id');

create table public.product_system_roles (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  system_id uuid not null,
  stage_id uuid not null,
  role_id uuid not null references public.catalog_roles(id) on delete restrict,
  is_primary boolean not null default false,
  is_required boolean not null default false,
  decision_status text not null default 'needs_evidence',
  evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb,
  target_ref text generated always as (
    case
      when variant_id is null then 'product:' || product_id::text
      else 'variant:' || variant_id::text
    end
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stage_id, system_id) references public.catalog_stages(id, system_id) on delete cascade,
  constraint product_system_roles_status_allowed check (decision_status in (
    'proposed', 'needs_evidence', 'approved', 'rejected', 'superseded'
  )),
  constraint product_system_roles_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create unique index product_system_roles_target_unique_idx
  on public.product_system_roles(target_ref, system_id, stage_id, role_id)
  where decision_status in ('proposed', 'needs_evidence', 'approved');
create index product_system_roles_navigation_idx
  on public.product_system_roles(system_id, stage_id, role_id, decision_status);

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
    raise exception using
      errcode = '23514',
      message = 'La variante del rol no pertenece al producto indicado.';
  end if;

  if new.decision_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using
      errcode = '23514',
      message = 'Un rol aprobado necesita evidencia aprobada.';
  end if;
  return new;
end;
$function$;

create trigger product_system_roles_validate
before insert or update on public.product_system_roles
for each row execute function public.validate_product_system_role();

create table public.catalog_classes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  target_scope text not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_classes_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_classes_name_not_blank check (length(trim(name)) > 0),
  constraint catalog_classes_scope_allowed check (target_scope in ('product', 'variant')),
  constraint catalog_classes_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create table public.catalog_class_rules (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.catalog_classes(id) on delete cascade,
  rule_group integer not null default 1,
  value_source text not null,
  attribute_definition_id uuid not null references public.attribute_definitions(id) on delete restrict,
  operator text not null,
  option_id uuid references public.attribute_options(id) on delete restrict,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  decision_status text not null default 'proposed',
  evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_class_rules_group_positive check (rule_group > 0),
  constraint catalog_class_rules_source_allowed check (value_source in ('product', 'variant')),
  constraint catalog_class_rules_operator_allowed check (operator in (
    'equals', 'not_equals', 'greater_or_equal', 'less_or_equal', 'contains', 'exists', 'not_exists'
  )),
  constraint catalog_class_rules_value_consistent check (
    (operator in ('exists', 'not_exists') and num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 0)
    or (operator not in ('exists', 'not_exists') and num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 1)
  ),
  constraint catalog_class_rules_status_allowed check (decision_status in (
    'proposed', 'needs_evidence', 'approved', 'rejected', 'superseded'
  )),
  constraint catalog_class_rules_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_class_rules_evaluation_idx
  on public.catalog_class_rules(class_id, rule_group, decision_status)
  where is_active;

create or replace function public.validate_catalog_typed_rule()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  definition public.attribute_definitions%rowtype;
  class_scope text;
begin
  select * into definition
  from public.attribute_definitions
  where id = new.attribute_definition_id and is_active;
  if not found then
    raise exception using errcode = '23503', message = 'El atributo de la regla no existe o está inactivo.';
  end if;

  select target_scope into class_scope from public.catalog_classes where id = new.class_id;
  if class_scope = 'product' and new.value_source <> 'product' then
    raise exception using errcode = '23514', message = 'Una clase de producto no puede evaluar atributos de variante.';
  end if;

  if new.value_source = 'product' and definition.scope not in ('product', 'both') then
    raise exception using errcode = '23514', message = 'La regla requiere un atributo de producto.';
  elsif new.value_source = 'variant' and definition.scope not in ('variant', 'both') then
    raise exception using errcode = '23514', message = 'La regla requiere un atributo de variante.';
  end if;

  if new.option_id is not null and not exists (
    select 1 from public.attribute_options option
    where option.id = new.option_id
      and option.attribute_definition_id = new.attribute_definition_id
      and option.is_active
  ) then
    raise exception using errcode = '23514', message = 'La opción de la regla no pertenece al atributo.';
  end if;

  if new.operator in ('greater_or_equal', 'less_or_equal')
     and num_nonnulls(new.value_number, new.value_date) <> 1 then
    raise exception using errcode = '23514', message = 'La comparación ordenada requiere número o fecha.';
  elsif new.operator = 'contains'
        and num_nonnulls(new.value_text, new.value_json) <> 1 then
    raise exception using errcode = '23514', message = 'La comparación contains requiere texto o JSON.';
  end if;

  if new.decision_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using errcode = '23514', message = 'Una regla de clase aprobada necesita evidencia aprobada.';
  end if;

  return new;
end;
$function$;

create trigger catalog_class_rules_validate
before insert or update on public.catalog_class_rules
for each row execute function public.validate_catalog_typed_rule();

create table public.catalog_class_members (
  id uuid primary key default gen_random_uuid(),
  class_id uuid not null references public.catalog_classes(id) on delete cascade,
  product_id uuid references public.products(id) on delete cascade,
  variant_id uuid references public.product_variants(id) on delete cascade,
  origin text not null,
  source_rule_group integer,
  decision_status text not null default 'needs_evidence',
  evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  target_ref text generated always as (
    case
      when product_id is not null then 'product:' || product_id::text
      else 'variant:' || variant_id::text
    end
  ) stored,
  metadata jsonb not null default '{}'::jsonb,
  computed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_class_members_one_target check (num_nonnulls(product_id, variant_id) = 1),
  constraint catalog_class_members_origin_allowed check (origin in ('rule', 'manual')),
  constraint catalog_class_members_rule_origin_consistent check (
    (origin = 'rule' and source_rule_group is not null and computed_at is not null)
    or (origin = 'manual' and source_rule_group is null)
  ),
  constraint catalog_class_members_status_allowed check (decision_status in (
    'proposed', 'needs_evidence', 'approved', 'rejected', 'superseded'
  )),
  constraint catalog_class_members_metadata_object check (jsonb_typeof(metadata) = 'object'),
  unique (class_id, target_ref)
);

create index catalog_class_members_target_idx
  on public.catalog_class_members(target_ref, decision_status);

create or replace function public.validate_catalog_class_member()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  class_scope text;
begin
  select target_scope into class_scope from public.catalog_classes where id = new.class_id;
  if (class_scope = 'product') <> (new.product_id is not null) then
    raise exception using errcode = '23514', message = 'El miembro no coincide con el alcance de la clase.';
  end if;

  if new.origin = 'manual' and new.decision_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using errcode = '23514', message = 'Una membresía manual aprobada necesita evidencia aprobada.';
  end if;
  return new;
end;
$function$;

create trigger catalog_class_members_validate
before insert or update on public.catalog_class_members
for each row execute function public.validate_catalog_class_member();

create or replace function public.catalog_scalar_rule_matches(
  p_operator text,
  p_actual_option uuid,
  p_actual_text text,
  p_actual_number numeric,
  p_actual_boolean boolean,
  p_actual_date date,
  p_actual_json jsonb,
  p_expected_option uuid,
  p_expected_text text,
  p_expected_number numeric,
  p_expected_boolean boolean,
  p_expected_date date,
  p_expected_json jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $function$
  select case p_operator
    when 'equals' then
      p_actual_option is not distinct from p_expected_option
      and p_actual_text is not distinct from p_expected_text
      and p_actual_number is not distinct from p_expected_number
      and p_actual_boolean is not distinct from p_expected_boolean
      and p_actual_date is not distinct from p_expected_date
      and p_actual_json is not distinct from p_expected_json
    when 'greater_or_equal' then
      (p_expected_number is not null and p_actual_number >= p_expected_number)
      or (p_expected_date is not null and p_actual_date >= p_expected_date)
    when 'less_or_equal' then
      (p_expected_number is not null and p_actual_number <= p_expected_number)
      or (p_expected_date is not null and p_actual_date <= p_expected_date)
    when 'contains' then
      (p_expected_text is not null and position(lower(p_expected_text) in lower(coalesce(p_actual_text, ''))) > 0)
      or (p_expected_json is not null and coalesce(p_actual_json @> p_expected_json, false))
    else false
  end;
$function$;

create or replace function public.catalog_class_rule_matches(
  p_rule_id uuid,
  p_product_id uuid default null,
  p_variant_id uuid default null
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $function$
declare
  rule public.catalog_class_rules%rowtype;
  owner_product_id uuid;
  value_exists boolean;
  value_matches boolean;
begin
  if num_nonnulls(p_product_id, p_variant_id) <> 1 then
    raise exception using errcode = '22023', message = 'Debe indicarse producto XOR variante.';
  end if;

  select * into rule
  from public.catalog_class_rules
  where id = p_rule_id and is_active and decision_status = 'approved';
  if not found then return false; end if;

  if p_variant_id is not null then
    select product_id into owner_product_id from public.product_variants where id = p_variant_id;
  else
    owner_product_id := p_product_id;
  end if;

  if rule.value_source = 'product' then
    select
      count(*) > 0,
      coalesce(bool_or(public.catalog_scalar_rule_matches(
        rule.operator,
        value.option_id, value.value_text, value.value_number, value.value_boolean, value.value_date, value.value_json,
        rule.option_id, rule.value_text, rule.value_number, rule.value_boolean, rule.value_date, rule.value_json
      )), false)
    into value_exists, value_matches
    from public.product_attribute_values value
    where value.product_id = owner_product_id
      and value.attribute_definition_id = rule.attribute_definition_id
      and not value.needs_review;
  else
    if p_variant_id is null then return false; end if;
    select
      count(*) > 0,
      coalesce(bool_or(public.catalog_scalar_rule_matches(
        rule.operator,
        value.option_id, value.value_text, value.value_number, value.value_boolean, value.value_date, value.value_json,
        rule.option_id, rule.value_text, rule.value_number, rule.value_boolean, rule.value_date, rule.value_json
      )), false)
    into value_exists, value_matches
    from public.variant_attribute_values value
    where value.variant_id = p_variant_id
      and value.attribute_definition_id = rule.attribute_definition_id
      and not value.needs_review;
  end if;

  if rule.operator = 'exists' then return value_exists; end if;
  if rule.operator = 'not_exists' then return not value_exists; end if;
  if rule.operator = 'not_equals' then return value_exists and not value_matches; end if;
  return value_matches;
end;
$function$;

create or replace function public.refresh_catalog_class_members(p_class_id uuid)
returns integer
language plpgsql
volatile
security invoker
set search_path = ''
as $function$
declare
  class_scope text;
  inserted_count integer := 0;
begin
  select target_scope into class_scope
  from public.catalog_classes
  where id = p_class_id and is_active;
  if not found then
    raise exception using errcode = '22023', message = 'La clase no existe o está inactiva.';
  end if;

  delete from public.catalog_class_members
  where class_id = p_class_id and origin = 'rule';

  if class_scope = 'product' then
    insert into public.catalog_class_members(
      class_id, product_id, origin, source_rule_group, decision_status, computed_at
    )
    select p_class_id, product.id, 'rule', matched.rule_group, 'approved', now()
    from public.products product
    cross join lateral (
      select distinct candidate.rule_group
      from public.catalog_class_rules candidate
      where candidate.class_id = p_class_id
        and candidate.is_active and candidate.decision_status = 'approved'
        and not exists (
          select 1
          from public.catalog_class_rules requirement
          where requirement.class_id = p_class_id
            and requirement.rule_group = candidate.rule_group
            and requirement.is_active and requirement.decision_status = 'approved'
            and not public.catalog_class_rule_matches(requirement.id, product.id, null)
        )
      order by candidate.rule_group
      limit 1
    ) matched
    where product.is_active
    on conflict (class_id, target_ref) do nothing;
  else
    insert into public.catalog_class_members(
      class_id, variant_id, origin, source_rule_group, decision_status, computed_at
    )
    select p_class_id, variant.id, 'rule', matched.rule_group, 'approved', now()
    from public.product_variants variant
    join public.products product on product.id = variant.product_id and product.is_active
    cross join lateral (
      select distinct candidate.rule_group
      from public.catalog_class_rules candidate
      where candidate.class_id = p_class_id
        and candidate.is_active and candidate.decision_status = 'approved'
        and not exists (
          select 1
          from public.catalog_class_rules requirement
          where requirement.class_id = p_class_id
            and requirement.rule_group = candidate.rule_group
            and requirement.is_active and requirement.decision_status = 'approved'
            and not public.catalog_class_rule_matches(requirement.id, null, variant.id)
        )
      order by candidate.rule_group
      limit 1
    ) matched
    where variant.is_active
    on conflict (class_id, target_ref) do nothing;
  end if;

  get diagnostics inserted_count = row_count;
  return inserted_count;
end;
$function$;

revoke execute on function public.catalog_scalar_rule_matches(text, uuid, text, numeric, boolean, date, jsonb, uuid, text, numeric, boolean, date, jsonb) from public, anon;
revoke execute on function public.catalog_class_rule_matches(uuid, uuid, uuid) from public, anon;
revoke execute on function public.refresh_catalog_class_members(uuid) from public, anon;
grant execute on function public.catalog_scalar_rule_matches(text, uuid, text, numeric, boolean, date, jsonb, uuid, text, numeric, boolean, date, jsonb) to authenticated, service_role;
grant execute on function public.catalog_class_rule_matches(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.refresh_catalog_class_members(uuid) to authenticated, service_role;

create table public.catalog_relation_rules (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  source_class_id uuid not null references public.catalog_classes(id) on delete cascade,
  target_class_id uuid not null references public.catalog_classes(id) on delete cascade,
  relation_type public.product_relation_type not null,
  compatibility_status public.compatibility_status not null default 'unknown',
  system_id uuid references public.catalog_systems(id) on delete cascade,
  stage_id uuid,
  requirement_level text not null default 'optional',
  brand_policy text not null default 'explicit_evidence',
  decision_status text not null default 'proposed',
  evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (stage_id, system_id) references public.catalog_stages(id, system_id) on delete cascade,
  constraint catalog_relation_rules_code_format check (code ~ '^[A-Z][A-Z0-9_]*$'),
  constraint catalog_relation_rules_stage_consistent check (stage_id is null or system_id is not null),
  constraint catalog_relation_rules_requirement_allowed check (requirement_level in ('required', 'recommended', 'optional')),
  constraint catalog_relation_rules_brand_policy_allowed check (brand_policy in ('any_brand', 'same_brand', 'explicit_evidence')),
  constraint catalog_relation_rules_status_allowed check (decision_status in (
    'proposed', 'needs_evidence', 'approved', 'rejected', 'superseded'
  )),
  constraint catalog_relation_rules_metadata_object check (jsonb_typeof(metadata) = 'object')
);

create index catalog_relation_rules_lookup_idx
  on public.catalog_relation_rules(source_class_id, relation_type, decision_status)
  where is_active;

create trigger catalog_relation_rules_validate_evidence
before insert or update on public.catalog_relation_rules
for each row execute function public.validate_catalog_assertion_evidence('decision_status', 'evidence_set_id');

create table public.catalog_relation_rule_conditions (
  id uuid primary key default gen_random_uuid(),
  relation_rule_id uuid not null references public.catalog_relation_rules(id) on delete cascade,
  applies_to text not null,
  condition_group integer not null default 1,
  value_source text not null,
  attribute_definition_id uuid not null references public.attribute_definitions(id) on delete restrict,
  operator text not null,
  option_id uuid references public.attribute_options(id) on delete restrict,
  value_text text,
  value_number numeric,
  value_boolean boolean,
  value_date date,
  value_json jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_relation_rule_conditions_side_allowed check (applies_to in ('source', 'target')),
  constraint catalog_relation_rule_conditions_group_positive check (condition_group > 0),
  constraint catalog_relation_rule_conditions_source_allowed check (value_source in ('product', 'variant')),
  constraint catalog_relation_rule_conditions_operator_allowed check (operator in (
    'equals', 'not_equals', 'greater_or_equal', 'less_or_equal', 'contains', 'exists', 'not_exists'
  )),
  constraint catalog_relation_rule_conditions_value_consistent check (
    (operator in ('exists', 'not_exists') and num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 0)
    or (operator not in ('exists', 'not_exists') and num_nonnulls(option_id, value_text, value_number, value_boolean, value_date, value_json) = 1)
  )
);

create index catalog_relation_rule_conditions_lookup_idx
  on public.catalog_relation_rule_conditions(relation_rule_id, applies_to, condition_group)
  where is_active;

-- Las relaciones específicas existentes continúan en product_relations, pero
-- adquieren estado de conocimiento, evidencia y destino de clase.
alter table public.product_relations
  add column target_class_id uuid references public.catalog_classes(id) on delete cascade,
  add column knowledge_status text not null default 'legacy_unverified',
  add column evidence_set_id uuid references public.catalog_evidence_sets(id) on delete restrict,
  add column decided_by uuid references auth.users(id) on delete set null,
  add column decided_at timestamptz;

alter table public.product_relations alter column knowledge_status set default 'needs_evidence';

drop policy if exists "public read catalog relations" on public.product_relations;
drop index if exists public.product_relations_directional_unique_idx;
drop index if exists public.product_relations_symmetric_unique_idx;
alter table public.product_relations drop constraint product_relations_one_target;
alter table public.product_relations drop constraint product_relations_not_self;
alter table public.product_relations drop column target_ref;
alter table public.product_relations add column target_ref text generated always as (
  case
    when target_product_id is not null then 'product:' || target_product_id::text
    when target_variant_id is not null then 'variant:' || target_variant_id::text
    else 'class:' || target_class_id::text
  end
) stored;
alter table public.product_relations add constraint product_relations_one_target check (
  num_nonnulls(target_product_id, target_variant_id, target_class_id) = 1
);
alter table public.product_relations add constraint product_relations_not_self check (source_ref <> target_ref);
alter table public.product_relations add constraint product_relations_knowledge_status_allowed check (
  knowledge_status in ('legacy_unverified', 'proposed', 'needs_evidence', 'approved', 'rejected', 'superseded')
);
alter table public.product_relations add constraint product_relations_decision_consistent check (
  (knowledge_status in ('legacy_unverified', 'proposed', 'needs_evidence') and decided_at is null)
  or (knowledge_status in ('approved', 'rejected', 'superseded') and decided_at is not null)
);

create unique index product_relations_directional_unique_idx
on public.product_relations(relation_type, source_ref, target_ref)
where is_active and relation_type in (
  'spare_part_for', 'accessory_for', 'replacement_for', 'requires',
  'included_with', 'recommended_with'
);

create unique index product_relations_symmetric_unique_idx
on public.product_relations(
  relation_type,
  least(source_ref, target_ref),
  greatest(source_ref, target_ref)
)
where is_active and relation_type in ('compatible_with', 'alternative_to');

create index product_relations_target_class_idx
  on public.product_relations(target_class_id)
  where target_class_id is not null and is_active;
create index product_relations_knowledge_review_idx
  on public.product_relations(knowledge_status, relation_type, created_at);

create or replace function public.validate_product_relation_knowledge()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.knowledge_status = 'approved'
     and not public.catalog_assert_approved_evidence(new.evidence_set_id) then
    raise exception using errcode = '23514', message = 'Una relación canónica aprobada necesita evidencia aprobada.';
  end if;

  if tg_op = 'UPDATE' and old.knowledge_status = 'approved'
     and (
       new.source_ref is distinct from old.source_ref
       or new.target_ref is distinct from old.target_ref
       or new.relation_type is distinct from old.relation_type
       or new.compatibility_status is distinct from old.compatibility_status
     ) and new.knowledge_status = 'approved' then
    raise exception using
      errcode = '55000',
      message = 'Una relación aprobada no puede cambiar de significado; reemplácela y vuelva a validarla.';
  end if;
  return new;
end;
$function$;

create trigger product_relations_validate_knowledge
before insert or update on public.product_relations
for each row execute function public.validate_product_relation_knowledge();

create policy "public read catalog relations"
on public.product_relations for select to anon, authenticated
using (
  is_active
  and knowledge_status = 'approved'
  and (
    (source_product_id is not null and public.is_public_catalog_product(source_product_id))
    or (source_variant_id is not null and public.is_public_catalog_variant(source_variant_id))
  )
  and (
    (target_product_id is not null and public.is_public_catalog_product(target_product_id))
    or (target_variant_id is not null and public.is_public_catalog_variant(target_variant_id))
    or (target_class_id is not null and exists (
      select 1 from public.catalog_classes class where class.id = target_class_id and class.is_active
    ))
  )
);

-- Una candidata se clasifica antes de promoverse. Así 371 pares pueden
-- convertirse en pocas reglas, roles o membresías sin perder su historial.
alter table public.catalog_relation_candidates
  add column resolution_kind text,
  add column promoted_product_relation_id uuid references public.product_relations(id) on delete restrict,
  add column promoted_relation_rule_id uuid references public.catalog_relation_rules(id) on delete restrict,
  add column promoted_system_role_id uuid references public.product_system_roles(id) on delete restrict,
  add column promoted_class_member_id uuid references public.catalog_class_members(id) on delete restrict;

alter table public.catalog_relation_candidates add constraint catalog_relation_candidates_resolution_allowed check (
  resolution_kind is null or resolution_kind in (
    'specific_fact', 'class_rule', 'system_role', 'class_membership',
    'commercial_recommendation', 'insufficient_evidence', 'incorrect'
  )
);
alter table public.catalog_relation_candidates add constraint catalog_relation_candidates_promotion_consistent check (
  (status in ('proposed', 'needs_evidence')
    and resolution_kind is null
    and num_nonnulls(promoted_product_relation_id, promoted_relation_rule_id, promoted_system_role_id, promoted_class_member_id) = 0)
  or (status = 'approved'
    and resolution_kind is not null
    and num_nonnulls(promoted_product_relation_id, promoted_relation_rule_id, promoted_system_role_id, promoted_class_member_id) = 0)
  or (status = 'promoted'
    and resolution_kind in ('specific_fact', 'class_rule', 'system_role', 'class_membership', 'commercial_recommendation')
    and num_nonnulls(promoted_product_relation_id, promoted_relation_rule_id, promoted_system_role_id, promoted_class_member_id) = 1)
  or (status = 'rejected'
    and resolution_kind in ('insufficient_evidence', 'incorrect')
    and num_nonnulls(promoted_product_relation_id, promoted_relation_rule_id, promoted_system_role_id, promoted_class_member_id) = 0)
);

-- Esqueleto ontológico aprobado por el encargo. No asigna productos ni afirma
-- compatibilidades: esas filas llegarán únicamente con evidencia.
insert into public.catalog_systems(domain, code, name, description, sort_order)
values ('NAILS', 'ACRYLIC', 'Acrílico', 'Sistema de construcción de uñas con polímero y componente líquido.', 10)
on conflict (code) do update set
  domain = excluded.domain,
  name = excluded.name,
  description = excluded.description,
  sort_order = excluded.sort_order,
  is_active = true;

insert into public.catalog_stages(system_id, code, name, position)
select system.id, stage.code, stage.name, stage.position
from public.catalog_systems system
cross join (values
  ('PREPARATION', 'Preparar', 10),
  ('ADHESION', 'Adherir', 20),
  ('CONSTRUCTION', 'Construir', 30),
  ('SHAPING', 'Perfeccionar', 40),
  ('FINISHING', 'Finalizar', 50)
) as stage(code, name, position)
where system.code = 'ACRYLIC'
on conflict (system_id, code) do update set
  name = excluded.name,
  position = excluded.position,
  is_active = true;

insert into public.catalog_roles(code, name, role_kind, description)
values
  ('PREPARATION_AGENT', 'Preparador', 'preparation', 'Prepara la superficie antes de la adhesión.'),
  ('ADHESION_AGENT', 'Promotor de adhesión', 'adhesion', 'Favorece la adherencia dentro del sistema.'),
  ('POLYMER_COMPONENT', 'Componente polímero', 'component', 'Componente sólido de construcción acrílica.'),
  ('LIQUID_COMPONENT', 'Componente líquido', 'component', 'Componente líquido de construcción acrílica.'),
  ('APPLICATION_TOOL', 'Herramienta de aplicación', 'tool', 'Herramienta utilizada para aplicar o modelar.'),
  ('SHAPING_TOOL', 'Herramienta de perfeccionamiento', 'tool', 'Herramienta para limar, nivelar o perfeccionar.'),
  ('FINISHING_PRODUCT', 'Producto de finalización', 'finishing', 'Producto utilizado para completar el acabado.')
on conflict (code) do update set
  name = excluded.name,
  role_kind = excluded.role_kind,
  description = excluded.description,
  is_active = true;

insert into public.catalog_classes(code, name, target_scope, description)
values
  ('ACRYLIC_POLYMER', 'Polímero acrílico', 'product', 'Polvo o polímero utilizado para construir dentro del sistema acrílico.'),
  ('ACRYLIC_MONOMER', 'Monómero acrílico', 'product', 'Componente líquido del sistema acrílico.'),
  ('ACRYLIC_BRUSH', 'Pincel acrílico', 'product', 'Herramienta de aplicación apta para sistema acrílico.'),
  ('ACRYLIC_PRIMER', 'Primer para acrílico', 'product', 'Promotor de adhesión declarado para sistema acrílico.'),
  ('ACRYLIC_TOP_COAT', 'Finalizador para acrílico', 'product', 'Producto de acabado declarado para sistema acrílico.')
on conflict (code) do update set
  name = excluded.name,
  target_scope = excluded.target_scope,
  description = excluded.description,
  is_active = true;

insert into public.catalog_relation_rules(
  code, source_class_id, target_class_id, relation_type, compatibility_status,
  system_id, requirement_level, brand_policy, decision_status, notes
)
select
  'ACRYLIC_POLYMER_REQUIRES_MONOMER', source.id, target.id, 'requires', 'unknown',
  system.id, 'required', 'explicit_evidence', 'needs_evidence',
  'Hipótesis estructural del sistema acrílico: no entra al grafo aprobado hasta adjuntar evidencia.'
from public.catalog_classes source
join public.catalog_classes target on target.code = 'ACRYLIC_MONOMER'
join public.catalog_systems system on system.code = 'ACRYLIC'
where source.code = 'ACRYLIC_POLYMER'
on conflict (code) do update set
  source_class_id = excluded.source_class_id,
  target_class_id = excluded.target_class_id,
  system_id = excluded.system_id,
  requirement_level = excluded.requirement_level,
  brand_policy = excluded.brand_policy,
  notes = excluded.notes,
  is_active = true;

-- RLS: la ontología aprobada puede alimentar la experiencia pública; las
-- decisiones pendientes y toda evidencia quedan en administración.
alter table public.catalog_systems enable row level security;
alter table public.catalog_stages enable row level security;
alter table public.catalog_roles enable row level security;
alter table public.catalog_system_stage_roles enable row level security;
alter table public.product_system_roles enable row level security;
alter table public.catalog_classes enable row level security;
alter table public.catalog_class_rules enable row level security;
alter table public.catalog_class_members enable row level security;
alter table public.catalog_relation_rules enable row level security;
alter table public.catalog_relation_rule_conditions enable row level security;

create policy "public read catalog systems" on public.catalog_systems
for select to anon, authenticated using (is_active);
create policy "public read catalog stages" on public.catalog_stages
for select to anon, authenticated using (is_active);
create policy "public read catalog roles" on public.catalog_roles
for select to anon, authenticated using (is_active);
create policy "public read approved system stage roles" on public.catalog_system_stage_roles
for select to anon, authenticated using (is_active and decision_status = 'approved');
create policy "public read approved product system roles" on public.product_system_roles
for select to anon, authenticated using (
  decision_status = 'approved'
  and (
    (variant_id is null and public.is_public_catalog_product(product_id))
    or (variant_id is not null and public.is_public_catalog_variant(variant_id))
  )
);
create policy "public read catalog classes" on public.catalog_classes
for select to anon, authenticated using (is_active);
create policy "public read approved class rules" on public.catalog_class_rules
for select to anon, authenticated using (is_active and decision_status = 'approved');
create policy "public read approved class members" on public.catalog_class_members
for select to anon, authenticated using (
  decision_status = 'approved'
  and (
    (product_id is not null and public.is_public_catalog_product(product_id))
    or (variant_id is not null and public.is_public_catalog_variant(variant_id))
  )
);
create policy "public read approved relation rules" on public.catalog_relation_rules
for select to anon, authenticated using (is_active and decision_status = 'approved');
create policy "public read approved relation conditions" on public.catalog_relation_rule_conditions
for select to anon, authenticated using (
  is_active and exists (
    select 1 from public.catalog_relation_rules rule
    where rule.id = relation_rule_id and rule.is_active and rule.decision_status = 'approved'
  )
);

create policy "admins manage catalog systems" on public.catalog_systems
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog stages" on public.catalog_stages
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog roles" on public.catalog_roles
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog system stage roles" on public.catalog_system_stage_roles
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage product system roles" on public.product_system_roles
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog classes" on public.catalog_classes
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog class rules" on public.catalog_class_rules
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog class members" on public.catalog_class_members
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog relation rules" on public.catalog_relation_rules
for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admins manage catalog relation rule conditions" on public.catalog_relation_rule_conditions
for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on
  public.catalog_systems, public.catalog_stages, public.catalog_roles,
  public.catalog_system_stage_roles, public.product_system_roles,
  public.catalog_classes, public.catalog_class_rules, public.catalog_class_members,
  public.catalog_relation_rules, public.catalog_relation_rule_conditions
to anon, authenticated;

grant insert, update, delete on
  public.catalog_systems, public.catalog_stages, public.catalog_roles,
  public.catalog_system_stage_roles, public.product_system_roles,
  public.catalog_classes, public.catalog_class_rules, public.catalog_class_members,
  public.catalog_relation_rules, public.catalog_relation_rule_conditions
to authenticated;

grant select, insert, update, delete on
  public.catalog_systems, public.catalog_stages, public.catalog_roles,
  public.catalog_system_stage_roles, public.product_system_roles,
  public.catalog_classes, public.catalog_class_rules, public.catalog_class_members,
  public.catalog_relation_rules, public.catalog_relation_rule_conditions
to service_role;

create trigger catalog_systems_set_updated_at before update on public.catalog_systems
for each row execute function public.set_updated_at();
create trigger catalog_stages_set_updated_at before update on public.catalog_stages
for each row execute function public.set_updated_at();
create trigger catalog_roles_set_updated_at before update on public.catalog_roles
for each row execute function public.set_updated_at();
create trigger catalog_system_stage_roles_set_updated_at before update on public.catalog_system_stage_roles
for each row execute function public.set_updated_at();
create trigger product_system_roles_set_updated_at before update on public.product_system_roles
for each row execute function public.set_updated_at();
create trigger catalog_classes_set_updated_at before update on public.catalog_classes
for each row execute function public.set_updated_at();
create trigger catalog_class_rules_set_updated_at before update on public.catalog_class_rules
for each row execute function public.set_updated_at();
create trigger catalog_class_members_set_updated_at before update on public.catalog_class_members
for each row execute function public.set_updated_at();
create trigger catalog_relation_rules_set_updated_at before update on public.catalog_relation_rules
for each row execute function public.set_updated_at();
create trigger catalog_relation_rule_conditions_set_updated_at before update on public.catalog_relation_rule_conditions
for each row execute function public.set_updated_at();

comment on table public.catalog_system_stage_roles is
  'Roles que un sistema espera en cada etapa; permite calcular qué falta sin inventar pares producto-producto.';
comment on table public.catalog_relation_rules is
  'Relaciones canónicas entre clases. Solo las aprobadas con evidencia pueden entrar a la proyección gráfica.';
comment on column public.product_relations.knowledge_status is
  'Distingue una relación guardada de un hecho aprobado. La lectura pública exige approved.';

commit;
