import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, rm, writeFile } from "node:fs/promises";
import net, { type AddressInfo } from "node:net";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { AuthorizationService } from "./authorization-service.js";
import type { AuthorizationAction, ProtectedResource } from "./types.js";

interface Capability { hash: string; runId: string; agentId: string; expiresAt: number; credentialPath: string; requestIds: Set<string>; }
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export class AuthorizationBridge {
  private readonly capabilities = new Map<string, Capability>();
  private server: net.Server | null = null;
  private ready = false;
  private tcpPort: number | null = null;
  readonly socketPath: string;

  constructor(private readonly config: AppConfig, private readonly authorization: AuthorizationService) {
    this.socketPath = path.join(config.dataDirectory, "agent-passport.sock");
  }

  async start(): Promise<void> {
    if (this.config.runtimeProvider !== "container") await rm(this.socketPath, { force: true });
    this.server = net.createServer((socket) => this.handleConnection(socket));
    const listenOptions = this.config.runtimeProvider === "container"
      ? { port: 0, host: this.config.nodeEnv === "test" ? "127.0.0.1" : "0.0.0.0" }
      : { path: this.socketPath };
    await new Promise<void>((resolve, reject) => this.server!.once("error", reject).listen(listenOptions, resolve));
    if (this.config.runtimeProvider === "container") {
      const address = this.server.address();
      if (!address || typeof address === "string") throw new Error("Passport bridge did not expose a TCP port");
      this.tcpPort = (address as AddressInfo).port;
    } else {
      await chmod(this.socketPath, 0o600);
    }
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
    this.tcpPort = null;
    if (this.config.runtimeProvider !== "container") await rm(this.socketPath, { force: true });
  }

  isReady(): boolean { return this.ready; }

  async issue(runId: string, agentId: string, timeoutMs: number, credentialPath: string, resources: Array<Pick<ProtectedResource, "id" | "label" | "category" | "offerDescriptor">>) {
    const capability = randomBytes(32).toString("base64url");
    await writeFile(credentialPath, JSON.stringify({ capability }), { encoding: "utf8", mode: 0o600 });
    this.capabilities.set(runId, { hash: digest(capability), runId, agentId, expiresAt: Date.now() + timeoutMs + 30_000, credentialPath, requestIds: new Set() });
    return {
      ...(this.config.runtimeProvider === "container"
        ? { endpoint: { host: this.config.containerEngine.split(/[\\/]/).at(-1)?.toLowerCase() === "podman" ? "host.containers.internal" : "host.docker.internal", port: this.tcpPort ?? 0 } }
        : { socketPath: this.socketPath }),
      credentialPath,
      resources,
    };
  }

  revoke(runId: string): void { const entry = this.capabilities.get(runId); this.capabilities.delete(runId); if (entry) void rm(entry.credentialPath, { force: true }); }

  private async handle(input: string): Promise<unknown> {
    try {
      const request = JSON.parse(input) as { capability?: string; requestId?: string; agentId?: string; action?: AuthorizationAction; resourceId?: string; content?: string };
      const entry = [...this.capabilities.values()].find((item) => item.agentId === request.agentId && this.matches(item.hash, request.capability ?? "") && item.expiresAt > Date.now());
      if (!entry || !request.requestId || !/^[a-zA-Z0-9_-]{16,128}$/.test(request.requestId) || (request.action !== "read" && request.action !== "write") || !request.resourceId) return { allowed: false, reasonCode: "RUN_CAPABILITY_INVALID" };
      if (entry.requestIds.has(request.requestId)) return { allowed: false, reasonCode: "RUN_REQUEST_REPLAYED" };
      entry.requestIds.add(request.requestId);
      if (request.action === "write") return { allowed: false, reasonCode: "WRITE_NOT_SUPPORTED" };
      return this.authorization.read(entry.runId, entry.agentId, request.resourceId);
    } catch { return { allowed: false, reasonCode: "RUN_CAPABILITY_INVALID" }; }
  }

  private matches(expectedHash: string, capability: string): boolean {
    const expected = Buffer.from(expectedHash, "hex"); const actual = Buffer.from(digest(capability), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private handleConnection(socket: net.Socket): void {
    let input = "";
    let oversized = false;
    // A runtime may terminate the helper process before authorization finishes.
    // Socket errors are expected in that case and must not crash the server.
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 80_000) {
        oversized = true;
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (oversized) return;
      void this.handle(input).then((value) => {
        if (socket.destroyed || socket.writableEnded) return;
        socket.end(JSON.stringify(value) + "\n");
      }).catch(() => undefined);
    });
  }
}
