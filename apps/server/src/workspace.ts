import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await this.writeAuthorizationTool(agent.workspacePath);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "- Launchpad automatically matches requests to visible protected resources and adds an internal Passport read instruction when appropriate. If you need to inspect available resources, use `node .agent-passport.mjs list`, then read the matching item with `node .agent-passport.mjs read <resource-id>`. Use actual Passport results and never invent protected data or claim the bridge is unavailable without a command error. Same-owner reads are deterministic; cross-owner reads are checked by Ark at request time. Do not inspect authorization environment variables.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  async writeAuthorizationContext(workspacePath: string, resources: Array<{ id: string; label: string; category: string; offerDescriptor?: string }>): Promise<void> {
    await writeFile(path.join(workspacePath, ".agent-passport-resources.json"), JSON.stringify(resources, null, 2) + "\n", "utf8");
  }

  authorizationCredentialPath(workspacePath: string, runId: string): string {
    return path.join(workspacePath, ".agent-passport-" + runId + ".json");
  }

  async writeAuthorizationTool(workspacePath: string): Promise<void> {
    const script = [
      "import net from 'node:net'; import { randomBytes } from 'node:crypto'; import { readFile } from 'node:fs/promises';",
      "const [action, resourceId, ...rest] = process.argv.slice(2);",
      "if (action === 'list') { try { process.stdout.write(await readFile('.agent-passport-resources.json', 'utf8')); } catch { process.stdout.write('[]\\n'); } process.exit(0); }",
      "if ((!process.env.AGENT_PASSPORT_SOCKET && !(process.env.AGENT_PASSPORT_HOST && process.env.AGENT_PASSPORT_PORT)) || !process.env.AGENT_PASSPORT_CREDENTIAL_PATH || !process.env.AGENT_PASSPORT_AGENT_ID) throw new Error('PASSPORT_BRIDGE_UNAVAILABLE: Passport is available only during an active Launchpad Agent Run.');",
      "let credential; try { credential = JSON.parse(await readFile(process.env.AGENT_PASSPORT_CREDENTIAL_PATH, 'utf8')); } catch { throw new Error('PASSPORT_BRIDGE_UNAVAILABLE: Run credential is unavailable or expired.'); }",
      "const request = { capability: credential.capability, requestId: randomBytes(16).toString('base64url'), agentId: process.env.AGENT_PASSPORT_AGENT_ID, action, resourceId, ...(action === 'write' ? { content: rest.join(' ') } : {}) };",
      "const socket = process.env.AGENT_PASSPORT_HOST ? net.createConnection({ host: process.env.AGENT_PASSPORT_HOST, port: Number(process.env.AGENT_PASSPORT_PORT) }) : net.createConnection(process.env.AGENT_PASSPORT_SOCKET);",
      "let output = ''; socket.on('data', (chunk) => output += chunk); socket.on('end', () => process.stdout.write(output));",
      "socket.on('error', (error) => { const message = error.code === 'ECONNREFUSED' ? 'PASSPORT_BRIDGE_UNAVAILABLE: Launchpad Passport bridge is not accepting connections for this Run.' : error.message; process.stderr.write(message); process.exitCode = 1; });",
      "socket.end(JSON.stringify(request));",
      "",
    ].join("\n");
    await writeFile(path.join(workspacePath, ".agent-passport.mjs"), script, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
