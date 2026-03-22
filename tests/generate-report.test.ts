import { access, readFile } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { generateKey, PRODUCTS } from "@mcp-java-suite/license";

import {
  analyzeThreadDumpMarkdown,
  generateReportFromThreadDump,
  MISSING_ENV_LICENSE_ERROR,
  MISSING_THREAD_DUMP_ERROR,
} from "../src/reporting.js";

const SAMPLE_THREAD_DUMP = `
2026-03-22 10:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"main" #1 prio=5 os_prio=0 cpu=100.00ms elapsed=10.00s tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)

"worker-1" #30 daemon prio=5 os_prio=0 cpu=200.00ms elapsed=9.00s tid=0x00007f1234567899 nid=0x1e runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Worker.run(Worker.java:15)
`;

const originalHmacSecret = process.env.MCP_LICENSE_HMAC_SECRET;
const originalLicenseKey = process.env.MCP_LICENSE_KEY;

function createValidJvmLicense(customerId = 12345): string {
  const expiryDate = new Date();
  expiryDate.setFullYear(expiryDate.getFullYear() + 1);

  return generateKey({
    productMask: 1 << PRODUCTS["jvm-diagnostics"],
    expiryDate,
    customerId,
  });
}

describe("generate_report flow", () => {
  beforeEach(() => {
    process.env.MCP_LICENSE_HMAC_SECRET = "test-secret-for-generate-report";
    delete process.env.MCP_LICENSE_KEY;
  });

  afterEach(() => {
    if (originalHmacSecret === undefined) {
      delete process.env.MCP_LICENSE_HMAC_SECRET;
    } else {
      process.env.MCP_LICENSE_HMAC_SECRET = originalHmacSecret;
    }

    if (originalLicenseKey === undefined) {
      delete process.env.MCP_LICENSE_KEY;
    } else {
      process.env.MCP_LICENSE_KEY = originalLicenseKey;
    }
  });

  it("generates HTML and PDF when the configured and provided license keys are valid", async () => {
    const licenseKey = createValidJvmLicense();
    process.env.MCP_LICENSE_KEY = licenseKey;

    const result = await generateReportFromThreadDump({
      licenseKey,
      threadDump: SAMPLE_THREAD_DUMP,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }

    await expect(access(result.htmlPath)).resolves.toBeUndefined();
    await expect(access(result.pdfPath)).resolves.toBeUndefined();

    const html = await readFile(result.htmlPath, "utf8");
    const pdf = await readFile(result.pdfPath);

    expect(html).toContain("MCP JVM Diagnostics Pro");
    expect(html).toContain("Thread Dump Analysis");
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });

  it("rejects an invalid provided license key without crashing", async () => {
    process.env.MCP_LICENSE_KEY = createValidJvmLicense();

    const result = await generateReportFromThreadDump({
      licenseKey: "MCPJBS-INVALID-AAAAA-BBBBB-CCCCC",
      threadDump: SAMPLE_THREAD_DUMP,
    });

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Provided license_key is invalid"),
    });
  });

  it("returns a clear error when MCP_LICENSE_KEY is missing and free analysis still works", async () => {
    const providedKey = createValidJvmLicense();

    const result = await generateReportFromThreadDump({
      licenseKey: providedKey,
      threadDump: SAMPLE_THREAD_DUMP,
    });

    expect(result).toEqual({
      ok: false,
      error: MISSING_ENV_LICENSE_ERROR,
    });

    const markdown = analyzeThreadDumpMarkdown(SAMPLE_THREAD_DUMP);
    expect(markdown).toContain("## Thread Dump Analysis");
  });

  it("returns a validation error when thread_dump is missing", async () => {
    const licenseKey = createValidJvmLicense();
    process.env.MCP_LICENSE_KEY = licenseKey;

    const result = await generateReportFromThreadDump({
      licenseKey,
      threadDump: "",
    });

    expect(result).toEqual({
      ok: false,
      error: MISSING_THREAD_DUMP_ERROR,
    });
  });
});
