/**
 * Certificacion del Checkpoint Semantico Universal.
 *
 * Los fixtures se revierten. Solo el certificado agregado y su fingerprint se
 * conservan en PostgreSQL; nunca se publican productos sinteticos.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import { loadSupabaseScriptEnv } from "./lib/supabase-script-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { env, isLocal } = loadSupabaseScriptEnv({
  rootDir: ROOT,
  scriptName: "gate:semantic-certification",
  allowedFlags: [],
});
if (!isLocal) throw new Error("La certificacion semantica solo se ejecuta contra Supabase local.");

const pool = new Pool({ connectionString: env.POSTGRES_URL, max: 1 });
const client = await pool.connect();
const fixturePrefix = randomUUID();
const ids = Object.fromEntries([
  "officialSource", "marketSource", "officialSnapshot", "marketSnapshot",
  "officialRecord", "marketRecord", "researchRun", "referenceProduct",
  "officialVoltageObservation", "marketVoltageObservation", "typeObservation",
].map((key) => [key, randomUUID()]));
const startedAt = new Date();
const checks = {};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function value(sql, parameters = []) {
  return (await client.query(sql, parameters)).rows[0]?.value;
}

let savepointCounter = 0;
async function expectRejected(sql, parameters, expectedCode, checkName) {
  const savepoint = `semantic_gate_${++savepointCounter}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(sql, parameters);
    throw new Error(`${checkName}: la operacion prohibida fue aceptada.`);
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    if (error.code !== expectedCode) throw error;
    checks[checkName] = true;
  }
}

try {
  await client.query("begin");
  const brandId = await value("select id as value from public.brands order by id limit 1");
  assert(brandId, "La certificacion necesita una marca estructural para las FK del fixture.");

  const dimensionCode = `certification_${fixturePrefix.replaceAll("-", "").slice(0, 20)}`;
  await client.query(`
    with dimension as (
      insert into public.catalog_semantic_dimensions(code,label,value_kind,metadata)
      values ($1,'Runtime certification dimension','structured','{"synthetic":true}')
      returning code
    )
    insert into public.catalog_technical_type_dimension_policies(
      profile_id,dimension_code,applicability,rationale
    )
    select profile.id,dimension.code,'optional',
           'Runtime proof that dimensions extend through data only.'
    from dimension
    join public.catalog_technical_type_profiles profile
      on profile.technical_type_code='UNIVERSAL_PRODUCT'
  `, [dimensionCode]);
  const inheritedDimensions = Number(await value(`
    select count(*)::integer as value
    from public.catalog_technical_type_dimension_contract_v1 contract
    join public.catalog_semantic_archetypes archetype
      on archetype.technical_type_code=contract.technical_type_code
    where contract.dimension_code=$1
  `, [dimensionCode]));
  assert(inheritedDimensions === 10, "La dimension nueva no se heredo en los diez arquetipos.");
  checks.extensibleDimensions = true;

  await expectRejected(`
    insert into public.catalog_semantic_rules(
      rule_code,rule_version,rule_family,description,input_predicates,
      output_predicate,output_dimension_code,scope,confidence,definition
    ) values ('CERTIFICATION_ILLEGAL_SCOPE',1,'DERIVATION','Forbidden individual scope.',
      array['x'],'x','type','{"product_id":"forbidden"}',1,'{"operation":"copy"}')
  `, [], "23514", "universalRuleScope");

  await client.query(`
    insert into public.catalog_sources(
      id,source_key,name,authority,adapter,base_url,brand_id,metadata
    ) values
      ($1,$2,'Synthetic official certification source','official','html',
       'https://semantic-certification.invalid/official',$3,'{"synthetic":true}'),
      ($4,$5,'Synthetic marketplace certification source','marketplace','html',
       'https://semantic-certification.invalid/marketplace',$3,'{"synthetic":true}')
  `, [ids.officialSource, `cert-official-${fixturePrefix}`, brandId,
      ids.marketSource, `cert-market-${fixturePrefix}`]);
  await client.query(`
    insert into public.catalog_source_snapshots(
      id,source_id,status,completed_at,content_hash,metadata
    ) values
      ($1,$2,'succeeded',now(),$3,'{"synthetic":true}'),
      ($4,$5,'succeeded',now(),$6,'{"synthetic":true}')
  `, [ids.officialSnapshot, ids.officialSource, `official-${fixturePrefix}`,
      ids.marketSnapshot, ids.marketSource, `market-${fixturePrefix}`]);
  await client.query(`
    insert into public.catalog_source_records(
      id,snapshot_id,source_id,entity_type,external_id,title,normalized_name,
      source_url,payload,captured_at
    ) values
      ($1,$2,$3,'product',$4,'Synthetic electrical equipment',
       'synthetic electrical equipment','https://semantic-certification.invalid/official/item',
       '{"type":"Electrical equipment","voltage":"110 V"}',now()),
      ($5,$6,$7,'product',$8,'Synthetic electrical equipment',
       'synthetic electrical equipment','https://semantic-certification.invalid/marketplace/item',
       '{"voltage":"220 V"}',now())
  `, [ids.officialRecord, ids.officialSnapshot, ids.officialSource, `official-${fixturePrefix}`,
      ids.marketRecord, ids.marketSnapshot, ids.marketSource, `market-${fixturePrefix}`]);
  await client.query(`
    insert into public.catalog_research_runs(
      id,run_key,run_kind,actor_kind,actor_label,status,input_fingerprint,
      scope,metrics,errors,result
    ) values ($1,$2,'targeted','system','universal semantic certification','running',$3,
      '{"synthetic":true}','{}','[]','{}')
  `, [ids.researchRun, `semantic-certification-fixture-${fixturePrefix}`, `input-${fixturePrefix}`]);
  await client.query(`
    insert into public.catalog_reference_products(
      id,reference_key,brand_id,primary_source_id,primary_source_record_id,
      primary_external_id,name,normalized_name,family,product_type,source_url,
      identity_fingerprint,content_fingerprint,first_seen_run_id,last_seen_run_id,
      first_seen_at,last_seen_at
    ) values ($1,$2,$3,$4,$5,$6,'Synthetic electrical equipment',
      'synthetic electrical equipment','Synthetic equipment','Electrical equipment',
      'https://semantic-certification.invalid/official/item',$7,$8,$9,$9,now(),now())
  `, [ids.referenceProduct, `semantic-certification:${fixturePrefix}`, brandId,
      ids.officialSource, ids.officialRecord, `external-${fixturePrefix}`,
      `identity-${fixturePrefix}`, `content-${fixturePrefix}`, ids.researchRun]);
  await client.query(`
    insert into public.catalog_observations(
      id,observation_key,source_record_id,research_run_id,reference_product_id,
      observation_kind,predicate,value_json,observed_at,extraction_method,
      extractor,confidence,metadata
    ) values
      ($1,$2,$3,$4,$5,'semantic_claim','technical.voltage',
       '{"value":110,"unit":"V"}',now(),'official_page','semantic-certification-v1',0.99,'{"synthetic":true}'),
      ($6,$7,$8,$4,$5,'semantic_claim','technical.voltage',
       '{"value":220,"unit":"V"}',now(),'official_page','semantic-certification-v1',0.75,'{"synthetic":true}'),
      ($9,$10,$3,$4,$5,'semantic_claim','identity.type',
       '{"literal":"Electrical equipment"}',now(),'official_page','semantic-certification-v1',1,'{"synthetic":true}')
  `, [ids.officialVoltageObservation, `voltage-official-${fixturePrefix}`, ids.officialRecord,
      ids.researchRun, ids.referenceProduct, ids.marketVoltageObservation,
      `voltage-market-${fixturePrefix}`, ids.marketRecord, ids.typeObservation,
      `type-official-${fixturePrefix}`]);

  const authorityRows = (await client.query(`
    select 'identity' as predicate_kind,authority_level
    from public.resolve_catalog_source_authority_v1($1,'identity.type','type','identity')
    union all
    select 'market_technical',authority_level
    from public.resolve_catalog_source_authority_v1($2,'technical.voltage','voltage','specification')
  `, [ids.officialSource, ids.marketSource])).rows;
  assert(authorityRows.some((row) => row.predicate_kind === "identity" && row.authority_level === "preferred"),
    "La autoridad oficial de identidad no se resolvio por predicado.");
  assert(authorityRows.some((row) => row.predicate_kind === "market_technical" && row.authority_level === "prohibited"),
    "La autoridad tecnica de marketplace no quedo prohibida.");
  checks.sourcePredicateAuthority = true;

  const officialVoltageClaim = await value(`select public.register_catalog_literal_claim_v1(
    $1,$2,'specification','{"value":110,"unit":"V"}','ASSERTED','voltage',
    'Rated voltage: 110 V','raw://certification/official-voltage','110 V'
  ) as value`, [`literal-voltage-${fixturePrefix}`, ids.officialVoltageObservation]);
  const literalTypeClaim = await value(`select public.register_catalog_literal_claim_v1(
    $1,$2,'identity','{"literal":"Electrical equipment"}','ASSERTED','type',
    'Type: Electrical equipment','raw://certification/type','Electrical equipment'
  ) as value`, [`literal-type-${fixturePrefix}`, ids.typeObservation]);
  checks.literalObservation = true;

  await expectRejected(`select public.register_catalog_literal_claim_v1(
    $1,$2,'specification','{"value":111,"unit":"V"}','ASSERTED','voltage',
    'No rating is shown','raw://certification/unsupported','111 V'
  )`, [`unsupported-${fixturePrefix}`, ids.officialVoltageObservation], "23514", "excerptEntailment");

  const normalizationExecution = await value(`select public.execute_catalog_semantic_rule_v1(
    'NORMALIZE_LITERAL_TERM',1,array[$1::uuid],$2,'semantic.normalized','type',
    '{"term":"electrical_equipment"}',1,
    '{"operation":"casefold_and_dictionary","inferenceAdded":false}'
  ) as value`, [literalTypeClaim, `reference_product:${ids.referenceProduct}`]);
  const normalizedClaim = await value(`select public.register_catalog_rule_claim_v1(
    $1,$2,'NORMALIZED_SOURCE_CLAIM','ASSERTED','type','Type: Electrical equipment',
    'raw://certification/type','Electrical equipment'
  ) as value`, [`normalized-type-${fixturePrefix}`, normalizationExecution]);
  checks.normalizedSourceClaim = true;

  const unitExecution = await value(`select public.execute_catalog_semantic_rule_v1(
    'NORMALIZE_QUANTITY_UNIT',1,array[$1::uuid],$2,'semantic.quantity','specification',
    '{"value":110,"unit":"V"}',0.99,
    '{"operation":"identity_unit_conversion","dimensionCrossing":false}'
  ) as value`, [officialVoltageClaim, `reference_product:${ids.referenceProduct}`]);
  const derivedClaim = await value(`select public.register_catalog_rule_claim_v1(
    $1,$2,'DERIVED_INFERRED','ASSERTED'
  ) as value`, [`derived-voltage-${fixturePrefix}`, unitExecution]);
  const derivedClass = await value("select epistemic_class as value from public.catalog_semantic_claims where id=$1", [derivedClaim]);
  assert(derivedClass === "DERIVED_INFERRED", "La inferencia no conservo su clase epistemica.");
  checks.derivedInference = true;

  const marketVoltageClaim = await value(`select public.register_catalog_literal_claim_v1(
    $1,$2,'specification','{"value":220,"unit":"V"}','ASSERTED','voltage',
    'Rated voltage: 220 V','raw://certification/market-voltage','220 V'
  ) as value`, [`literal-market-voltage-${fixturePrefix}`, ids.marketVoltageObservation]);
  await client.query(`select public.register_catalog_claim_relation_v1(
    $1,$2,'CONTRADICTS','DETECT_CONTRADICTORY_VALUES',1,
    'The same scalar predicate has mutually incompatible values.',
    '{"synthetic":true}')`, [officialVoltageClaim, marketVoltageClaim]);
  const contradictedClaims = Number(await value(`select count(*)::integer as value
    from public.catalog_semantic_claims where id in ($1,$2) and claim_status='CONTRADICTED'`,
    [officialVoltageClaim, marketVoltageClaim]));
  assert(contradictedClaims === 2, "La contradiccion no preservo y marco ambos claims.");
  await expectRejected(`select public.promote_catalog_canonical_claim_v1(
    $1,'ELECTRICAL_EQUIPMENT','RULE',
    'Contradicted values cannot be silently promoted.',
    'PROMOTE_CANONICAL_ASSERTION',1)`, [officialVoltageClaim], "23514", "contradictionBlocksCanonical");
  checks.explicitContradiction = true;

  const canonicalClaim = await value(`select public.promote_catalog_canonical_claim_v1(
    $1,'ELECTRICAL_EQUIPMENT','RULE',
    'The entailed preferred-authority type passes the universal canonical gate.',
    'PROMOTE_CANONICAL_ASSERTION',1) as value`, [normalizedClaim]);
  const canonicalClass = await value("select epistemic_class as value from public.catalog_semantic_claims where id=$1", [canonicalClaim]);
  assert(canonicalClass === "CANONICAL_FACT", "La promocion no produjo un hecho canonico separado.");
  checks.canonicalPromotion = true;

  const workBefore = Number(await value("select count(*)::integer as value from public.catalog_review_work_items"));
  for (const absenceState of ["UNKNOWN", "NOT_STATED", "NOT_APPLICABLE"]) {
    const executionId = await value(`select public.execute_catalog_semantic_rule_v1(
      'APPLY_CONDITIONAL_DIMENSION',1,array[$1::uuid],$2,
      'semantic.applicability','type',null,1,
      jsonb_build_object('absenceState',$3::text,'synthetic',true)
    ) as value`, [normalizedClaim, `reference_product:${ids.referenceProduct}`, absenceState]);
    await client.query(`select public.register_catalog_rule_claim_v1(
      $1,$2,'DERIVED_INFERRED',$3)`,
    [`absence-${absenceState.toLowerCase()}-${fixturePrefix}`, executionId, absenceState]);
  }
  const absenceCount = Number(await value(`select count(*)::integer as value
    from public.catalog_semantic_claims where claim_key like $1 and value_json is null`,
    [`absence-%-${fixturePrefix}`]));
  const workAfter = Number(await value("select count(*)::integer as value from public.catalog_review_work_items"));
  assert(absenceCount === 3, "Los tres estados de ausencia no quedaron separados.");
  assert(workBefore === workAfter, "Un estado de ausencia creo trabajo humano.");
  checks.absenceWithoutHumanWork = true;

  const violationCount = Number(await value(
    "select count(*)::integer as value from public.catalog_semantic_contract_violations_v1",
  ));
  assert(violationCount === 0, `El contrato fail-closed reporto ${violationCount} violaciones.`);
  const graphEvidence = (await client.query(`
    select
      count(*) filter (where node_type='SemanticClaim')::integer as claim_nodes,
      (select count(*)::integer from public.graph_universal_semantic_edges_v1
       where predicate='CONTRADICTS') as contradiction_edges
    from public.graph_universal_semantic_nodes_v1
  `)).rows[0];
  assert(graphEvidence.claim_nodes >= 9 && graphEvidence.contradiction_edges === 1,
    "La proyeccion no conserva la cadena epistemica y la contradiccion.");
  checks.graphExplainability = true;

  const archetypes = (await client.query(`
    select archetype.archetype_code,archetype.technical_type_code,
           archetype.required_capabilities,
           not exists (
             select 1
             from jsonb_array_elements_text(archetype.fixture_contract->'requiredDimensions') dimension
             where not exists (
               select 1 from public.catalog_technical_type_dimension_contract_v1 contract
               where contract.technical_type_code=archetype.technical_type_code
                 and contract.dimension_code=dimension
             )
           ) as profile_complete
    from public.catalog_semantic_archetypes archetype
    where archetype.is_active order by archetype.archetype_code
  `)).rows;
  assert(archetypes.length === 10 && archetypes.every((item) => item.profile_complete),
    "La certificacion no cubre diez arquetipos con perfiles completos.");
  checks.syntheticArchetypes = true;

  const ruleFamilies = Number(await value(`select count(distinct rule_family)::integer as value
    from public.catalog_semantic_rules where is_active`));
  const goldenInvariants = Number(await value(`select count(*)::integer as value
    from public.catalog_semantic_golden_invariants where is_active`));
  assert(ruleFamilies === 8, "El registro no cubre las ocho familias universales de regla.");
  assert(goldenInvariants === 10, "El golden regression set no contiene diez invariantes generales.");
  checks.ruleFamilies = true;
  checks.goldenRegressionSet = true;

  await client.query("rollback");

  const elapsedMs = Math.round(performance.now());
  const certificationId = randomUUID();
  const runKey = `universal-semantic-certification-${new Date().toISOString()}-${certificationId}`;
  const evidence = {
    contractVersion: "universal-semantic-v1",
    archetypes: archetypes.map((item) => item.archetype_code),
    checks,
    ruleFamilies,
    goldenInvariants,
    contractViolations: violationCount,
    graph: graphEvidence,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

  await client.query("begin");
  await client.query(`
    insert into public.catalog_semantic_certification_runs(
      id,run_key,status,contract_version,started_at,finished_at,metrics,result_fingerprint
    ) values ($1,$2,'passed','universal-semantic-v1',$3,now(),$4,$5)
  `, [certificationId, runKey, startedAt, {
    archetypes: archetypes.length,
    capabilities: archetypes.reduce((sum, item) => sum + item.required_capabilities.length, 0),
    scenarioChecks: Object.keys(checks).length,
    contractViolations: violationCount,
  }, fingerprint]);
  for (const archetype of archetypes) {
    for (const capability of archetype.required_capabilities) {
      await client.query(`
        insert into public.catalog_semantic_certification_results(
          run_id,archetype_code,capability_code,status,evidence
        ) values ($1,$2,$3,'passed',$4)
      `, [certificationId, archetype.archetype_code, capability, {
        synthetic: true,
        technicalTypeCode: archetype.technical_type_code,
        profileComplete: true,
        contractFingerprint: fingerprint,
      }]);
    }
  }
  await client.query("commit");

  const checkpoint = (await client.query(
    "select public.get_catalog_semantic_checkpoint_report_v1() as report",
  )).rows[0].report;
  assert(checkpoint.stage4Authorized === false, "La certificacion no puede autorizar Etapa 4.");
  assert(checkpoint.latestCertification?.status === "passed", "El certificado persistido no aparece en el checkpoint.");

  const report = {
    status: "passed",
    stage4Authorized: false,
    certificationId,
    runKey,
    fingerprint,
    archetypes: archetypes.length,
    capabilities: archetypes.reduce((sum, item) => sum + item.required_capabilities.length, 0),
    scenarioChecks: checks,
    contractViolations: violationCount,
    graph: graphEvidence,
    checkpoint,
    elapsedMs,
  };
  const outputDir = path.join(ROOT, "test-results");
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, "semantic-certification.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  try { await client.query("rollback"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
