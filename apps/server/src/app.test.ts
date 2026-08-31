import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";
import type { AuthorizationService } from "./authorization-service.js";
import { HttpError } from "./errors.js";

const actor = {
  id: "00000000-0000-4000-8000-000000000001",
  username: "admin",
  role: "admin" as const,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
  sessionActor: async (token?: string) => {
    if (token !== "valid-session") throw new HttpError(401, "Authentication required");
    return actor;
  },
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token", cookie: "launchpad_session=valid-session" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", cookie: "launchpad_session=valid-session" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json", cookie: "launchpad_session=valid-session" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("accepts opaque legacy Agent IDs when creating protected resources", async () => {
    const authorization = {
      createResource: async (_actor: typeof actor, input: { sourceAgentId: string; category: string; label: string; description: string }) => ({
        id: "resource-legacy",
        ownerId: actor.id,
        ...input,
        sharingEligible: false,
        offerDescriptor: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      descriptor: (resource: Record<string, unknown>) => resource,
    } as unknown as AuthorizationService;
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service, authorization);
    const created = await app.inject({
      method: "POST",
      url: "/api/resources",
      headers: { "content-type": "application/json", cookie: "launchpad_session=valid-session" },
      payload: { category: "report", label: "Legacy", sourceAgentId: "agent-1", description: "Private" },
    });
    expect(created.statusCode).toBe(201);

    const invalid = await app.inject({
      method: "POST",
      url: "/api/resources",
      headers: { "content-type": "application/json", cookie: "launchpad_session=valid-session" },
      payload: { category: "report", label: "Invalid", sourceAgentId: "", description: "Private" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "Invalid request" });
    await app.close();
  });
});
