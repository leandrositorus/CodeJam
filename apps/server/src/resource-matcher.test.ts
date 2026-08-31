import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { ArkResourceMatcher } from "./resource-matcher.js";

afterEach(() => vi.unstubAllGlobals());

describe("ArkResourceMatcher", () => {
  it("selects the best resource using only safe metadata", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(String(body.input)).toContain("FYP Content Brief");
      expect(String(body.input)).not.toContain("private chat content");
      return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ resourceId: "resource-fyp" }) }] }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "key", ARK_MODEL: "model" });
    const result = await new ArkResourceMatcher(config).match({
      prompt: "Get the local-food themes from the FYP Agent",
      agentName: "profile assistant",
      resources: [
        { id: "resource-private", label: "Profile City Summary", category: "report", offerDescriptor: "" },
        { id: "resource-fyp", label: "FYP Content Brief", category: "report", offerDescriptor: "Three local-food video themes" },
      ],
    });
    expect(result).toBe("resource-fyp");
  });

  it("rejects an Ark-selected ID that is not in the visible catalog", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ resourceId: "hidden-resource" }) }] }] }), { status: 200 })));
    const config = loadConfig({ NODE_ENV: "test", ARK_API_KEY: "key", ARK_MODEL: "model" });
    await expect(new ArkResourceMatcher(config).match({ prompt: "read it", agentName: "assistant", resources: [{ id: "visible", label: "Visible", category: "report" }] })).resolves.toBeNull();
  });
});
