import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { AuthorizationService } from "./authorization-service.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";
import type { SharingEvaluator } from "./story-sharing-evaluator.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const runner: AgentRunner = { run: async () => ({ output: "done", threadId: null, usage: null }), cancel: async () => false, isAvailable: async () => true };

async function setup(name: string, env: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), name)); roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"), CODEX_HOME: path.join(root, "codex"), ...env });
  const store = new JsonStore(path.join(root, "data", "db.json")); const agents = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner); await agents.initialize();
  return { config, store, agents };
}

describe("AuthorizationService", () => {
  it.each([["fyp_user", "profile_user"], ["profile_user", "fyp_user"]])("shares from %s to %s only while permitted", async (ownerName, requesterName) => {
    const { config, store, agents } = await setup("launchpad-demo-", { CROSS_OWNER_SHARING_ENABLED: "true", RUNTIME_PROVIDER: "container" });
    const admin = (await agents.login("admin", "admin")).user;
    const owner = await agents.createUser(admin, ownerName, "demo-password");
    const requester = await agents.createUser(admin, requesterName, "demo-password");
    const source = await agents.createAgent(owner, { name: "Source" });
    const target = await agents.createAgent(requester, { name: "Reader" });
    await store.mutate((db) => {
      db.runs.push({ id: "demo-run", agentId: target.id, initiatingUserId: requester.id, status: "running", prompt: "Read the approved summary", output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: new Date().toISOString() });
      db.messages.push({ id: "source-message", agentId: source.id, runId: "source-run", role: "assistant", content: "Approved city: Singapore", createdAt: new Date().toISOString() });
    });
    let decision: boolean | null = true;
    let duringSummary: (() => Promise<unknown>) | undefined;
    const authorization = new AuthorizationService(config, store, { decide: async (input) => {
      expect(input.requester).toEqual({ userId: requester.id, username: requesterName, agentId: target.id });
      expect(input.resourceOwner.username).toBe(ownerName);
      return decision === null ? null : { allowed: decision, rationale: "Test policy decision" };
    } }, { summarize: async (input) => {
      expect(input.messages).toEqual(["Approved city: Singapore"]);
      await duringSummary?.();
      return { summary: "Singapore", reasonCode: "ALLOW" };
    } });
    const resource = await authorization.createResource(owner, { category: "report", label: "Approved summary", sourceAgentId: source.id, description: "City only", sharingEligible: false });
    expect(authorization.runtimeResourceDirectory(target.id)).toEqual([]);
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "SHARING_DISABLED" });
    await authorization.updateResource(owner, resource.id, { sharingEligible: true, offerDescriptor: "Approved city summary" });
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "NO_SHARING_POLICY" });
    const policy = await authorization.submitStoryPolicy(owner, "Allow approved summary reads");
    expect(authorization.runtimeResourceDirectory(target.id)).toEqual([expect.objectContaining({ id: resource.id })]);
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: true, resource: { summary: "Singapore" } });
    decision = false;
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "SHARING_POLICY_DENIED" });
    decision = null;
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "SHARING_DECISION_UNAVAILABLE" });
    decision = true;
    expect(await authorization.evaluate("demo-run", target.id, "write", resource.id)).toMatchObject({ allowed: false, reasonCode: "WRITE_NOT_SUPPORTED" });
    duringSummary = () => authorization.revokePolicy(owner, policy.id);
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "AUTHORIZATION_STATE_CHANGED" });
    expect(await authorization.read("demo-run", target.id, resource.id)).toMatchObject({ allowed: false, reasonCode: "NO_SHARING_POLICY" });
  });

  it("accepts a migrated non-UUID Agent ID as a resource source", async () => {
    const { config, store, agents } = await setup("launchpad-legacy-resource-");
    const admin = (await agents.login("admin", "admin")).user;
    const legacyAgent = await agents.createAgent(admin, { name: "Legacy" });
    await store.mutate((db) => {
      const persisted = db.agents.find((item) => item.id === legacyAgent.id);
      if (!persisted) throw new Error("Agent was not persisted");
      persisted.id = "agent-1";
    });
    const authorization = new AuthorizationService(config, store);
    await expect(authorization.createResource(admin, {
      category: "report",
      label: "Legacy report",
      sourceAgentId: "agent-1",
      description: "Migrated private chat",
    })).resolves.toMatchObject({ sourceAgentId: "agent-1" });
  });

  it("activates an owner-owned policy, enforces ownership, and revokes it", async () => {
    const { config, store, agents } = await setup("launchpad-policy-");
    const admin = (await agents.login("admin", "admin")).user; const alice = await agents.createUser(admin, "alice", "alice-password"); const bob = await agents.createUser(admin, "bob", "bob-password");
    const aliceAgent = await agents.createAgent(alice, { name: "Alice" }); const bobAgent = await agents.createAgent(bob, { name: "Bob" });
    await store.mutate((db) => db.runs.push({ id: "run-1", agentId: aliceAgent.id, initiatingUserId: alice.id, status: "running", prompt: "test", output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: new Date().toISOString() }));
    const authorization = new AuthorizationService(config, store);
    const aliceReport = await authorization.createResource(alice, { category: "report", label: "Alice report", sourceAgentId: aliceAgent.id, description: "Alice report" });
    const bobReport = await authorization.createResource(bob, { category: "report", label: "Bob report", sourceAgentId: bobAgent.id, description: "Bob report" });
    const policy = await authorization.submitStoryPolicy(alice, "Read my reports");
    expect(await authorization.evaluate("run-1", aliceAgent.id, "read", aliceReport.id)).toMatchObject({ allowed: true, reasonCode: "ALLOW" });
    expect(await authorization.evaluate("run-1", aliceAgent.id, "write", aliceReport.id)).toMatchObject({ allowed: false, reasonCode: "WRITE_NOT_SUPPORTED" });
    expect(await authorization.evaluate("run-1", aliceAgent.id, "read", bobReport.id)).toMatchObject({ allowed: false, reasonCode: "RESOURCE_OWNER_MISMATCH" });
    await authorization.revokePolicy(alice, policy.id);
    expect(await authorization.evaluate("run-1", aliceAgent.id, "read", aliceReport.id)).toMatchObject({ allowed: true, reasonCode: "ALLOW" });
  });

  it("stores free-text policy without calling an LLM", async () => {
    const { config, store, agents } = await setup("launchpad-free-policy-");
    const admin = (await agents.login("admin", "admin")).user; const alice = await agents.createUser(admin, "alice", "alice-password");
    const authorization = new AuthorizationService(config, store);
    const policy = await authorization.submitStoryPolicy(alice, "Share city-level recommendations with research Agents.");
    expect(policy).toMatchObject({ sourceText: "Share city-level recommendations with research Agents.", status: "active" });
  });

  it("asks Ark only at cross-owner read time", async () => {
    const { config, store, agents } = await setup("launchpad-sharing-", { CROSS_OWNER_SHARING_ENABLED: "true", RUNTIME_PROVIDER: "container" });
    const admin = (await agents.login("admin", "admin")).user; const alice = await agents.createUser(admin, "alice", "alice-password"); const bob = await agents.createUser(admin, "bob", "bob-password");
    const bobAgent = await agents.createAgent(bob, { name: "Bob Agent" }); await store.mutate((db) => db.runs.push({ id: "sharing-run", agentId: bobAgent.id, initiatingUserId: bob.id, status: "running", prompt: "test", output: null, error: null, usage: null, startedAt: null, completedAt: null, createdAt: new Date().toISOString() }));
    const evaluator: SharingEvaluator = { decide: async (input) => { expect(input.policyText).toContain("research"); expect(input.runPrompt).toBe("test"); expect(input.offerDescription).toContain("approved"); return { allowed: true, rationale: "The request matches the owner's sharing policy." }; } };
    const authorization = new AuthorizationService(config, store, evaluator); const aliceAgent = await agents.createAgent(alice, { name: "Alice Agent" });
    await authorization.submitStoryPolicy(alice, "Share city-level recommendations with research Agents.");
    const resource = await authorization.createResource(alice, { category: "report", label: "Alice report", sourceAgentId: aliceAgent.id, description: "Alice report", sharingEligible: true, offerDescriptor: "Alice report for approved collaboration" });
    expect(await authorization.evaluate("sharing-run", bobAgent.id, "read", resource.id)).toMatchObject({ allowed: true, reasonCode: "ALLOW" });
  });
});
