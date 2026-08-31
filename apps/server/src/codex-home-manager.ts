import { chmod, copyFile, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { writeCodexConfig } from "./config.js";

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export class CodexHomeManager {
  private readonly agentsRoot: string;

  constructor(private readonly config: AppConfig) {
    this.agentsRoot = path.join(config.codexHome, "agents");
  }

  pathForAgent(agentId: string): string {
    return path.join(this.agentsRoot, agentId);
  }

  async initialize(): Promise<boolean> {
    await mkdir(this.config.codexHome, { recursive: true, mode: 0o700 });
    await chmod(this.config.codexHome, 0o700);
    await writeCodexConfig(this.config);
    await mkdir(this.agentsRoot, { recursive: true, mode: 0o700 });
    await chmod(this.agentsRoot, 0o700);
    return this.quarantineLegacySessions();
  }

  async provision(agentId: string): Promise<string> {
    const home = this.pathForAgent(agentId);
    await mkdir(home, { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await copyFile(path.join(this.config.codexHome, "config.toml"), path.join(home, "config.toml"));
    await chmod(path.join(home, "config.toml"), 0o600);
    return home;
  }

  async archive(agentId: string): Promise<string | null> {
    const source = this.pathForAgent(agentId);
    try {
      await stat(source);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const deletedRoot = path.join(this.config.codexHome, ".deleted");
    await mkdir(deletedRoot, { recursive: true, mode: 0o700 });
    const target = path.join(deletedRoot, agentId + "-" + new Date().toISOString().replace(/[:.]/g, "-"));
    await rename(source, target);
    return target;
  }

  private async quarantineLegacySessions(): Promise<boolean> {
    const source = path.join(this.config.codexHome, "sessions");
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isDirectory()) return false;
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    const quarantineRoot = path.join(this.config.dataDirectory, "legacy-codex-sessions");
    await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
    await chmod(quarantineRoot, 0o700);
    const target = path.join(quarantineRoot, new Date().toISOString().replace(/[:.]/g, "-"));
    try {
      await rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(source, target, { recursive: true, preserveTimestamps: true });
      await rm(source, { recursive: true, force: true });
    }
    await chmod(target, 0o700);
    return true;
  }
}
