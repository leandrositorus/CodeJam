import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { JsonStore } from "./store.js";
import type { AgentRunner } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runner: AgentRunner = {
  run: async () => ({ output: "done", threadId: null, usage: null }),
  cancel: async () => false,
  isAvailable: async () => true,
};

async function makeApp(authToken = "", overrides: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-auth-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    APP_AUTH_TOKEN: authToken || undefined,
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ...overrides,
  });
  const store = new JsonStore(path.join(root, "data", "db.json"));
  const service = new AgentService(config, store, new WorkspaceManager(config.workspaceRoot), runner);
  await service.initialize();
  return { app: await createApp(config, service), store };
}

function sessionCookie(response: { headers: Record<string, string | string[] | undefined> }): string {
  const value = response.headers["set-cookie"];
  const first = Array.isArray(value) ? value[0] : value;
  if (!first) throw new Error("Expected a session cookie");
  return first.split(";", 1)[0]!;
}

describe("password authentication", () => {
  it("uses the explicit cookie security setting", async () => {
    const insecure = await makeApp();
    const insecureLogin = await insecure.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin" },
    });
    expect(insecureLogin.headers["set-cookie"]).not.toContain("Secure");
    await insecure.app.close();

    const secure = await makeApp("", { APP_SESSION_COOKIE_SECURE: "true" });
    const secureLogin = await secure.app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin" },
    });
    const cookie = sessionCookie(secureLogin);
    expect(secureLogin.headers["set-cookie"]).toContain("Secure");
    const logout = await secure.app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie },
    });
    expect(logout.headers["set-cookie"]).toContain("Secure");
    await secure.app.close();
  });

  it("seeds a hashed admin account, signs in, and revokes its session on logout", async () => {
    const { app, store } = await makeApp();
    const seeded = store.snapshot().users[0];
    expect(seeded).toMatchObject({ username: "admin", role: "admin" });
    expect(seeded?.passwordHash).not.toBe("admin");

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "admin" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ user: expect.objectContaining({ username: "admin", role: "admin" }) });
    expect(login.body).not.toContain("passwordHash");
    const cookie = sessionCookie(login);
    expect(cookie).not.toContain("admin");

    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } });
    expect(session.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/agents" })).statusCode).toBe(401);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers["set-cookie"]).toContain("Max-Age=0");
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(401);
    await app.close();
  });

  it("requires the outer token before password login when configured", async () => {
    const { app } = await makeApp("a-strong-test-token");
    const body = { username: "admin", password: "admin" };
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: body })).statusCode).toBe(401);

    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { authorization: "Bearer a-strong-test-token" },
      payload: body,
    });
    const cookie = sessionCookie(login);
    expect(login.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie } })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET",
      url: "/api/auth/session",
      headers: { cookie, authorization: "Bearer a-strong-test-token" },
    })).statusCode).toBe(200);
    await app.close();
  });

  it("lets admins create users and keeps their Agents private", async () => {
    const { app } = await makeApp();
    const adminLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
    const adminCookie = sessionCookie(adminLogin);
    const created = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie: adminCookie },
      payload: { username: "alice", password: "alice-password" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain("password");
    const aliceId = (created.json().user as { id: string }).id;

    const aliceLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } });
    const aliceCookie = sessionCookie(aliceLogin);
    expect((await app.inject({ method: "GET", url: "/api/users", headers: { cookie: aliceCookie } })).statusCode).toBe(403);
    expect((await app.inject({
      method: "POST",
      url: "/api/users/" + aliceId + "/password",
      headers: { cookie: adminCookie },
      payload: { password: "new-alice-password" },
    })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/auth/session", headers: { cookie: aliceCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "alice-password" } })).statusCode).toBe(401);
    const refreshedAliceLogin = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "alice", password: "new-alice-password" } });
    const refreshedAliceCookie = sessionCookie(refreshedAliceLogin);
    const agentResponse = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie: refreshedAliceCookie },
      payload: { name: "Alice's agent" },
    });
    const agent = agentResponse.json().agent as { id: string; ownerId: string };
    expect(agentResponse.statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: "/api/agents", headers: { cookie: refreshedAliceCookie } })).json().agents).toHaveLength(1);
    expect((await app.inject({ method: "GET", url: "/api/agents/" + agent.id, headers: { cookie: adminCookie } })).statusCode).toBe(200);
    await app.close();
  });
});
