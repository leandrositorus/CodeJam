import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";
import { AuthorizationService } from "./authorization-service.js";
import { AuthorizationBridge } from "./authorization-bridge.js";
import { ArkResourceMatcher } from "./resource-matcher.js";

const config = loadConfig();

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const authorization = new AuthorizationService(config, store);
const authorizationBridge = new AuthorizationBridge(config, authorization);
const resourceMatcher = new ArkResourceMatcher(config);
const service = new AgentService(config, store, workspaces, runner, authorization, authorizationBridge, undefined, resourceMatcher);
await service.initialize();
await authorizationBridge.start();

const app = await createApp(config, service, authorization);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  await authorizationBridge.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
