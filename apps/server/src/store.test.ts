import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("migrates v1 Agent data to the user-aware format", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(databasePath, JSON.stringify({
      version: 1,
      agents: [{ id: "agent-1", name: "Legacy" }],
      messages: [],
      runs: [],
    }));
    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({
      version: 9,
      agents: [{ id: "agent-1", ownerId: "", authorizationStatus: "active", sharingEligible: false }],
      users: [],
      sessions: [],
    });
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });

  it("disables sharing for resources migrated from version 5", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(databasePath, JSON.stringify({
      version: 5,
      agents: [], messages: [], runs: [], users: [], sessions: [], authorizationTemplates: [], authorizationDrafts: [], authorizationAssignments: [], authorizationDecisions: [], authorizationLifecycleEvents: [], accessOffers: [], crossOwnerGrants: [],
      protectedResources: [{ id: "resource-1", ownerId: "user-1", category: "report", label: "Legacy report", content: "private", sharingEligible: true, offerDescriptor: "legacy", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    }));
    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({ version: 9, protectedResources: [{ id: "resource-1", sharingEligible: false, offerDescriptor: "" }] });
  });

  it("requires legacy Agent owners to opt into sharing again", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(databasePath, JSON.stringify({
      version: 6,
      agents: [{ id: "agent-1", ownerId: "user-1", sharingEligible: true }], messages: [], runs: [], users: [], sessions: [], authorizationTemplates: [], authorizationDrafts: [], authorizationAssignments: [], protectedResources: [], authorizationDecisions: [], authorizationLifecycleEvents: [], accessOffers: [], crossOwnerGrants: [],
    }));
    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot()).toMatchObject({ version: 9, agents: [{ id: "agent-1", sharingEligible: false }] });
  });

  it("converts legacy assignments into owner-owned policies", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(databasePath, JSON.stringify({
      version: 8,
      agents: [], messages: [], runs: [], users: [], sessions: [], authorizationTemplates: [],
      authorizationDrafts: [{ id: "draft-1", ownerId: "user-1", sourceText: "Read my reports" }],
      authorizationAssignments: [{ id: "assignment-1", ownerId: "user-1", actions: ["read"], resourceCategories: ["report"], scope: "all_owner_agents", issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z", status: "active", revokedAt: null, draftId: "draft-1", createdAt: "2026-01-01T00:00:00.000Z" }],
      protectedResources: [], authorizationDecisions: [], authorizationLifecycleEvents: [], accessOffers: [], crossOwnerGrants: [],
    }));
    const store = new JsonStore(databasePath);
    await store.initialize();
    expect(store.snapshot()).toMatchObject({ version: 9, authorizationPolicies: [{ id: "assignment-1", ownerId: "user-1", sourceText: "Read my reports", status: "active" }] });
  });
});
