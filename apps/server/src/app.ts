import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { AgentService } from "./agent-service.js";
import type { AuthorizationService } from "./authorization-service.js";
import type { AuthenticatedActor } from "./types.js";

// IDs are opaque strings at the API boundary. New records currently use UUIDs,
// but migrated v1 records may contain values such as "agent-1" or "run-1".
// Existence and ownership are enforced by the services after parsing.
const opaqueId = z.string().trim().min(1).max(256);
const agentIdParams = z.object({ id: opaqueId });
const runIdParams = z.object({ id: opaqueId });
const resourceIdParams = z.object({ id: opaqueId });
const policyIdParams = z.object({ id: opaqueId });
const createAgentBody = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  instructions: z.string().max(10_000).optional(),
});
const updateAgentBody = createAgentBody.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);
const messageBody = z.object({
  content: z.string().trim().min(1).max(50_000),
});
const credentialsBody = z.object({
  username: z.string().trim()
    .min(3, "Username must contain at least 3 characters.")
    .max(40, "Username must contain at most 40 characters.")
    .regex(/^[a-zA-Z0-9_.-]+$/, "Username may contain only letters, numbers, underscores, dots and hyphens. Use fyp_owner or profile_owner; spaces are not allowed."),
  password: z.string().min(1).max(256),
});
const userIdParams = z.object({ id: z.string().uuid() });
const sessionCookieName = "launchpad_session";
const resourceBody = z.object({ category: z.string().trim().min(1).max(48), label: z.string().trim().min(1).max(120), sourceAgentId: opaqueId, description: z.string().trim().min(1).max(2_000), sharingEligible: z.boolean().optional(), offerDescriptor: z.string().trim().max(500).optional() });
const resourceUpdateBody = resourceBody.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");
const storyPolicyBody = z.object({ sourceText: z.string().trim().min(1).max(8_000) });

function cookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  return cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(name + "="))?.slice(name.length + 1);
}

export async function createApp(
  config: AppConfig,
  service: AgentService,
  authorization?: AuthorizationService,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    bodyLimit: 1_048_576,
  });

  await app.register(cors, {
    origin:
      config.nodeEnv === "development"
        ? ["http://localhost:5173", "http://127.0.0.1:5173"]
        : false,
    credentials: true,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method) && request.headers.cookie && request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ error: "Cross-site request rejected" });
    }
    if (
      !config.authToken ||
      !request.url.startsWith("/api/") ||
      new URL(request.url, "http://localhost").pathname === "/api/health" ||
      new URL(request.url, "http://localhost").pathname === "/api/auth"
    ) {
      return;
    }
    const header = request.headers.authorization ?? "";
    const candidate = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expectedBuffer = Buffer.from(config.authToken);
    const candidateBuffer = Buffer.from(candidate);
    const valid =
      candidateBuffer.length === expectedBuffer.length &&
      timingSafeEqual(candidateBuffer, expectedBuffer);
    if (!valid) {
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "volc-agent-launchpad",
  }));

  app.get("/api/auth", async () => ({ required: config.authToken.length > 0 }));

  const requireActor = async (request: FastifyRequest): Promise<AuthenticatedActor> =>
    service.sessionActor(cookieValue(request.headers.cookie, sessionCookieName));
  const requireAuthorization = (): AuthorizationService => {
    if (!authorization) throw new HttpError(503, "Authorization service is unavailable");
    return authorization;
  };

  const sessionCookie = (token: string) =>
    sessionCookieName + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400" +
    (config.sessionCookieSecure ? "; Secure" : "");
  const clearSessionCookie = () =>
    sessionCookieName + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" +
    (config.sessionCookieSecure ? "; Secure" : "");

  app.post("/api/auth/login", async (request, reply) => {
    const body = credentialsBody.parse(request.body);
    const result = await service.login(body.username.toLowerCase(), body.password);
    reply.header("set-cookie", sessionCookie(result.sessionToken));
    return { user: result.user };
  });

  app.get("/api/auth/session", async (request) => ({ user: await requireActor(request) }));

  app.post("/api/auth/logout", async (request, reply) => {
    await service.logout(cookieValue(request.headers.cookie, sessionCookieName));
    reply.header("set-cookie", clearSessionCookie());
    return { ok: true };
  });

  app.get("/api/system", async () => service.systemInfo());

  app.get("/api/agents", async (request) => {
    const actor = await requireActor(request);
    return { agents: service.listAgents(actor) };
  });

  app.post("/api/agents", async (request, reply) => {
    const actor = await requireActor(request);
    const body = createAgentBody.parse(request.body);
    const agent = await service.createAgent(actor, body);
    return reply.code(201).send({ agent });
  });

  app.get("/api/agents/:id", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return { agent: service.getAgent(id, actor) };
  });

  app.patch("/api/agents/:id", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    const body = updateAgentBody.parse(request.body);
    return { agent: await service.updateAgent(actor, id, body) };
  });

  app.delete("/api/agents/:id", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return service.deleteAgent(actor, id);
  });

  app.post("/api/agents/:id/start", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.startAgent(actor, id) };
  });

  app.post("/api/agents/:id/stop", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return { agent: await service.stopAgent(actor, id) };
  });

  app.get("/api/agents/:id/messages", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return { messages: service.getMessages(actor, id) };
  });

  app.get("/api/agents/:id/runs", async (request) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    return { runs: service.getRuns(actor, id) };
  });

  app.post("/api/agents/:id/messages", async (request, reply) => {
    const actor = await requireActor(request);
    const { id } = agentIdParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const result = await service.sendMessage(actor, id, body.content);
    return reply.code(202).send(result);
  });

  app.get("/api/runs/:id", async (request) => {
    const actor = await requireActor(request);
    const { id } = runIdParams.parse(request.params);
    return { run: service.getRun(actor, id) };
  });

  app.get("/api/users", async (request) => {
    const actor = await requireActor(request);
    return { users: service.listUsers(actor) };
  });

  app.post("/api/users", async (request, reply) => {
    const actor = await requireActor(request);
    const body = credentialsBody.parse(request.body);
    const user = await service.createUser(actor, body.username.toLowerCase(), body.password);
    return reply.code(201).send({ user });
  });

  app.post("/api/users/:id/password", async (request) => {
    const actor = await requireActor(request);
    const { id } = userIdParams.parse(request.params);
    const body = z.object({ password: credentialsBody.shape.password }).parse(request.body);
    return { user: await service.resetUserPassword(actor, id, body.password) };
  });

  app.get("/api/resources", async (request) => ({ resources: requireAuthorization().listResources(await requireActor(request)) }));
  app.get("/api/admin/resources", async (request) => ({ resources: requireAuthorization().listResourceInventory(await requireActor(request)) }));
  app.post("/api/resources", async (request, reply) => { const service = requireAuthorization(); const resource = await service.createResource(await requireActor(request), resourceBody.parse(request.body)); return reply.code(201).send({ resource: service.descriptor(resource) }); });
  app.get("/api/resources/:id", async (request) => ({ resource: requireAuthorization().getResource(await requireActor(request), resourceIdParams.parse(request.params).id) }));
  app.patch("/api/resources/:id", async (request) => { const service = requireAuthorization(); const resource = await service.updateResource(await requireActor(request), resourceIdParams.parse(request.params).id, resourceUpdateBody.parse(request.body)); return { resource: service.descriptor(resource) }; });
  app.delete("/api/resources/:id", async (request, reply) => { await requireAuthorization().deleteResource(await requireActor(request), resourceIdParams.parse(request.params).id); return reply.code(204).send(); });
  app.get("/api/authorization/policy", async (request) => ({ policy: requireAuthorization().policy(await requireActor(request)) }));
  app.put("/api/authorization/policy", async (request) => {
    const body = storyPolicyBody.parse(request.body);
    return { policy: await requireAuthorization().submitStoryPolicy(await requireActor(request), body.sourceText) };
  });
  app.post("/api/authorization/policy/:id/revoke", async (request) => ({ policy: await requireAuthorization().revokePolicy(await requireActor(request), policyIdParams.parse(request.params).id) }));
  app.post("/api/agents/:id/authorization/:operation", async (request) => {
    const params = z.object({ id: opaqueId, operation: z.enum(["enable", "disable"]) }).parse(request.params);
    return { agent: await requireAuthorization().setAgentStatus(await requireActor(request), params.id, params.operation === "enable" ? "active" : "disabled") };
  });
  app.get("/api/runs/:id/authorization-decisions", async (request) => ({ decisions: requireAuthorization().decisions(await requireActor(request), runIdParams.parse(request.params).id) }));

  if (config.nodeEnv === "production") {
    const webRoot = fileURLToPath(new URL("../../web/dist", import.meta.url));
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof Error ? error : new Error(String(error));
    // Zod errors can cross package/runtime boundaries in development, so use
    // their stable `issues` shape as a fallback to the instanceof check.
    const candidateIssues = error && typeof error === "object"
      ? (error as { issues?: unknown }).issues
      : undefined;
    const issues = error instanceof z.ZodError
      ? error.issues
      : Array.isArray(candidateIssues)
        ? candidateIssues as z.ZodIssue[]
        : null;
    const validationError = issues !== null;
    const frameworkStatus =
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : null;
    const statusCode =
      error instanceof HttpError
        ? error.statusCode
        : validationError
          ? 400
          : frameworkStatus && frameworkStatus >= 400 && frameworkStatus <= 599
            ? frameworkStatus
            : 500;
    if (statusCode >= 500) {
      request.log.error(appError);
    }
    return reply.code(statusCode).send({
      error: validationError ? "Invalid request" : appError.message,
      ...(validationError ? { details: issues } : {}),
    });
  });

  return app;
}
