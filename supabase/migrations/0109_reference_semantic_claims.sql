-- 0109 - Claims semanticos de fuentes externas y vocabulario normalizado.
-- PostgreSQL conserva lo que la fuente declara; estos terminos no son hechos tecnicos canonicos.

begin;

alter table public.catalog_observations
  drop constraint catalog_observations_kind_allowed;

alter table public.catalog_observations
  add constraint catalog_observations_kind_allowed check (observation_kind in (
    'attribute', 'identity', 'code', 'type', 'presentation', 'shade',
    'technical_attribute', 'system', 'stage', 'class', 'relation',
    'remote_image', 'lifecycle', 'semantic_claim'
  ));

create table public.catalog_semantic_terms (
  id uuid primary key default gen_random_uuid(),
  dimension text not null,
  code text not null,
  label text not null,
  description text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_semantic_terms_dimension_allowed check (dimension in (
    'type', 'subtype', 'concern', 'benefit', 'ingredient', 'use',
    'role', 'stage', 'system', 'formulation', 'finish', 'relation'
  )),
  constraint catalog_semantic_terms_code_not_blank check (length(trim(code)) > 0),
  constraint catalog_semantic_terms_label_not_blank check (length(trim(label)) > 0),
  constraint catalog_semantic_terms_metadata_object check (jsonb_typeof(metadata) = 'object'),
  unique (dimension, code)
);

create table public.catalog_observation_semantic_terms (
  observation_id uuid primary key references public.catalog_observations(id) on delete cascade,
  semantic_term_id uuid not null references public.catalog_semantic_terms(id) on delete restrict,
  normalization_status text not null default 'observed',
  normalization_method text not null,
  confidence numeric(5,4) not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_observation_semantic_terms_status_allowed check (
    normalization_status in ('observed', 'reviewed', 'rejected', 'superseded')
  ),
  constraint catalog_observation_semantic_terms_method_not_blank check (
    length(trim(normalization_method)) > 0
  ),
  constraint catalog_observation_semantic_terms_confidence_range check (
    confidence >= 0 and confidence <= 1
  ),
  constraint catalog_observation_semantic_terms_metadata_object check (
    jsonb_typeof(metadata) = 'object'
  )
);

create index catalog_observation_semantic_terms_term_status_idx
  on public.catalog_observation_semantic_terms(semantic_term_id, normalization_status, observation_id);

create or replace function public.validate_catalog_observation_semantic_term()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  observation public.catalog_observations%rowtype;
  term public.catalog_semantic_terms%rowtype;
begin
  select * into observation
  from public.catalog_observations
  where id = new.observation_id;

  select * into term
  from public.catalog_semantic_terms
  where id = new.semantic_term_id;

  if observation.observation_kind <> 'semantic_claim' then
    raise exception using errcode = '23514',
      message = 'Solo una observacion semantic_claim puede normalizarse a un termino.';
  end if;

  if observation.predicate <> 'semantic.' || term.dimension then
    raise exception using errcode = '23514',
      message = 'La dimension del termino no coincide con el predicado observado.';
  end if;

  if jsonb_typeof(observation.value_json) <> 'object'
     or observation.value_json->>'termCode' <> term.code
     or observation.value_json->>'claimStatus' <> 'source_claim' then
    raise exception using errcode = '23514',
      message = 'El claim debe conservar termCode y claimStatus=source_claim.';
  end if;

  return new;
end;
$function$;

create trigger catalog_observation_semantic_terms_validate
before insert or update on public.catalog_observation_semantic_terms
for each row execute function public.validate_catalog_observation_semantic_term();

revoke all on function public.validate_catalog_observation_semantic_term()
from public, anon, authenticated;

create or replace view public.catalog_reference_product_semantics_v1
with (security_invoker = true) as
select
  observation.reference_product_id,
  reference.reference_key,
  reference.name as product_name,
  reference.family as official_family,
  reference.source_url,
  term.dimension,
  term.code as term_code,
  term.label as term_label,
  link.normalization_status,
  link.normalization_method,
  link.confidence as normalization_confidence,
  observation.id as observation_id,
  observation.observation_key,
  observation.research_run_id,
  observation.source_record_id,
  observation.observed_at,
  observation.extraction_method,
  observation.extractor,
  observation.confidence as observation_confidence,
  observation.value_json->>'claimKind' as claim_kind,
  observation.value_json->>'claimStatus' as claim_status,
  observation.value_json->>'sourceField' as source_field,
  observation.value_json->>'sourceExcerpt' as source_excerpt,
  observation.value_json->>'evidenceFingerprint' as evidence_fingerprint,
  observation.value_json->>'rawStorageReference' as raw_storage_reference,
  observation.value_json->'metadata' as claim_metadata
from public.catalog_observation_semantic_terms link
join public.catalog_observations observation on observation.id = link.observation_id
join public.catalog_semantic_terms term on term.id = link.semantic_term_id
join public.catalog_reference_products reference on reference.id = observation.reference_product_id
where observation.reference_product_id is not null;

create or replace view public.catalog_reference_semantic_coverage_v1
with (security_invoker = true) as
with dimensions(dimension) as (
  values ('type'), ('subtype'), ('concern'), ('benefit'), ('ingredient'), ('use'),
         ('role'), ('stage'), ('system'), ('formulation'), ('finish'), ('relation')
), reference_products as (
  select id as reference_product_id
  from public.catalog_reference_products
), covered as (
  select dimension, count(distinct reference_product_id)::bigint as covered_products
  from public.catalog_reference_product_semantics_v1
  where normalization_status in ('observed', 'reviewed')
  group by dimension
)
select
  dimensions.dimension,
  coalesce(covered.covered_products, 0) as covered_products,
  (select count(*) from reference_products)::bigint as total_products,
  round(
    100 * coalesce(covered.covered_products, 0)::numeric
      / nullif((select count(*) from reference_products), 0),
    2
  ) as coverage_percent
from dimensions
left join covered using (dimension);

create or replace view public.graph_semantic_term_nodes_v1
with (security_invoker = true) as
select
  'semantic_term:' || term.id::text as node_key,
  'SemanticTerm'::text as node_type,
  term.id as entity_id,
  term.label,
  'evidence'::text as layer,
  jsonb_build_object(
    'dimension', term.dimension,
    'code', term.code,
    'epistemicStatus', 'normalized_source_vocabulary',
    'isCanonicalTechnicalFact', false
  ) as properties
from public.catalog_semantic_terms term;

create or replace view public.graph_semantic_term_edges_v1
with (security_invoker = true) as
select
  'observation-semantic-term:' || link.observation_id::text as edge_key,
  'observation:' || link.observation_id::text as source_key,
  'NORMALIZES_TO'::text as predicate,
  'semantic_term:' || link.semantic_term_id::text as target_key,
  'evidence'::text as layer,
  jsonb_build_object(
    'status', link.normalization_status,
    'method', link.normalization_method,
    'confidence', link.confidence,
    'isCanonicalTechnicalFact', false
  ) as properties
from public.catalog_observation_semantic_terms link;

create or replace view public.graph_nodes_v2
with (security_invoker = true) as
select
  node.node_key,
  node.node_type,
  node.entity_id,
  node.label,
  node.layer,
  node.properties,
  md5(node.node_key || '|' || node.node_type || '|' || node.layer || '|' || node.label || '|' || node.properties::text) as projection_fingerprint
from (
  select * from public.graph_nodes_v2_base
  union all
  select * from public.graph_identity_case_nodes_v1
  union all
  select * from public.graph_review_work_nodes_v1
  union all
  select * from public.graph_semantic_term_nodes_v1
) node;

create or replace view public.graph_edges_v2
with (security_invoker = true) as
select
  edge.edge_key,
  edge.source_key,
  edge.predicate,
  edge.target_key,
  edge.layer,
  edge.properties,
  md5(edge.edge_key || '|' || edge.source_key || '|' || edge.predicate || '|' || edge.target_key || '|' || edge.layer || '|' || edge.properties::text) as projection_fingerprint
from (
  select * from public.graph_edges_v2_base where edge_key not like 'reference-match:%'
  union all
  select * from public.graph_identity_case_edges_v1
  union all
  select * from public.graph_review_work_edges_v1
  union all
  select * from public.graph_semantic_term_edges_v1
) edge;

alter table public.catalog_semantic_terms enable row level security;
alter table public.catalog_observation_semantic_terms enable row level security;

create policy "admins manage catalog semantic terms"
on public.catalog_semantic_terms for all to authenticated
using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

create policy "admins manage observation semantic terms"
on public.catalog_observation_semantic_terms for all to authenticated
using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

grant select, insert, update on public.catalog_semantic_terms,
  public.catalog_observation_semantic_terms to authenticated, service_role;
grant select on public.catalog_reference_product_semantics_v1,
  public.catalog_reference_semantic_coverage_v1,
  public.graph_semantic_term_nodes_v1,
  public.graph_semantic_term_edges_v1 to authenticated, service_role;

comment on table public.catalog_semantic_terms is
  'Vocabulario normalizado para interpretar claims de fuente; no representa verdad tecnica universal.';
comment on table public.catalog_observation_semantic_terms is
  'Vincula evidencia observada con vocabulario normalizado conservando estado, metodo y confianza.';
comment on view public.catalog_reference_product_semantics_v1 is
  'Claims semanticos de productos de referencia con excerpt, RAW y procedencia. Nunca eleva claims a hechos canonicos.';

commit;
