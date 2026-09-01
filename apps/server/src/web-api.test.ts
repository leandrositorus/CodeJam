import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("web API error reporting", () => {
  it("shows safe validation messages instead of only Invalid request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Invalid request",
      details: [{ message: "Username cannot contain spaces." }, null, { message: 42 }],
    }), { status: 400 })));
    await expect(api.createUser("FYP Owner", "test-password"))
      .rejects.toThrow("Username cannot contain spaces.");
  });

  it("preserves non-validation errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: "Username already exists",
    }), { status: 409 })));
    await expect(api.createUser("fyp_owner", "test-password"))
      .rejects.toThrow("Username already exists");
  });
});
