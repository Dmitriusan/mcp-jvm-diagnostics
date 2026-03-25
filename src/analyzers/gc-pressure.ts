/**
 * GC pressure analyzer.
 *
 * Detects excessive pauses, promotion failures, memory pressure patterns.
 * Recommends JVM flags for tuning.
 */

import type { ParsedGcLog } from "../parsers/gc-log.js";

export interface GcPressureAnalysis {
  minPauseMs: number;
  maxPauseMs: number;
  avgPauseMs: number;
  p95PauseMs: number;
  totalPauseMs: number;
  gcOverheadPct: number;
  heapBeforeMb: number;
  heapAfterMb: number;
  issues: string[];
  recommendations: string[];
}

export function analyzeGcPressure(log: ParsedGcLog): GcPressureAnalysis {
  const pauseEvents = log.events.filter(e => e.pauseMs > 0);
  const pauses = pauseEvents.map(e => e.pauseMs).sort((a, b) => a - b);

  const result: GcPressureAnalysis = {
    minPauseMs: 0,
    maxPauseMs: 0,
    avgPauseMs: 0,
    p95PauseMs: 0,
    totalPauseMs: 0,
    gcOverheadPct: 0,
    heapBeforeMb: 0,
    heapAfterMb: 0,
    issues: [],
    recommendations: [],
  };

  if (pauses.length === 0) return result;

  // Pause statistics
  result.minPauseMs = pauses[0];
  result.maxPauseMs = pauses[pauses.length - 1];
  result.totalPauseMs = pauses.reduce((a, b) => a + b, 0);
  result.avgPauseMs = result.totalPauseMs / pauses.length;
  // Linear interpolation for P95: Math.floor(n * 0.95) returns index n-1 whenever
  // n <= 20, making P95 equal the max. Using (n-1) * 0.95 as the fractional index
  // and interpolating between adjacent elements gives accurate results at all sizes.
  const p95Idx = (pauses.length - 1) * 0.95;
  const p95Lo = Math.floor(p95Idx);
  const p95Hi = Math.ceil(p95Idx);
  result.p95PauseMs =
    p95Lo === p95Hi
      ? pauses[p95Lo]
      : pauses[p95Lo] + (pauses[p95Hi] - pauses[p95Lo]) * (p95Idx - p95Lo);

  // GC overhead
  if (log.timeSpanMs > 0) {
    result.gcOverheadPct = (result.totalPauseMs / log.timeSpanMs) * 100;
  }

  // Heap stats (average before/after)
  const heapEvents = log.events.filter(e => e.heapBeforeMb > 0);
  if (heapEvents.length > 0) {
    result.heapBeforeMb =
      heapEvents.reduce((s, e) => s + e.heapBeforeMb, 0) / heapEvents.length;
    result.heapAfterMb =
      heapEvents.reduce((s, e) => s + e.heapAfterMb, 0) / heapEvents.length;
  }

  // Issue detection
  detectIssues(log, result);

  // Recommendations
  generateRecommendations(log, result);

  return result;
}

function detectIssues(log: ParsedGcLog, result: GcPressureAnalysis): void {
  // High GC overhead
  if (result.gcOverheadPct > 15) {
    result.issues.push(
      `GC overhead is ${result.gcOverheadPct.toFixed(1)}% — above 15% threshold. Application is spending too much time in GC.`
    );
  }

  // Long pauses
  if (result.maxPauseMs > 1000) {
    result.issues.push(
      `Maximum GC pause of ${result.maxPauseMs.toFixed(0)}ms exceeds 1 second — causes visible latency spikes.`
    );
  }

  // Full GC events
  const fullGcCount = log.events.filter(
    e => e.type.includes("Full") || e.type.includes("Major")
  ).length;
  if (fullGcCount > 0) {
    result.issues.push(
      `${fullGcCount} Full GC event(s) detected — these cause the longest pauses. May indicate heap pressure or explicit System.gc() calls.`
    );
  }

  // Heap not shrinking (possible memory leak)
  const heapEvents = log.events.filter(e => e.heapAfterMb > 0);
  if (heapEvents.length >= 5) {
    const firstHalf = heapEvents.slice(0, Math.floor(heapEvents.length / 2));
    const secondHalf = heapEvents.slice(Math.floor(heapEvents.length / 2));
    const avgFirst = firstHalf.reduce((s, e) => s + e.heapAfterMb, 0) / firstHalf.length;
    const avgSecond = secondHalf.reduce((s, e) => s + e.heapAfterMb, 0) / secondHalf.length;

    if (avgSecond > avgFirst * 1.3) {
      result.issues.push(
        `Heap after GC is growing over time (${avgFirst.toFixed(0)}MB → ${avgSecond.toFixed(0)}MB) — possible memory leak.`
      );
    }
  }

  // Low reclaim ratio — only meaningful when heap actually shrank after GC.
  // Guard heapAfterMb < heapBeforeMb to avoid a negative reclaim percentage when
  // averaged heap-after exceeds heap-before (e.g. growing heap events skewing averages).
  if (result.heapBeforeMb > 0 && result.heapAfterMb > 0 && result.heapAfterMb < result.heapBeforeMb) {
    const reclaimPct =
      ((result.heapBeforeMb - result.heapAfterMb) / result.heapBeforeMb) * 100;
    if (reclaimPct < 10) {
      result.issues.push(
        `GC reclaims only ${reclaimPct.toFixed(0)}% of heap per collection — most objects survive. Heap may be too small or there's a memory leak.`
      );
    }
  }
}

function generateRecommendations(log: ParsedGcLog, result: GcPressureAnalysis): void {
  // High overhead → increase heap
  if (result.gcOverheadPct > 15) {
    result.recommendations.push(
      "Increase heap size (-Xmx) to reduce GC frequency. Start with 2x current value."
    );
  }

  // Long pauses → switch to low-latency collector
  if (result.maxPauseMs > 500) {
    if (log.algorithm === "Parallel" || log.algorithm === "Serial") {
      result.recommendations.push(
        `Switch from ${log.algorithm} GC to G1 (-XX:+UseG1GC) or ZGC (-XX:+UseZGC) for lower pause times.`
      );
    } else if (log.algorithm === "G1") {
      result.recommendations.push(
        "Consider tuning G1 target pause time: -XX:MaxGCPauseMillis=200. If pauses still too long, evaluate ZGC."
      );
    }
  }

  // Full GCs → tune thresholds
  const fullGcCount = log.events.filter(e => e.type.includes("Full")).length;
  if (fullGcCount > 3) {
    result.recommendations.push(
      "Frequent Full GCs indicate heap pressure. Increase -Xmx or tune -XX:InitiatingHeapOccupancyPercent (G1) to start concurrent marking earlier."
    );
  }

  // Low reclaim → check for leaks (same guard as detectIssues: skip when averages are inverted)
  if (result.heapBeforeMb > 0 && result.heapAfterMb < result.heapBeforeMb) {
    const reclaimPct =
      ((result.heapBeforeMb - result.heapAfterMb) / result.heapBeforeMb) * 100;
    if (reclaimPct < 10) {
      result.recommendations.push(
        "Very low reclaim ratio suggests most objects are long-lived. Take a heap dump and analyze with Eclipse MAT or jmap -histo to identify memory leaks."
      );
    }
  }

  // General best practices
  if (result.recommendations.length === 0) {
    result.recommendations.push(
      "GC behavior looks healthy. For production, ensure -Xms equals -Xmx to avoid heap resizing pauses."
    );
  }
}
