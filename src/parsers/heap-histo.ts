/**
 * Parser for `jmap -histo` output.
 *
 * Example format:
 *  num     #instances         #bytes  class name (module)
 * -------------------------------------------------------
 *    1:        123456       12345678  [B (java.base)
 *    2:         98765        9876543  java.lang.String (java.base)
 *    3:         45678        4567800  java.lang.Object[] (java.base)
 * ...
 * Total        500000       50000000
 */

export interface HeapHistoEntry {
  rank: number;
  instances: number;
  bytes: number;
  className: string;
  module: string | null;
}

export interface HeapHistoReport {
  entries: HeapHistoEntry[];
  totalInstances: number;
  totalBytes: number;
  issues: HeapHistoIssue[];
  recommendations: string[];
}

export interface HeapHistoIssue {
  severity: "CRITICAL" | "WARNING" | "INFO";
  message: string;
  className: string;
}

// Common JDK internal classes that are expected to be large
const JDK_INTERNALS = new Set([
  "[B", "[C", "[I", "[J", "[S", "[Z", "[D", "[F",
  "java.lang.String", "java.lang.Object[]", "java.lang.Class",
  "java.util.HashMap$Node", "java.util.concurrent.ConcurrentHashMap$Node",
  "java.lang.reflect.Method", "java.lang.ref.Finalizer",
]);

const HISTO_LINE_RE = /^\s*(\d+):\s+(\d+)\s+(\d+)\s+(.+?)(?:\s+\((.+?)\))?\s*$/;
const TOTAL_LINE_RE = /^Total\s+(\d+)\s+(\d+)/;

export function parseHeapHisto(text: string): HeapHistoReport {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const entries: HeapHistoEntry[] = [];
  let totalInstances = 0;
  let totalBytes = 0;

  for (const line of lines) {
    const totalMatch = TOTAL_LINE_RE.exec(line);
    if (totalMatch) {
      totalInstances = parseInt(totalMatch[1], 10);
      totalBytes = parseInt(totalMatch[2], 10);
      continue;
    }

    const match = HISTO_LINE_RE.exec(line);
    if (match) {
      entries.push({
        rank: parseInt(match[1], 10),
        instances: parseInt(match[2], 10),
        bytes: parseInt(match[3], 10),
        className: match[4].trim(),
        module: match[5] || null,
      });
    }
  }

  if (totalInstances === 0 && entries.length > 0) {
    totalInstances = entries.reduce((sum, e) => sum + e.instances, 0);
    totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  }

  const issues: HeapHistoIssue[] = [];
  const recommendations: string[] = [];

  if (entries.length === 0) {
    issues.push({
      severity: "CRITICAL",
      message: "No histogram entries found — input may not be a valid jmap -histo output",
      className: "",
    });
    return { entries, totalInstances, totalBytes, issues, recommendations };
  }

  // Analyze top entries for heap-percentage-based issues.
  // These checks are only meaningful near the top of the list — a class that doesn't
  // rank in the top 30 by bytes cannot be consuming >10% of heap.
  for (const entry of entries.slice(0, 30)) {
    const pctBytes = totalBytes > 0 ? (entry.bytes / totalBytes) * 100 : 0;
    const isJdkInternal = JDK_INTERNALS.has(entry.className);

    // Large non-JDK class consuming > 10% of heap
    if (pctBytes > 10 && !isJdkInternal) {
      issues.push({
        severity: "CRITICAL",
        message: `${entry.className} consumes ${pctBytes.toFixed(1)}% of heap (${formatBytes(entry.bytes)}, ${entry.instances} instances) — potential memory leak`,
        className: entry.className,
      });
      recommendations.push(
        `Investigate ${entry.className} — use Eclipse MAT or VisualVM to trace retention paths. Check for unbounded caches or collections.`
      );
    }

    // Char arrays ([C) or byte arrays ([B) dominating — usually String-related
    if ((entry.className === "[B" || entry.className === "[C") && pctBytes > 40) {
      issues.push({
        severity: "WARNING",
        message: `${entry.className === "[B" ? "Byte" : "Char"} arrays consume ${pctBytes.toFixed(1)}% of heap — likely driven by String retention. Check for large string caches or log buffering.`,
        className: entry.className,
      });
    }
  }

  // Instance-count checks scan all entries: a class ranked outside the top 30 by bytes
  // can still have an excessive number of small instances (e.g., many small DTOs or events).
  for (const entry of entries) {
    const pctBytes = totalBytes > 0 ? (entry.bytes / totalBytes) * 100 : 0;
    const isJdkInternal = JDK_INTERNALS.has(entry.className);

    // Very high instance count for non-JDK class (> 100K)
    if (entry.instances > 100_000 && !isJdkInternal && pctBytes <= 10) {
      issues.push({
        severity: "WARNING",
        message: `${entry.className} has ${entry.instances.toLocaleString()} instances (${formatBytes(entry.bytes)}) — may indicate an object creation hotspot`,
        className: entry.className,
      });
    }

    // Finalizer objects indicate slow finalization
    if (entry.className === "java.lang.ref.Finalizer" && entry.instances > 10_000) {
      issues.push({
        severity: "WARNING",
        message: `${entry.instances.toLocaleString()} Finalizer objects — finalization queue may be backed up. Classes using finalize() are blocking GC.`,
        className: entry.className,
      });
      recommendations.push(
        "Replace finalize() with Cleaner or try-with-resources. Finalizers delay GC and can cause memory pressure."
      );
    }
  }

  // Check for class loader leak indicators
  const classCount = entries.find(e => e.className === "java.lang.Class");
  if (classCount && classCount.instances > 30_000) {
    issues.push({
      severity: "WARNING",
      message: `${classCount.instances.toLocaleString()} loaded classes — possible classloader leak (hot redeploy, dynamic proxy generation)`,
      className: "java.lang.Class",
    });
    recommendations.push(
      "Check for classloader leaks if using hot deployment (Tomcat, Spring DevTools). Consider restarting instead of redeploying."
    );
  }

  if (issues.length === 0) {
    recommendations.push(
      "Heap histogram looks healthy. For deeper analysis, capture a full heap dump: jmap -dump:live,format=b,file=heap.hprof <pid>"
    );
  }

  return { entries, totalInstances, totalBytes, issues, recommendations };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
