import { describe, it, expect } from "vitest";
import { validateLicense, formatUpgradePrompt } from "../src/license.js";

describe("JVM Diagnostics license validation", () => {
  it("returns free mode when no key", () => {
    const result = validateLicense(undefined, "jvm-diagnostics");
    expect(result.isPro).toBe(false);
    expect(result.reason).toBe("No license key provided");
  });

  it("returns free mode for empty string", () => {
    expect(validateLicense("", "jvm-diagnostics").isPro).toBe(false);
  });

  it("returns free mode for invalid key", () => {
    expect(validateLicense("MCPJBS-AAAAA-AAAAA-AAAAA-AAAAA", "jvm-diagnostics").isPro).toBe(false);
  });

  it("returns free mode for wrong prefix", () => {
    const result = validateLicense("WRONG-AAAAA-AAAAA-AAAAA-AAAAA", "jvm-diagnostics");
    expect(result.isPro).toBe(false);
    expect(result.reason).toContain("missing MCPJBS- prefix");
  });
});

describe("JVM Diagnostics upgrade prompts", () => {
  it("compare_heap_histos prompt includes tool name", () => {
    const prompt = formatUpgradePrompt("compare_heap_histos", "Heap comparison");
    expect(prompt).toContain("compare_heap_histos (Pro Feature)");
    expect(prompt).toContain("MCP_LICENSE_KEY");
  });

  it("diagnose_jvm prompt includes tool name", () => {
    const prompt = formatUpgradePrompt("diagnose_jvm", "Unified diagnosis");
    expect(prompt).toContain("diagnose_jvm (Pro Feature)");
    expect(prompt).toContain("mcpjbs.dev/pricing");
  });
});
