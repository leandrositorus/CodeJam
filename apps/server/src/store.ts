import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, Database, Message, AgentRun } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 9,
  agents: [],
  messages: [],
  runs: [],
  users: [],
  sessions: [],
  authorizationPolicies: [],
  protectedResources: [],
  authorizationDecisions: [],
  authorizationLifecycleEvents: [],
  accessOffers: [],
  crossOwnerGrants: [],
});

function migrateDatabase(parsed: unknown): Database {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Unsupported database format");
  }
  const candidate = parsed as {
    version?: number;
    agents?: unknown;
    messages?: unknown;
    runs?: unknown;
    users?: unknown;
    sessions?: unknown;
    authorizationPolicies?: unknown;
    authorizationDrafts?: unknown;
    authorizationAssignments?: unknown;
    protectedResources?: unknown;
    authorizationDecisions?: unknown;
    authorizationLifecycleEvents?: unknown;
    accessOffers?: unknown;
    crossOwnerGrants?: unknown;
  };
  if (candidate.version === 9 && Array.isArray(candidate.agents) && Array.isArray(candidate.users) && Array.isArray(candidate.sessions) && Array.isArray(candidate.messages) && Array.isArray(candidate.runs) && Array.isArray(candidate.authorizationPolicies) && Array.isArray(candidate.protectedResources) && Array.isArray(candidate.authorizationDecisions) && Array.isArray(candidate.authorizationLifecycleEvents) && Array.isArray(candidate.accessOffers) && Array.isArray(candidate.crossOwnerGrants)) {
    return candidate as Database;
  }
  if (!Array.isArray(candidate.agents) || !Array.isArray(candidate.messages) || !Array.isArray(candidate.runs)) throw new Error("Unsupported database format");
  const timestamp = new Date().toISOString();
  const legacyDrafts = Array.isArray(candidate.authorizationDrafts) ? candidate.authorizationDrafts as Array<{ id?: string; ownerId?: string; sourceText?: string }> : [];
  const policies = (Array.isArray(candidate.authorizationAssignments) ? candidate.authorizationAssignments : []).map((item) => {
    const assignment = item as { id: string; ownerId: string; issuedAt?: string; expiresAt?: string; status?: string; revokedAt?: string | null; draftId?: string; createdAt?: string };
    const draft = legacyDrafts.find((candidateDraft) => candidateDraft.id === assignment.draftId && candidateDraft.ownerId === assignment.ownerId);
    return { id: assignment.id, ownerId: assignment.ownerId, sourceText: draft?.sourceText ?? "Migrated authorization policy", status: assignment.status === "revoked" ? "revoked" : assignment.status === "superseded" ? "superseded" : "active", revokedAt: assignment.revokedAt ?? null, createdAt: assignment.createdAt ?? timestamp, updatedAt: timestamp };
  });
  return {
    version: 9,
    agents: candidate.agents.map((item) => ({ ...(item as Agent), ownerId: (item as Agent).ownerId ?? "", authorizationStatus: (item as Agent).authorizationStatus ?? "active", sharingEligible: (candidate.version ?? 0) < 8 ? false : (item as Agent).sharingEligible ?? false })),
    messages: candidate.messages as Message[],
    runs: candidate.runs.map((item) => ({ ...(item as AgentRun), initiatingUserId: (item as AgentRun).initiatingUserId ?? "" })),
    users: Array.isArray(candidate.users) ? candidate.users as Database["users"] : [],
    sessions: Array.isArray(candidate.sessions) ? candidate.sessions as Database["sessions"] : [],
    authorizationPolicies: policies as Database["authorizationPolicies"],
    protectedResources: (Array.isArray(candidate.protectedResources) ? candidate.protectedResources : []).map((item) => ({ ...(item as object), sourceAgentId: (item as { sourceAgentId?: string | null }).sourceAgentId ?? null, description: (item as { description?: string; content?: string }).description ?? (item as { content?: string }).content ?? "", sharingEligible: (candidate.version ?? 0) < 8 ? false : (item as { sharingEligible?: boolean }).sharingEligible ?? false, offerDescriptor: (candidate.version ?? 0) < 8 ? "" : (item as { offerDescriptor?: string }).offerDescriptor ?? "" })) as Database["protectedResources"],
    authorizationDecisions: (Array.isArray(candidate.authorizationDecisions) ? candidate.authorizationDecisions : []).map((item) => ({ ...(item as object), policyId: (item as { policyId?: string | null; assignmentId?: string | null }).policyId ?? (item as { assignmentId?: string | null }).assignmentId ?? null, legacyTemplateId: (item as { legacyTemplateId?: string | null; templateId?: string | null }).legacyTemplateId ?? (item as { templateId?: string | null }).templateId ?? null, executionResult: (item as { executionResult?: string }).executionResult ?? "not_attempted" })) as Database["authorizationDecisions"],
    authorizationLifecycleEvents: [],
    accessOffers: Array.isArray(candidate.accessOffers) ? candidate.accessOffers as Database["accessOffers"] : [],
    crossOwnerGrants: Array.isArray(candidate.crossOwnerGrants) ? candidate.crossOwnerGrants as Database["crossOwnerGrants"] : [],
  };
}

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.data = migrateDatabase(parsed);
      if ((parsed as { version?: number }).version !== 9) {
        await this.persist();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}
