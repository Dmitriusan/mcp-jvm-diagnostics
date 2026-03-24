#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseThreadDump } from "./parsers/thread-dump.js";
import { detectDeadlocks } from "./analyzers/deadlock.js";
import { analyzeContention } from "./analyzers/contention.js";
import { parseGcLog } from "./parsers/gc-log.js";
import { analyzeGcPressure } from "./analyzers/gc-pressure.js";
import { parseHeapHisto } from "./parsers/heap-histo.js";
import { compareHeapHistos } from "./analyzers/heap-diff.js";
import { parseJfrSummary } from "./parsers/jfr-summary.js";
import {
  generateReportFromThreadDump,
  analyzeThreadDumpMarkdown,
} from "./reporting.js";

// Handle --help
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`mcp-jvm-diagnostics v0.1.6 — MCP server for JVM diagnostics

Usage:
  mcp-jvm-diagnostics [options]

Options:
  --help, -h   Show this help message

Tools provided:
  analyze_thread_dump   Parse thread dump, detect deadlocks and contention (platform + virtual threads)
  analyze_gc_log        Parse GC log, detect pressure and tuning (G1, ZGC, Parallel, Shenandoah)
  analyze_heap_histo    Parse jmap -histo output, detect memory leak candidates
  compare_heap_histos   Compare two jmap histos to detect memory growth
  analyze_jfr           Parse JFR summary output, detect performance hotspots
  diagnose_jvm          Unified diagnosis from thread dump + GC log
  generate_report       Generate an exportable HTML + PDF diagnostic report (Pro)`);
  process.exit(0);
}

const server = new McpServer({
  name: "mcp-jvm-diagnostics",
  version: "0.1.6",
});

// --- Tool: analyze_thread_dump ---
server.tool(
  "analyze_thread_dump",
  "Parse a JVM thread dump (jstack output) and analyze thread states, detect deadlocks, identify lock contention hotspots, and find thread starvation patterns. Handles both platform threads and virtual threads (Java 21+).",
  {
    thread_dump: z
      .string()
      .describe("The full thread dump text (from jstack, kill -3, or VisualVM)"),
  },
  async ({ thread_dump }) => {
    try {
      return {
        content: [{ type: "text", text: analyzeThreadDumpMarkdown(thread_dump) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error analyzing thread dump: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// --- Tool: generate_report ---
server.tool(
  "generate_report",
  "Generate an exportable diagnostic report (HTML + PDF) from JVM diagnostic data. Requires a valid Pro license key.",
  {
    license_key: z
      .string()
      .describe("A valid MCP JVM Diagnostics Pro license key"),
    thread_dump: z
      .string()
      .describe("The full thread dump text to analyze and export"),
  },
  async ({ license_key, thread_dump }) => {
    try {
      const result = await generateReportFromThreadDump({
        licenseKey: license_key,
        threadDump: thread_dump,
      });

      if (!result.ok) {
        return {
          content: [{ type: "text", text: result.error }],
        };
      }

      return {
        content: [
          {
            type: "text",
            text: [
              "Exportable diagnostic report generated successfully.",
              `HTML: ${result.htmlPath}`,
              `PDF: ${result.pdfPath}`,
              `Customer ID: ${result.customerId ?? "Unknown"}`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error generating report: ${
              err instanceof Error ? err.message : String(err)
            }`,
          },
        ],
      };
    }
  }
);

// --- Tool: analyze_gc_log ---
server.tool(
  "analyze_gc_log",
  "Parse a JVM GC log and analyze garbage collection patterns, pause times, allocation rates, and memory pressure. Supports G1, ZGC, Parallel, Serial, and Shenandoah GC formats.",
  {
    gc_log: z
      .string()
      .describe("The GC log text (from -Xlog:gc* or -verbose:gc)"),
  },
  async ({ gc_log }) => {
    try {
      const parsed = parseGcLog(gc_log);
      const pressure = analyzeGcPressure(parsed);

      const sections: string[] = [];

      sections.push(`## GC Log Analysis`);
      sections.push(`\n- **GC Algorithm**: ${parsed.algorithm}`);
      sections.push(`- **Total GC events**: ${parsed.events.length}`);
      sections.push(`- **Time span**: ${parsed.timeSpanMs > 0 ? (parsed.timeSpanMs / 1000).toFixed(1) + "s" : "N/A"}`);

      // Pause time stats
      if (parsed.events.length > 0) {
        const gcOverheadStr = parsed.hasTimestamps
          ? `${pressure.gcOverheadPct.toFixed(1)}%`
          : "N/A (legacy format has no timestamps)";
        sections.push(`\n### Pause Time Statistics`);
        sections.push(`| Metric | Value |`);
        sections.push(`|--------|-------|`);
        sections.push(`| Min pause | ${pressure.minPauseMs.toFixed(1)} ms |`);
        sections.push(`| Max pause | ${pressure.maxPauseMs.toFixed(1)} ms |`);
        sections.push(`| Avg pause | ${pressure.avgPauseMs.toFixed(1)} ms |`);
        sections.push(`| P95 pause | ${pressure.p95PauseMs.toFixed(1)} ms |`);
        sections.push(`| Total pause time | ${pressure.totalPauseMs.toFixed(0)} ms |`);
        sections.push(`| GC overhead | ${gcOverheadStr} |`);
      }

      // Heap sizing
      if (pressure.heapBeforeMb > 0) {
        sections.push(`\n### Heap Usage`);
        sections.push(`| Metric | Value |`);
        sections.push(`|--------|-------|`);
        sections.push(`| Heap before GC (avg) | ${pressure.heapBeforeMb.toFixed(0)} MB |`);
        sections.push(`| Heap after GC (avg) | ${pressure.heapAfterMb.toFixed(0)} MB |`);
        sections.push(`| Reclaim per GC (avg) | ${(pressure.heapBeforeMb - pressure.heapAfterMb).toFixed(0)} MB |`);
      }

      // Event breakdown
      const typeCounts = new Map<string, number>();
      for (const e of parsed.events) {
        typeCounts.set(e.type, (typeCounts.get(e.type) || 0) + 1);
      }
      sections.push(`\n### GC Event Types`);
      sections.push(`| Type | Count |`);
      sections.push(`|------|-------|`);
      for (const [type, count] of [...typeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        sections.push(`| ${type} | ${count} |`);
      }

      // Issues and recommendations
      if (pressure.issues.length > 0) {
        sections.push(`\n### Issues Detected`);
        for (const issue of pressure.issues) {
          sections.push(`- ${issue}`);
        }
      }

      if (pressure.recommendations.length > 0) {
        sections.push(`\n### Recommendations`);
        for (const rec of pressure.recommendations) {
          sections.push(`- ${rec}`);
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error analyzing GC log: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// --- Tool: analyze_heap_histo ---
server.tool(
  "analyze_heap_histo",
  "Parse jmap -histo output and detect memory leak candidates, object creation hotspots, classloader leaks, and heap composition issues.",
  {
    histo: z
      .string()
      .describe("The jmap -histo output text (from jmap -histo <pid> or jmap -histo:live <pid>)"),
  },
  async ({ histo }) => {
    try {
      const report = parseHeapHisto(histo);

      const sections: string[] = [];
      sections.push(`## Heap Histogram Analysis`);
      sections.push(`\n- **Total instances**: ${report.totalInstances.toLocaleString()}`);
      sections.push(`- **Total bytes**: ${formatBytes(report.totalBytes)}`);
      sections.push(`- **Classes**: ${report.entries.length}`);

      // Top 15 by bytes
      sections.push(`\n### Top 15 Classes by Memory`);
      sections.push(`| Rank | Instances | Bytes | % Heap | Class |`);
      sections.push(`|------|-----------|-------|--------|-------|`);
      for (const entry of report.entries.slice(0, 15)) {
        const pct = report.totalBytes > 0 ? ((entry.bytes / report.totalBytes) * 100).toFixed(1) : "0.0";
        sections.push(`| ${entry.rank} | ${entry.instances.toLocaleString()} | ${formatBytes(entry.bytes)} | ${pct}% | ${entry.className} |`);
      }

      if (report.issues.length > 0) {
        sections.push(`\n### Issues Detected`);
        for (const issue of report.issues) {
          sections.push(`\n**${issue.severity}**: ${issue.message}`);
        }
      }

      if (report.recommendations.length > 0) {
        sections.push(`\n### Recommendations`);
        for (const rec of report.recommendations) {
          sections.push(`- ${rec}`);
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error analyzing heap histogram: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// --- Tool: compare_heap_histos ---
server.tool(
  "compare_heap_histos",
  "Compare two jmap -histo snapshots taken at different times to detect memory growth patterns, leak candidates, and new allocations. Captures what is growing between snapshots.",
  {
    before: z
      .string()
      .describe("The FIRST (earlier) jmap -histo output"),
    after: z
      .string()
      .describe("The SECOND (later) jmap -histo output"),
  },
  async ({ before, after }) => {
    try {
      const report = compareHeapHistos(before, after);
      const sections: string[] = [];

      sections.push(`## Heap Histogram Comparison`);
      sections.push(`\n- **Before**: ${report.totalInstancesBefore.toLocaleString()} instances, ${formatBytes(report.totalBytesBefore)}`);
      sections.push(`- **After**: ${report.totalInstancesAfter.toLocaleString()} instances, ${formatBytes(report.totalBytesAfter)}`);
      sections.push(`- **Delta**: ${report.totalBytesDelta >= 0 ? "+" : ""}${formatBytes(report.totalBytesDelta)}`);

      // Top growing classes
      if (report.growing.length > 0) {
        sections.push(`\n### Top Growing Classes (${report.growing.length} total)`);
        sections.push(`| Class | Before | After | Delta | Growth |`);
        sections.push(`|-------|--------|-------|-------|--------|`);
        for (const e of report.growing.slice(0, 15)) {
          sections.push(`| ${e.className} | ${formatBytes(e.bytesBefore)} | ${formatBytes(e.bytesAfter)} | +${formatBytes(e.bytesDelta)} | +${e.growthPct.toFixed(0)}% |`);
        }
      }

      // New classes
      if (report.newClasses.length > 0) {
        sections.push(`\n### New Classes (${report.newClasses.length} appeared)`);
        sections.push(`| Class | Instances | Bytes |`);
        sections.push(`|-------|-----------|-------|`);
        for (const e of report.newClasses.slice(0, 10)) {
          sections.push(`| ${e.className} | ${e.instancesAfter.toLocaleString()} | ${formatBytes(e.bytesAfter)} |`);
        }
      }

      // Top shrinking
      if (report.shrinking.length > 0) {
        sections.push(`\n### Top Shrinking Classes (${report.shrinking.length} total)`);
        sections.push(`| Class | Before | After | Delta |`);
        sections.push(`|-------|--------|-------|-------|`);
        for (const e of report.shrinking.slice(0, 10)) {
          sections.push(`| ${e.className} | ${formatBytes(e.bytesBefore)} | ${formatBytes(e.bytesAfter)} | ${formatBytes(e.bytesDelta)} |`);
        }
      }

      if (report.issues.length > 0) {
        sections.push(`\n### Issues Detected`);
        for (const issue of report.issues) {
          sections.push(`- ${issue}`);
        }
      }

      if (report.recommendations.length > 0) {
        sections.push(`\n### Recommendations`);
        for (const rec of report.recommendations) {
          sections.push(`- ${rec}`);
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error comparing histograms: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? "-" : "";
  if (abs >= 1_073_741_824) return `${sign}${(abs / 1_073_741_824).toFixed(1)} GB`;
  if (abs >= 1_048_576) return `${sign}${(abs / 1_048_576).toFixed(1)} MB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(0)} KB`;
  return `${sign}${abs} B`;
}

// --- Tool: analyze_jfr ---
server.tool(
  "analyze_jfr",
  "Parse JDK Flight Recorder summary output (from `jfr summary <file>`) and analyze event distribution, detect performance hotspots, GC pressure, lock contention, I/O patterns, and excessive allocations.",
  {
    jfr_summary: z
      .string()
      .describe("The output text from `jfr summary <recording.jfr>`"),
  },
  async ({ jfr_summary }) => {
    try {
      const summary = parseJfrSummary(jfr_summary);

      const sections: string[] = [];

      sections.push(`## JFR Recording Summary`);
      if (summary.startTime) sections.push(`\n- **Start time**: ${summary.startTime}`);
      if (summary.duration) sections.push(`- **Duration**: ${summary.duration}`);
      sections.push(`- **Total events**: ${summary.totalEvents.toLocaleString()}`);
      sections.push(`- **Total size**: ${formatBytes(summary.totalSize)}`);
      sections.push(`- **Event types**: ${summary.events.length}`);

      // Top 15 events by count
      const sorted = [...summary.events].sort((a, b) => b.count - a.count);
      sections.push(`\n### Top Events by Count`);
      sections.push(`| Event Type | Count | Size | % Total |`);
      sections.push(`|------------|-------|------|---------|`);
      for (const e of sorted.slice(0, 15)) {
        const pct = summary.totalEvents > 0 ? ((e.count / summary.totalEvents) * 100).toFixed(1) : "0.0";
        sections.push(`| ${e.name} | ${e.count.toLocaleString()} | ${formatBytes(e.size)} | ${pct}% |`);
      }

      // Category breakdown
      const categories = new Map<string, { count: number; size: number }>();
      for (const e of summary.events) {
        const parts = e.name.split(".");
        const category = parts.length >= 2 ? parts.slice(0, 2).join(".") : e.name;
        const existing = categories.get(category) || { count: 0, size: 0 };
        existing.count += e.count;
        existing.size += e.size;
        categories.set(category, existing);
      }
      const sortedCategories = [...categories.entries()].sort((a, b) => b[1].count - a[1].count);
      sections.push(`\n### Event Categories`);
      sections.push(`| Category | Events | Size |`);
      sections.push(`|----------|--------|------|`);
      for (const [cat, stats] of sortedCategories.slice(0, 10)) {
        sections.push(`| ${cat} | ${stats.count.toLocaleString()} | ${formatBytes(stats.size)} |`);
      }

      if (summary.issues.length > 0) {
        sections.push(`\n### Issues Detected`);
        for (const issue of summary.issues) {
          sections.push(`- ${issue}`);
        }
      }

      if (summary.recommendations.length > 0) {
        sections.push(`\n### Recommendations`);
        for (const rec of summary.recommendations) {
          sections.push(`- ${rec}`);
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error analyzing JFR summary: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// --- Tool: diagnose_jvm ---
server.tool(
  "diagnose_jvm",
  "Unified JVM diagnosis combining thread dump and GC log analysis. Provide one or both inputs for comprehensive root cause analysis.",
  {
    thread_dump: z
      .string()
      .optional()
      .describe("Thread dump text (from jstack)"),
    gc_log: z
      .string()
      .optional()
      .describe("GC log text (from -Xlog:gc*)"),
  },
  async ({ thread_dump, gc_log }) => {
    try {
      if (!thread_dump && !gc_log) {
        return {
          content: [{ type: "text", text: "Please provide at least one of: thread_dump or gc_log" }],
        };
      }

      const sections: string[] = [];
      sections.push(`## JVM Diagnostic Report`);

      let threadAnalysis = null;
      let gcAnalysis = null;

      if (thread_dump) {
        const parsed = parseThreadDump(thread_dump);
        const deadlocks = detectDeadlocks(parsed.threads);
        const contention = analyzeContention(parsed.threads);
        threadAnalysis = { parsed, deadlocks, contention };

        sections.push(`\n### Thread Analysis`);
        sections.push(`- Total threads: ${parsed.threads.length}`);
        sections.push(`- Deadlocks: ${deadlocks.length > 0 ? `**${deadlocks.length} DETECTED**` : "None"}`);
        sections.push(`- Contention hotspots: ${contention.hotspots.length}`);

        const blockedCount = parsed.threads.filter(t => t.state === "BLOCKED").length;
        const waitingCount = parsed.threads.filter(t => t.state === "WAITING" || t.state === "TIMED_WAITING").length;
        sections.push(`- Blocked threads: ${blockedCount}`);
        sections.push(`- Waiting threads: ${waitingCount}`);
      }

      if (gc_log) {
        const parsed = parseGcLog(gc_log);
        const pressure = analyzeGcPressure(parsed);
        gcAnalysis = { parsed, pressure };

        sections.push(`\n### GC Analysis`);
        sections.push(`- Algorithm: ${parsed.algorithm}`);
        sections.push(`- Events: ${parsed.events.length}`);
        sections.push(`- Max pause: ${pressure.maxPauseMs.toFixed(1)} ms`);
        const overheadLabel = parsed.hasTimestamps
          ? `${pressure.gcOverheadPct.toFixed(1)}%`
          : "N/A (no timestamps in legacy format)";
        sections.push(`- GC overhead: ${overheadLabel}`);
        sections.push(`- Issues: ${pressure.issues.length}`);
      }

      // Cross-correlation
      if (threadAnalysis && gcAnalysis) {
        sections.push(`\n### Cross-Correlation`);

        const gcThreads = threadAnalysis.parsed.threads.filter(
          t => t.name.includes("GC") || t.name.includes("G1") || t.name.includes("ZGC")
        );
        if (gcThreads.length > 0) {
          sections.push(`- GC-related threads: ${gcThreads.length}`);
        }

        if (gcAnalysis.pressure.gcOverheadPct > 10 && threadAnalysis.contention.hotspots.length > 0) {
          sections.push(`- **Warning**: High GC overhead (${gcAnalysis.pressure.gcOverheadPct.toFixed(1)}%) combined with lock contention — threads may be blocked during GC pauses`);
        }

        if (gcAnalysis.pressure.maxPauseMs > 500 && threadAnalysis.parsed.threads.filter(t => t.state === "BLOCKED").length > 5) {
          sections.push(`- **Warning**: Long GC pauses (${gcAnalysis.pressure.maxPauseMs.toFixed(0)}ms) with many blocked threads — GC may be causing cascading blocks`);
        }
      }

      // Overall assessment
      sections.push(`\n### Overall Assessment`);
      const issues: string[] = [];
      if (threadAnalysis?.deadlocks.length) issues.push(`${threadAnalysis.deadlocks.length} deadlock(s) — application may be hung`);
      if (threadAnalysis && threadAnalysis.contention.hotspots.length > 3) issues.push("Significant lock contention detected");
      if (gcAnalysis?.pressure.gcOverheadPct && gcAnalysis.pressure.gcOverheadPct > 15) issues.push("High GC overhead — consider heap tuning");
      if (gcAnalysis?.pressure.maxPauseMs && gcAnalysis.pressure.maxPauseMs > 1000) issues.push("GC pauses exceed 1 second — latency impact");

      if (issues.length === 0) {
        sections.push(`JVM appears healthy based on provided diagnostics.`);
      } else {
        sections.push(`**${issues.length} issue(s) found:**`);
        for (const issue of issues) {
          sections.push(`- ${issue}`);
        }
      }

      return { content: [{ type: "text", text: sections.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error diagnosing JVM: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  }
);

// --- Start server ---
async function main() {
  console.error("MCP JVM Diagnostics running on stdio");
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
