/**
 * Heap histogram diff analyzer.
 *
 * Compares two jmap -histo outputs to detect memory growth patterns.
 * Identifies:
 * - Classes with growing instance/byte counts (leak candidates)
 * - Classes that appeared in the second snapshot but not the first (new allocations)
 * - Classes that disappeared (GC'd or unloaded)
 * - Overall heap growth rate
 */

import { parseHeapHisto, type HeapHistoEntry } from "../parsers/heap-histo.js";

export interface HistoDiffEntry {
  className: string;
  instancesBefore: number;
  instancesAfter: number;
  instancesDelta: number;
  bytesBefore: number;
  bytesAfter: number;
  bytesDelta: number;
  growthPct: number;
}

export interface HistoDiffReport {
  growing: HistoDiffEntry[];
  shrinking: HistoDiffEntry[];
  newClasses: HistoDiffEntry[];
  removedClasses: HistoDiffEntry[];
  totalBytesBefore: number;
  totalBytesAfter: number;
  totalBytesDelta: number;
  totalInstancesBefore: number;
  totalInstancesAfter: number;
  issues: string[];
  recommendations: string[];
}

// Common JDK internal classes — growth in these is usually not a direct leak
const JDK_INTERNALS = new Set([
  "[B", "[C", "[I", "[J", "[S", "[Z", "[D", "[F",
  "java.lang.String", "java.lang.Object[]", "java.lang.Class",
  "java.util.HashMap$Node", "java.util.concurrent.ConcurrentHashMap$Node",
  "java.lang.reflect.Method", "java.lang.ref.Finalizer",
]);

export function compareHeapHistos(before: string, after: string): HistoDiffReport {
  const reportBefore = parseHeapHisto(before);
  const reportAfter = parseHeapHisto(after);

  // Build lookup maps
  const beforeMap = new Map<string, HeapHistoEntry>();
  for (const e of reportBefore.entries) {
    beforeMap.set(e.className, e);
  }

  const afterMap = new Map<string, HeapHistoEntry>();
  for (const e of reportAfter.entries) {
    afterMap.set(e.className, e);
  }

  const growing: HistoDiffEntry[] = [];
  const shrinking: HistoDiffEntry[] = [];
  const newClasses: HistoDiffEntry[] = [];
  const removedClasses: HistoDiffEntry[] = [];

  // Compare entries present in both
  for (const [className, afterEntry] of afterMap) {
    const beforeEntry = beforeMap.get(className);

    if (!beforeEntry) {
      // New class in second snapshot
      newClasses.push({
        className,
        instancesBefore: 0,
        instancesAfter: afterEntry.instances,
        instancesDelta: afterEntry.instances,
        bytesBefore: 0,
        bytesAfter: afterEntry.bytes,
        bytesDelta: afterEntry.bytes,
        growthPct: 100,
      });
      continue;
    }

    const bytesDelta = afterEntry.bytes - beforeEntry.bytes;
    const instancesDelta = afterEntry.instances - beforeEntry.instances;
    const growthPct = beforeEntry.bytes > 0 ? (bytesDelta / beforeEntry.bytes) * 100 : 0;

    const entry: HistoDiffEntry = {
      className,
      instancesBefore: beforeEntry.instances,
      instancesAfter: afterEntry.instances,
      instancesDelta,
      bytesBefore: beforeEntry.bytes,
      bytesAfter: afterEntry.bytes,
      bytesDelta,
      growthPct,
    };

    if (bytesDelta > 0) {
      growing.push(entry);
    } else if (bytesDelta < 0) {
      shrinking.push(entry);
    }
  }

  // Find removed classes (in before but not after)
  for (const [className, beforeEntry] of beforeMap) {
    if (!afterMap.has(className)) {
      removedClasses.push({
        className,
        instancesBefore: beforeEntry.instances,
        instancesAfter: 0,
        instancesDelta: -beforeEntry.instances,
        bytesBefore: beforeEntry.bytes,
        bytesAfter: 0,
        bytesDelta: -beforeEntry.bytes,
        growthPct: -100,
      });
    }
  }

  // Sort by bytes delta (largest growth first)
  growing.sort((a, b) => b.bytesDelta - a.bytesDelta);
  shrinking.sort((a, b) => a.bytesDelta - b.bytesDelta);
  newClasses.sort((a, b) => b.bytesAfter - a.bytesAfter);

  const totalBytesBefore = reportBefore.totalBytes;
  const totalBytesAfter = reportAfter.totalBytes;
  const totalBytesDelta = totalBytesAfter - totalBytesBefore;

  // Analyze for issues
  const issues: string[] = [];
  const recommendations: string[] = [];

  // Check for significant heap growth
  if (totalBytesBefore > 0) {
    const overallGrowth = (totalBytesDelta / totalBytesBefore) * 100;
    if (overallGrowth > 50) {
      issues.push(`Heap grew ${overallGrowth.toFixed(0)}% between snapshots — significant memory growth detected`);
    }
  }

  // Check for non-JDK classes with significant growth
  const suspiciousGrowing = growing.filter(e =>
    !JDK_INTERNALS.has(e.className) && e.bytesDelta > 1_000_000
  );

  for (const entry of suspiciousGrowing.slice(0, 5)) {
    issues.push(
      `${entry.className}: +${formatBytes(entry.bytesDelta)} (+${entry.instancesDelta} instances, ${entry.growthPct.toFixed(0)}% growth) — potential memory leak`
    );
    recommendations.push(
      `Investigate ${entry.className} retention — capture heap dump and trace GC roots with Eclipse MAT`
    );
  }

  // Check for classloader leaks
  const classEntry = growing.find(e => e.className === "java.lang.Class");
  if (classEntry && classEntry.instancesDelta > 1000) {
    issues.push(
      `java.lang.Class grew by ${classEntry.instancesDelta} instances — possible classloader leak (hot redeploy, dynamic proxies)`
    );
    recommendations.push(
      "Check for classloader leaks if using hot deployment. Consider full restart instead of redeploy."
    );
  }

  // Check for finalizer queue growth
  const finalizerEntry = growing.find(e => e.className === "java.lang.ref.Finalizer");
  if (finalizerEntry && finalizerEntry.instancesDelta > 5000) {
    issues.push(
      `Finalizer queue grew by ${finalizerEntry.instancesDelta} — finalization is backing up`
    );
    recommendations.push("Replace finalize() with Cleaner or try-with-resources.");
  }

  if (issues.length === 0 && totalBytesDelta <= 0) {
    recommendations.push("Heap is stable or shrinking — no memory leak indicators detected.");
  }

  if (issues.length === 0 && totalBytesDelta > 0 && suspiciousGrowing.length === 0) {
    recommendations.push(
      "Growth appears to be in JDK internal classes — likely normal String/array allocation. Monitor for sustained growth across multiple snapshots."
    );
  }

  return {
    growing,
    shrinking,
    newClasses,
    removedClasses,
    totalBytesBefore,
    totalBytesAfter,
    totalBytesDelta,
    totalInstancesBefore: reportBefore.totalInstances,
    totalInstancesAfter: reportAfter.totalInstances,
    issues,
    recommendations,
  };
}

function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  const sign = bytes < 0 ? "-" : "";
  if (abs >= 1_073_741_824) return `${sign}${(abs / 1_073_741_824).toFixed(1)} GB`;
  if (abs >= 1_048_576) return `${sign}${(abs / 1_048_576).toFixed(1)} MB`;
  if (abs >= 1024) return `${sign}${(abs / 1024).toFixed(0)} KB`;
  return `${sign}${abs} B`;
}
