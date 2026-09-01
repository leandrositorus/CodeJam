import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { expect, it } from "vitest";
import { AuthorizationBridge } from "./authorization-bridge.js";
import { AuthorizationService } from "./authorization-service.js";
import { loadConfig } from "./config.js";

it("returns asynchronous read results after the helper half-closes, and rejects replay", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "passport-bridge-"));
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: root, RUNTIME_PROVIDER: "container" });
  const authorization = { read: async () => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return { allowed: true, resource: { summary: "FYP brief" } };
  } } as unknown as AuthorizationService;
  const bridge = new AuthorizationBridge(config, authorization);
  try {
    await bridge.start();
    const credentialPath = path.join(root, "credential.json");
    const connection = await bridge.issue("run", "agent", 1000, credentialPath, []);
    const { capability } = JSON.parse(await readFile(credentialPath, "utf8"));
    const request = { capability, agentId: "agent", requestId: "request_1234567890", action: "read", resourceId: "fyp" };
    const send = () => new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: connection.endpoint!.port });
      let output = "";
      socket.setTimeout(2000, () => socket.destroy(new Error("Bridge response timed out")));
      socket.on("error", reject);
      socket.on("data", (chunk) => { output += chunk; });
      socket.on("end", () => resolve(output));
      socket.end(JSON.stringify(request));
    });
    expect(JSON.parse(await send())).toMatchObject({ allowed: true, resource: { summary: "FYP brief" } });
    expect(JSON.parse(await send())).toMatchObject({ allowed: false, reasonCode: "RUN_REQUEST_REPLAYED" });
  } finally {
    await bridge.close();
    await rm(root, { recursive: true, force: true });
  }
});
