import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  generateDiagnosticPdf,
  maskLicenseKey,
  renderDiagnosticReport,
  validateLicense,
  type LicenseInfo,
} from "@mcp-java-suite/license";

import { analyzeContention } from "./analyzers/contention.js";
import { detectDeadlocks } from "./analyzers/deadlock.js";
import { parseThreadDump } from "./parsers/thread-dump.js";

const PRODUCT_NAME = "jvm-diagnostics";
const TOOL_VERSION = "0.1.7";

export const MISSING_LICENSE_INPUT_ERROR =
  "Missing required input: license_key";
export const MISSING_THREAD_DUMP_ERROR =
  "Missing required input: thread_dump";
export const MISSING_ENV_LICENSE_ERROR =
  "MCP_LICENSE_KEY environment variable is not set. generate_report requires a valid Pro license key. Free-tier analysis tools remain available without it.";

export interface GenerateReportParams {
  licenseKey: string;
  threadDump: string;
  outputDir?: string;
}

export interface GenerateReportSuccess {
  ok: true;
  htmlPath: string;
  pdfPath: string;
  customerId: number | null;
}

export interface GenerateReportFailure {
  ok: false;
  error: string;
}

export type GenerateReportResult =
  | GenerateReportSuccess
  | GenerateReportFailure;

function isGenerateReportFailure(
  result: GenerateReportFailure | LicenseInfo
): result is GenerateReportFailure {
  return "ok" in result && result.ok === false;
}

export function analyzeThreadDumpMarkdown(threadDump: string): string {
  const parsed = parseThreadDump(threadDump);
  const deadlocks = detectDeadlocks(parsed.threads);
  const contention = analyzeContention(parsed.threads);

  const sections: string[] = [];

  sections.push("## Thread Dump Analysis");
  sections.push(`\n- **JVM**: ${parsed.jvmInfo || "Unknown"}`);
  sections.push(`- **Timestamp**: ${parsed.timestamp || "Unknown"}`);
  sections.push(`- **Total threads**: ${parsed.threads.length}`);

  const stateCounts = new Map<string, number>();
  for (const thread of parsed.threads) {
    stateCounts.set(thread.state, (stateCounts.get(thread.state) || 0) + 1);
  }

  const canonicalStates = [
    "RUNNABLE",
    "WAITING",
    "TIMED_WAITING",
    "BLOCKED",
    "NEW",
    "TERMINATED",
  ];
  for (const state of canonicalStates) {
    if (!stateCounts.has(state)) {
      stateCounts.set(state, 0);
    }
  }

  const total = parsed.threads.length;
  const maxCount = Math.max(...stateCounts.values(), 1);
  const barMaxWidth = 20;

  sections.push("\n### Thread State Summary");
  sections.push("| State | Count | % | Histogram |");
  sections.push("|-------|------:|--:|-----------|");

  const sortedStates = [...stateCounts.entries()].sort((a, b) => {
    if (a[1] !== b[1]) {
      return b[1] - a[1];
    }
    return canonicalStates.indexOf(a[0]) - canonicalStates.indexOf(b[0]);
  });

  for (const [state, count] of sortedStates) {
    const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
    const barLength = Math.round((count / maxCount) * barMaxWidth);
    const bar = "\u2588".repeat(barLength);
    sections.push(`| ${state} | ${count} | ${percentage} | \`${bar}\` |`);
  }

  if (deadlocks.length > 0) {
    sections.push(`\n### Deadlocks Detected (${deadlocks.length})`);
    for (const deadlock of deadlocks) {
      sections.push(`\n**Deadlock cycle** (${deadlock.threads.length} threads):`);
      for (const thread of deadlock.threads) {
        sections.push(
          `- **${thread.name}** holds \`${thread.holdsLock}\`, waiting for \`${thread.waitingOn}\``
        );
      }
      sections.push(`\n**Resolution**: ${deadlock.recommendation}`);
    }
  } else {
    sections.push("\n### Deadlocks: None detected");
  }

  if (contention.hotspots.length > 0) {
    sections.push("\n### Lock Contention Hotspots");
    sections.push("| Lock | Blocked Threads | Holder |");
    sections.push("|------|----------------|--------|");
    for (const hotspot of contention.hotspots) {
      sections.push(
        `| \`${hotspot.lock}\` | ${hotspot.blockedCount} | ${hotspot.holderThread} |`
      );
    }
    if (contention.recommendations.length > 0) {
      sections.push("\n### Recommendations");
      for (const recommendation of contention.recommendations) {
        sections.push(`- ${recommendation}`);
      }
    }
  }

  const daemonCount = parsed.threads.filter((thread) => thread.isDaemon).length;
  sections.push("\n### Thread Classification");
  sections.push(`- Daemon threads: ${daemonCount}`);
  sections.push(`- Non-daemon threads: ${parsed.threads.length - daemonCount}`);

  return sections.join("\n");
}

function validateConfiguredLicense(): GenerateReportFailure | LicenseInfo {
  const configuredKey = process.env.MCP_LICENSE_KEY;
  if (!configuredKey || configuredKey.trim().length === 0) {
    return { ok: false, error: MISSING_ENV_LICENSE_ERROR };
  }

  return validateProLicense(configuredKey, "Configured MCP_LICENSE_KEY");
}

function validateProLicense(
  key: string,
  label: "Configured MCP_LICENSE_KEY" | "Provided license_key"
): GenerateReportFailure | LicenseInfo {
  try {
    const license = validateLicense(key, PRODUCT_NAME);
    if (!license.isPro) {
      return {
        ok: false,
        error: `${label} is invalid: ${license.reason}`,
      };
    }
    return license;
  } catch (error) {
    return {
      ok: false,
      error: `License validation unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

export async function generateReportFromThreadDump(
  params: GenerateReportParams
): Promise<GenerateReportResult> {
  if (!params.licenseKey || params.licenseKey.trim().length === 0) {
    return { ok: false, error: MISSING_LICENSE_INPUT_ERROR };
  }

  if (!params.threadDump || params.threadDump.trim().length === 0) {
    return { ok: false, error: MISSING_THREAD_DUMP_ERROR };
  }

  const configuredLicense = validateConfiguredLicense();
  if (isGenerateReportFailure(configuredLicense)) {
    return configuredLicense;
  }

  const providedLicense = validateProLicense(
    params.licenseKey,
    "Provided license_key"
  );
  if (isGenerateReportFailure(providedLicense)) {
    return providedLicense;
  }

  const reportMarkdown = analyzeThreadDumpMarkdown(params.threadDump);
  const reportParams = {
    customerName: `Pro Customer #${providedLicense.customerId ?? "Unknown"}`,
    licenseKeyMasked: maskLicenseKey(params.licenseKey),
    reportDate: new Date().toISOString().slice(0, 10),
    toolVersion: TOOL_VERSION,
    reportMarkdown,
  };

  const outputDir =
    params.outputDir ??
    (await mkdtemp(path.join(tmpdir(), "mcp-jvm-diagnostics-report-")));
  const htmlPath = path.join(outputDir, "diagnostic-report.html");
  const pdfPath = path.join(outputDir, "diagnostic-report.pdf");

  const html = renderDiagnosticReport(reportParams);
  await writeFile(htmlPath, html, "utf8");

  const pdf = await generateDiagnosticPdf(reportParams);
  await writeFile(pdfPath, pdf);

  return {
    ok: true,
    htmlPath,
    pdfPath,
    customerId: providedLicense.customerId,
  };
}
