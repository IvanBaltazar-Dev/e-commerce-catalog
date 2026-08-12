import { createHash, randomUUID } from "node:crypto";

import neo4j, { type Driver, type ManagedTransaction } from "neo4j-driver";
import { Pool, type PoolClient } from "pg";
import QueryStream from "pg-query-stream";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  GraphEdgeProjection,
  GraphNodeProjection,
  GraphVerification,
} from "./contracts";

export const GRAPH_PROJECTOR_VERSION = "v2.1.0";
const DEFAULT_BATCH_SIZE = 1_000;
const MAX_DIFFERENCE_SAMPLES = 100;

export interface GraphProjectorOptions {
  supabase: SupabaseClient;
  postgres: Pool;
  driver: Driver;
  database?: string;
  batchSize?: number;
}

type GraphNodeRow = {
  key: string;
  kind: string;
  layer: string;
  label: string;
  properties: Record<string, unknown>;
  projectionFingerprint: string;
  projectionEpoch: string;
};

type GraphEdgeRow = {
  key: string;
  kind: string;
  layer: string;
  sourceKey: string;
  targetKey: string;
  properties: Record<string, unknown>;
  projectionFingerprint: string;
  projectionEpoch: string;
};

type ProjectionSummary = {
  nodes: number;
  edges: number;
  fingerprint: string;
};

function blankVerification(): GraphVerification {
  return {
    missingNodes: [],
    duplicateNodes: [],
    orphanNodes: [],
    missingEdges: [],
    duplicateEdges: [],
    orphanEdges: [],
    invalidReferences: [],
    staleProjectorNodes: [],
    staleProjectorEdges: [],
    unexpectedNodes: [],
    unexpectedEdges: [],
  };
}

function pushSample(target: string[], value: string) {
  if (target.length < MAX_DIFFERENCE_SAMPLES) target.push(value);
}

function safeProperties(properties: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(properties).map(([key, value]) => [
      key,
      value === null || ["string", "number", "boolean"].includes(typeof value)
        ? value
        : JSON.stringify(value),
    ]),
  );
}

function toNode(row: GraphNodeProjection, projectionEpoch: string): GraphNodeRow {
  return {
    key: row.node_key,
    kind: row.node_type,
    layer: row.layer,
    label: row.label,
    properties: safeProperties(row.properties),
    projectionFingerprint: row.projection_fingerprint,
    projectionEpoch,
  };
}

function toEdge(row: GraphEdgeProjection, projectionEpoch: string): GraphEdgeRow {
  return {
    key: row.edge_key,
    kind: row.predicate,
    layer: row.layer,
    sourceKey: row.source_key,
    targetKey: row.target_key,
    properties: safeProperties(row.properties),
    projectionFingerprint: row.projection_fingerprint,
    projectionEpoch,
  };
}

async function streamRows<T>(
  client: PoolClient,
  sql: string,
  batchSize: number,
  consume: (rows: T[]) => Promise<void>,
) {
  const stream = client.query(new QueryStream(sql, [], { batchSize }));
  let batch: T[] = [];
  for await (const row of stream) {
    batch.push(row as T);
    if (batch.length >= batchSize) {
      await consume(batch);
      batch = [];
    }
  }
  if (batch.length) await consume(batch);
}

async function ensureConstraints(transaction: ManagedTransaction) {
  await transaction.run(
    "CREATE CONSTRAINT catalog_entity_key IF NOT EXISTS FOR (n:CatalogEntity) REQUIRE n.key IS UNIQUE",
  );
  await transaction.run(
    "CREATE INDEX catalog_relation_key IF NOT EXISTS FOR ()-[r:CATALOG_RELATION]-() ON (r.key)",
  );
  await transaction.run(
    "CREATE INDEX catalog_entity_kind IF NOT EXISTS FOR (n:CatalogEntity) ON (n.kind)",
  );
  await transaction.run(
    "CREATE INDEX catalog_entity_layer IF NOT EXISTS FOR (n:CatalogEntity) ON (n.layer)",
  );
}

async function mergeNodeBatch(
  transaction: ManagedTransaction,
  rows: GraphNodeRow[],
  projectorVersion: string,
) {
  if (!rows.length) return;
  await transaction.run(
    `UNWIND $rows AS row
     MERGE (n:CatalogEntity {key: row.key})
     SET n.kind = row.kind,
         n.layer = row.layer,
         n.label = row.label,
         n.projectorVersion = $projectorVersion,
         n.projectionFingerprint = row.projectionFingerprint,
         n.projectionEpoch = row.projectionEpoch,
         n += row.properties
     SET n:$(row.kind)`,
    { rows, projectorVersion },
  );
}

async function mergeEdgeBatch(
  transaction: ManagedTransaction,
  rows: GraphEdgeRow[],
  projectorVersion: string,
) {
  if (!rows.length) return;
  await transaction.run(
    `UNWIND $rows AS row
     MATCH (source:CatalogEntity {key: row.sourceKey})
     MATCH (target:CatalogEntity {key: row.targetKey})
     MERGE (source)-[r:CATALOG_RELATION {key: row.key}]->(target)
     SET r.kind = row.kind,
         r.layer = row.layer,
         r.projectorVersion = $projectorVersion,
         r.projectionFingerprint = row.projectionFingerprint,
         r.projectionEpoch = row.projectionEpoch,
         r += row.properties`,
    { rows, projectorVersion },
  );
}

async function createProjectionRun(
  supabase: SupabaseClient,
  action: "status" | "sync" | "verify" | "rebuild",
) {
  const { data, error } = await supabase
    .from("catalog_graph_projection_runs")
    .insert({ action, projector_version: GRAPH_PROJECTOR_VERSION })
    .select("id")
    .single();
  if (error) throw new Error(`catalog_graph_projection_runs insert: ${error.message}`);
  return data.id as string;
}

async function finishProjectionRun(
  supabase: SupabaseClient,
  id: string,
  status: "succeeded" | "failed",
  data: {
    postgresFingerprint?: string;
    graphFingerprint?: string;
    counts?: Record<string, unknown>;
    errors?: unknown[];
    verification?: object;
  },
) {
  const { error } = await supabase
    .from("catalog_graph_projection_runs")
    .update({
      status,
      finished_at: new Date().toISOString(),
      postgres_fingerprint: data.postgresFingerprint ?? null,
      graph_fingerprint: data.graphFingerprint ?? null,
      counts: data.counts ?? {},
      errors: data.errors ?? [],
      verification: data.verification ?? {},
    })
    .eq("id", id);
  if (error) throw new Error(`catalog_graph_projection_runs update: ${error.message}`);
}

export function createGraphDriverFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const uri = env.NEO4J_URI;
  const user = env.NEO4J_USER;
  const password = env.NEO4J_PASSWORD;
  if (!uri || !user || !password) {
    throw new Error("NEO4J_URI, NEO4J_USER y NEO4J_PASSWORD son obligatorios.");
  }
  return neo4j.driver(uri, neo4j.auth.basic(user, password));
}

export function createPostgresPoolFromEnv(env: NodeJS.ProcessEnv = process.env) {
  if (!env.POSTGRES_URL) throw new Error("POSTGRES_URL es obligatorio para proyectar por streaming.");
  return new Pool({ connectionString: env.POSTGRES_URL, max: 3 });
}

export class GraphProjector {
  private readonly supabase: SupabaseClient;
  private readonly postgres: Pool;
  private readonly driver: Driver;
  private readonly database?: string;
  private readonly batchSize: number;

  constructor(options: GraphProjectorOptions) {
    this.supabase = options.supabase;
    this.postgres = options.postgres;
    this.driver = options.driver;
    this.database = options.database;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  private session() {
    return this.driver.session(this.database ? { database: this.database } : undefined);
  }

  private async streamExpected(
    projectionEpoch: string,
    consumers: {
      nodes?: (rows: GraphNodeRow[]) => Promise<void>;
      edges?: (rows: GraphEdgeRow[]) => Promise<void>;
    },
  ): Promise<ProjectionSummary> {
    const client = await this.postgres.connect();
    const hash = createHash("sha256");
    let nodes = 0;
    let edges = 0;
    try {
      await streamRows<GraphNodeProjection>(
        client,
        "select * from public.graph_nodes_v2 order by node_key",
        this.batchSize,
        async (batch) => {
          nodes += batch.length;
          for (const row of batch) hash.update(`n:${row.node_key}:${row.projection_fingerprint}\n`);
          if (consumers.nodes) await consumers.nodes(batch.map((row) => toNode(row, projectionEpoch)));
        },
      );
      await streamRows<GraphEdgeProjection>(
        client,
        "select * from public.graph_edges_v2 order by edge_key",
        this.batchSize,
        async (batch) => {
          edges += batch.length;
          for (const row of batch) hash.update(`e:${row.edge_key}:${row.projection_fingerprint}\n`);
          if (consumers.edges) await consumers.edges(batch.map((row) => toEdge(row, projectionEpoch)));
        },
      );
      return { nodes, edges, fingerprint: hash.digest("hex") };
    } finally {
      client.release();
    }
  }

  async status() {
    const session = this.session();
    try {
      await this.driver.verifyConnectivity();
      const result = await session.run(
        `OPTIONAL MATCH (n:CatalogEntity)
         WITH count(n) AS nodes, collect(DISTINCT n.projectorVersion) AS projectorVersions
         OPTIONAL MATCH ()-[r:CATALOG_RELATION]->()
         OPTIONAL MATCH (state:GraphProjectionState {key:'current'})
         RETURN nodes, count(DISTINCT r) AS edges, projectorVersions,
                state.projectorVersion AS currentVersion,
                state.sourceFingerprint AS sourceFingerprint,
                state.projectionEpoch AS projectionEpoch`,
      );
      const record = result.records[0];
      return {
        connected: true,
        nodes: record?.get("nodes")?.toNumber?.() ?? 0,
        edges: record?.get("edges")?.toNumber?.() ?? 0,
        projectorVersions: record?.get("projectorVersions") ?? [],
        currentVersion: record?.get("currentVersion") ?? null,
        sourceFingerprint: record?.get("sourceFingerprint") ?? null,
        projectionEpoch: record?.get("projectionEpoch") ?? null,
      };
    } finally {
      await session.close();
    }
  }

  private async project(action: "sync" | "rebuild") {
    const runId = await createProjectionRun(this.supabase, action);
    const projectionEpoch = randomUUID();
    const session = this.session();
    try {
      if (action === "rebuild") {
        await session.executeWrite(async (transaction) => {
          await transaction.run("MATCH (n:CatalogEntity) DETACH DELETE n");
          await transaction.run("MATCH (state:GraphProjectionState) DELETE state");
        });
      }
      await session.executeWrite(ensureConstraints);
      const summary = await this.streamExpected(projectionEpoch, {
        nodes: async (rows) => {
          await session.executeWrite((transaction) =>
            mergeNodeBatch(transaction, rows, GRAPH_PROJECTOR_VERSION),
          );
        },
        edges: async (rows) => {
          await session.executeWrite((transaction) =>
            mergeEdgeBatch(transaction, rows, GRAPH_PROJECTOR_VERSION),
          );
        },
      });

      await session.executeWrite(async (transaction) => {
        await transaction.run(
          `MATCH ()-[r:CATALOG_RELATION]->()
           WHERE r.projectionEpoch <> $projectionEpoch OR r.projectionEpoch IS NULL
           DELETE r`,
          { projectionEpoch },
        );
        await transaction.run(
          `MATCH (n:CatalogEntity)
           WHERE n.projectionEpoch <> $projectionEpoch OR n.projectionEpoch IS NULL
           DETACH DELETE n`,
          { projectionEpoch },
        );
        await transaction.run(
          `MERGE (state:GraphProjectionState {key:'current'})
           SET state.projectorVersion = $projectorVersion,
               state.sourceFingerprint = $sourceFingerprint,
               state.projectionEpoch = $projectionEpoch,
               state.nodeCount = $nodeCount,
               state.edgeCount = $edgeCount,
               state.projectedAt = datetime()`,
          {
            projectorVersion: GRAPH_PROJECTOR_VERSION,
            sourceFingerprint: summary.fingerprint,
            projectionEpoch,
            nodeCount: neo4j.int(summary.nodes),
            edgeCount: neo4j.int(summary.edges),
          },
        );
      });

      const verification = await this.verify(false);
      await finishProjectionRun(this.supabase, runId, "succeeded", {
        postgresFingerprint: summary.fingerprint,
        graphFingerprint: verification.graphFingerprint,
        counts: { nodes: summary.nodes, edges: summary.edges },
        verification: verification.differences,
      });
      return { nodes: summary.nodes, edges: summary.edges, ...verification };
    } catch (error) {
      await finishProjectionRun(this.supabase, runId, "failed", {
        errors: [error instanceof Error ? error.message : String(error)],
      });
      throw error;
    } finally {
      await session.close();
    }
  }

  async sync() {
    return this.project("sync");
  }

  async rebuild() {
    return this.project("rebuild");
  }

  async verify(persist = true) {
    const runId = persist ? await createProjectionRun(this.supabase, "verify") : null;
    const session = this.session();
    const differences = blankVerification();
    try {
      const stateResult = await session.run(
        `OPTIONAL MATCH (state:GraphProjectionState {key:'current'})
         OPTIONAL MATCH (n:CatalogEntity)
         WITH state, count(n) AS nodes
         OPTIONAL MATCH ()-[r:CATALOG_RELATION]->()
         RETURN state.sourceFingerprint AS sourceFingerprint,
                state.projectorVersion AS projectorVersion,
                state.projectionEpoch AS projectionEpoch,
                nodes, count(DISTINCT r) AS edges`,
      );
      const state = stateResult.records[0];
      const graphFingerprint = (state?.get("sourceFingerprint") as string | null) ?? "";
      const projectionEpoch = (state?.get("projectionEpoch") as string | null) ?? "verify-without-state";
      const graphNodes = state?.get("nodes")?.toNumber?.() ?? 0;
      const graphEdges = state?.get("edges")?.toNumber?.() ?? 0;

      const summary = await this.streamExpected(projectionEpoch, {
        nodes: async (rows) => {
          const result = await session.run(
            `UNWIND $rows AS row
             OPTIONAL MATCH (n:CatalogEntity {key:row.key})
             WITH row, n
             WHERE n IS NULL
                OR n.projectorVersion <> $projectorVersion
                OR n.projectionFingerprint <> row.projectionFingerprint
             RETURN row.key AS key, n IS NULL AS missing`,
            { rows, projectorVersion: GRAPH_PROJECTOR_VERSION },
          );
          for (const record of result.records) {
            const key = record.get("key") as string;
            if (record.get("missing")) pushSample(differences.missingNodes, key);
            else pushSample(differences.staleProjectorNodes, key);
          }
        },
        edges: async (rows) => {
          const result = await session.run(
            `UNWIND $rows AS row
             OPTIONAL MATCH ()-[r:CATALOG_RELATION {key:row.key}]->()
             WITH row, r
             WHERE r IS NULL
                OR r.projectorVersion <> $projectorVersion
                OR r.projectionFingerprint <> row.projectionFingerprint
             RETURN row.key AS key, r IS NULL AS missing`,
            { rows, projectorVersion: GRAPH_PROJECTOR_VERSION },
          );
          for (const record of result.records) {
            const key = record.get("key") as string;
            if (record.get("missing")) pushSample(differences.missingEdges, key);
            else pushSample(differences.staleProjectorEdges, key);
          }
        },
      });

      if (graphNodes > summary.nodes) pushSample(differences.unexpectedNodes, `<count:${graphNodes - summary.nodes}>`);
      if (graphEdges > summary.edges) pushSample(differences.unexpectedEdges, `<count:${graphEdges - summary.edges}>`);
      if (graphNodes < summary.nodes && !differences.missingNodes.length) {
        pushSample(differences.missingNodes, `<count:${summary.nodes - graphNodes}>`);
      }
      if (graphEdges < summary.edges && !differences.missingEdges.length) {
        pushSample(differences.missingEdges, `<count:${summary.edges - graphEdges}>`);
      }

      const duplicateNodes = await session.run(
        "MATCH (n:CatalogEntity) WITH n.key AS key, count(*) AS total WHERE total > 1 RETURN key LIMIT 100",
      );
      differences.duplicateNodes = duplicateNodes.records.map((record) => record.get("key") as string);
      const duplicateEdges = await session.run(
        "MATCH ()-[r:CATALOG_RELATION]->() WITH r.key AS key, count(*) AS total WHERE total > 1 RETURN key LIMIT 100",
      );
      differences.duplicateEdges = duplicateEdges.records.map((record) => record.get("key") as string);
      const oldNodes = await session.run(
        `MATCH (n:CatalogEntity)
         WHERE n.projectorVersion <> $version OR n.projectionEpoch <> $epoch
         RETURN n.key AS key LIMIT 100`,
        { version: GRAPH_PROJECTOR_VERSION, epoch: projectionEpoch },
      );
      for (const record of oldNodes.records) pushSample(differences.orphanNodes, record.get("key") as string);
      const oldEdges = await session.run(
        `MATCH ()-[r:CATALOG_RELATION]->()
         WHERE r.projectorVersion <> $version OR r.projectionEpoch <> $epoch
         RETURN r.key AS key LIMIT 100`,
        { version: GRAPH_PROJECTOR_VERSION, epoch: projectionEpoch },
      );
      for (const record of oldEdges.records) pushSample(differences.orphanEdges, record.get("key") as string);

      const pgClient = await this.postgres.connect();
      try {
        const invalid = await pgClient.query<{ edge_key: string }>(
          `select edge.edge_key
           from public.graph_edges_v2 edge
           left join public.graph_nodes_v2 source on source.node_key = edge.source_key
           left join public.graph_nodes_v2 target on target.node_key = edge.target_key
           where source.node_key is null or target.node_key is null
           limit 100`,
        );
        differences.invalidReferences = invalid.rows.map((row) => row.edge_key);
      } finally {
        pgClient.release();
      }

      const differenceCount = Object.values(differences).reduce((sum, values) => sum + values.length, 0);
      const ok =
        differenceCount === 0 &&
        graphNodes === summary.nodes &&
        graphEdges === summary.edges &&
        graphFingerprint === summary.fingerprint &&
        state?.get("projectorVersion") === GRAPH_PROJECTOR_VERSION;

      if (runId) {
        await finishProjectionRun(this.supabase, runId, "succeeded", {
          postgresFingerprint: summary.fingerprint,
          graphFingerprint,
          counts: { expectedNodes: summary.nodes, expectedEdges: summary.edges, graphNodes, graphEdges },
          verification: differences,
        });
      }
      return {
        ok,
        differenceCount,
        postgresFingerprint: summary.fingerprint,
        graphFingerprint,
        differences,
      };
    } catch (error) {
      if (runId) {
        await finishProjectionRun(this.supabase, runId, "failed", {
          errors: [error instanceof Error ? error.message : String(error)],
        });
      }
      throw error;
    } finally {
      await session.close();
    }
  }
}
