import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexHomeManager } from "./codex-home-manager.js";
import { loadConfig } from "./config.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function managerForTest() {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(tmpdir(), "launchpad-codex-home-"));
  roots.push(root);
  const config = loadConfig({ NODE_ENV: "test", APP_DATA_DIR: path.join(root, "data"), CODEX_HOME: path.join(root, "codex-home") });
  return { root, config, manager: new CodexHomeManager(config) };
}

describe("CodexHomeManager", () => {
  it("requires containers before enabling cross-owner sharing", () => {
    expect(() => loadConfig({ NODE_ENV: "test", CROSS_OWNER_SHARING_ENABLED: "true", RUNTIME_PROVIDER: "local-process" })).toThrow("requires RUNTIME_PROVIDER=container");
    expect(() => loadConfig({ NODE_ENV: "test", CROSS_OWNER_SHARING_ENABLED: "true", RUNTIME_PROVIDER: "container" })).not.toThrow();
  });

  it("creates isolated persistent homes for each Agent", async () => {
    const { manager } = await managerForTest();
    await manager.initialize();
    const aliceHome = await manager.provision("agent-alice");
    const bobHome = await manager.provision("agent-bob");
    await mkdir(path.join(aliceHome, "sessions"));
    await writeFile(path.join(aliceHome, "sessions", "alice.jsonl"), "private session");

    await expect(readFile(path.join(bobHome, "sessions", "alice.jsonl"), "utf8")).rejects.toThrow();
    expect(aliceHome).not.toBe(bobHome);
    await expect(access(path.join(aliceHome, "config.toml"))).resolves.toBeUndefined();
    await expect(access(path.join(bobHome, "config.toml"))).resolves.toBeUndefined();
  });

  it("quarantines legacy shared sessions outside the Agent-visible root", async () => {
    const { config, manager } = await managerForTest();
    await mkdir(path.join(config.codexHome, "sessions"), { recursive: true });
    await writeFile(path.join(config.codexHome, "sessions", "legacy.jsonl"), "legacy private session");

    expect(await manager.initialize()).toBe(true);
    await expect(access(path.join(config.codexHome, "sessions"))).rejects.toThrow();
    const quarantines = await readdir(path.join(config.dataDirectory, "legacy-codex-sessions"));
    expect(quarantines).toHaveLength(1);
    await expect(readFile(path.join(config.dataDirectory, "legacy-codex-sessions", quarantines[0]!, "legacy.jsonl"), "utf8")).resolves.toBe("legacy private session");
  });
});
