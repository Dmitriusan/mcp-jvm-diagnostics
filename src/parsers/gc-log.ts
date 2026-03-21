/**
 * GC log parser.
 *
 * Supports:
 * - Unified JVM logging format (-Xlog:gc*) — Java 9+
 * - G1, ZGC, Parallel, Serial GC
 * - Legacy -verbose:gc format (basic support)
 */

export interface GcEvent {
  timestamp: number; // seconds from start
  type: string; // "Pause Young", "Pause Full", "Concurrent Mark", etc.
  pauseMs: number; // pause duration in ms (0 for concurrent phases)
  heapBeforeMb: number;
  heapAfterMb: number;
  heapTotalMb: number;
}

export interface ParsedGcLog {
  algorithm: string;
  events: GcEvent[];
  timeSpanMs: number;
}

// Unified logging: [0.123s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 1.234ms
const UNIFIED_GC_RE =
  /\[(\d+[.,]\d+)s\].*?GC\(\d+\)\s+(Pause\s+\S+(?:\s+\([^)]*\))*)\s+(\d+)M->(\d+)M\((\d+)M\)\s+(\d+[.,]\d+)ms/;

// Unified concurrent: [0.123s][info][gc] GC(0) Concurrent Mark 1.234ms
const UNIFIED_CONCURRENT_RE =
  /\[(\d+[.,]\d+)s\].*?GC\(\d+\)\s+(Concurrent\s+\S+(?:\s+\S+)?)\s+(\d+[.,]\d+)ms/;

// Legacy format: [GC (Allocation Failure) 65536K->12345K(251392K), 0.0123456 secs]
const LEGACY_GC_RE =
  /\[(Full )?GC\s*\(([^)]+)\)\s+(\d+)K->(\d+)K\((\d+)K\),\s+(\d+[.,]\d+)\s+secs\]/;

// ZGC format: [0.123s][info][gc] GC(0) Garbage Collection (Warmup) 24M(1%)->8M(0%) 1.234ms
const ZGC_RE =
  /\[(\d+[.,]\d+)s\].*?GC\(\d+\)\s+Garbage Collection\s+\([^)]+\)\s+(\d+)M\(\d+%\)->(\d+)M\(\d+%\)\s+(\d+[.,]\d+)ms/;

// Shenandoah pause format: [0.521s][info][gc] GC(0) Pause Init Mark 2.606ms
// Pauses include: Pause Init Mark, Pause Final Mark, Pause Init Update Refs, Pause Final Update Refs, Pause Full
const SHENANDOAH_PAUSE_RE =
  /\[(\d+[.,]\d+)s\].*?GC\(\d+\)\s+(Pause\s+(?:Init|Final)\s+\S+(?:\s+\S+)?|Pause Full(?:\s+\([^)]*\))?)\s+(\d+[.,]\d+)ms/;

// Parallel GC verbose:gc with region detail (-verbose:gc on Java 8):
// [GC (Allocation Failure) [PSYoungGen: 65536K->5432K(76288K)] 65536K->5432K(251392K), 0.0123456 secs]
// [Full GC (Ergonomics) [PSYoungGen: 5K->0K(76K)] [ParOldGen: 100K->50K(175K)] 105K->50K(251K), [Metaspace: 10K->10K(1056K)], 0.5679 secs]
// The (?:\s*\[[^\]]+\])+ skips one or more region detail blocks (PSYoungGen, ParOldGen, Metaspace before secs).
const PARALLEL_REGION_GC_RE =
  /\[(Full\s+)?GC\s*\([^)]+\)(?:\s*\[[^\]]+\])+\s*(\d+)K->(\d+)K\((\d+)K\),(?:\s*\[[^\]]+\],)?\s*(\d+[.,]\d+)\s+secs/;

export function parseGcLog(text: string): ParsedGcLog {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const events: GcEvent[] = [];
  let algorithm = "Unknown";

  // Detect algorithm from log content
  if (text.includes("Using G1")) algorithm = "G1";
  else if (text.includes("Using ZGC")) algorithm = "ZGC";
  else if (text.includes("Using Parallel")) algorithm = "Parallel";
  else if (text.includes("Using Serial")) algorithm = "Serial";
  else if (text.includes("Using Shenandoah")) algorithm = "Shenandoah";
  else if (text.includes("G1 Evacuation") || text.includes("G1 Humongous")) algorithm = "G1";
  else if (text.includes("Garbage Collection (")) algorithm = "ZGC";
  else if (text.includes("PSYoungGen") || text.includes("ParOldGen")) algorithm = "Parallel";

  for (const line of lines) {
    // Try unified format first
    const unifiedMatch = line.match(UNIFIED_GC_RE);
    if (unifiedMatch) {
      events.push({
        timestamp: parseFloat(unifiedMatch[1].replace(",", ".")),
        type: unifiedMatch[2].trim(),
        pauseMs: parseFloat(unifiedMatch[6].replace(",", ".")),
        heapBeforeMb: parseInt(unifiedMatch[3], 10),
        heapAfterMb: parseInt(unifiedMatch[4], 10),
        heapTotalMb: parseInt(unifiedMatch[5], 10),
      });
      continue;
    }

    // Try ZGC format
    const zgcMatch = line.match(ZGC_RE);
    if (zgcMatch) {
      events.push({
        timestamp: parseFloat(zgcMatch[1].replace(",", ".")),
        type: "Pause Young (ZGC)",
        pauseMs: parseFloat(zgcMatch[4].replace(",", ".")),
        heapBeforeMb: parseInt(zgcMatch[2], 10),
        heapAfterMb: parseInt(zgcMatch[3], 10),
        heapTotalMb: 0,
      });
      continue;
    }

    // Try unified concurrent
    const concurrentMatch = line.match(UNIFIED_CONCURRENT_RE);
    if (concurrentMatch) {
      events.push({
        timestamp: parseFloat(concurrentMatch[1].replace(",", ".")),
        type: concurrentMatch[2].trim(),
        pauseMs: 0, // concurrent phases don't pause
        heapBeforeMb: 0,
        heapAfterMb: 0,
        heapTotalMb: 0,
      });
      continue;
    }

    // Try Shenandoah pause format (no heap sizes in pause events)
    const shenandoahMatch = line.match(SHENANDOAH_PAUSE_RE);
    if (shenandoahMatch) {
      events.push({
        timestamp: parseFloat(shenandoahMatch[1].replace(",", ".")),
        type: shenandoahMatch[2].trim(),
        pauseMs: parseFloat(shenandoahMatch[3].replace(",", ".")),
        heapBeforeMb: 0,
        heapAfterMb: 0,
        heapTotalMb: 0,
      });
      continue;
    }

    // Try legacy format
    const legacyMatch = line.match(LEGACY_GC_RE);
    if (legacyMatch) {
      const isFull = legacyMatch[1] === "Full ";
      events.push({
        timestamp: 0,
        type: isFull ? "Pause Full" : "Pause Young",
        pauseMs: parseFloat(legacyMatch[6].replace(",", ".")) * 1000,
        heapBeforeMb: Math.round(parseInt(legacyMatch[3], 10) / 1024),
        heapAfterMb: Math.round(parseInt(legacyMatch[4], 10) / 1024),
        heapTotalMb: Math.round(parseInt(legacyMatch[5], 10) / 1024),
      });
      continue;
    }

    // Try Parallel GC verbose:gc with PSYoungGen/ParOldGen region blocks
    const parallelRegionMatch = line.match(PARALLEL_REGION_GC_RE);
    if (parallelRegionMatch) {
      const isFull = !!parallelRegionMatch[1];
      events.push({
        timestamp: 0,
        type: isFull ? "Pause Full" : "Pause Young",
        pauseMs: parseFloat(parallelRegionMatch[5].replace(",", ".")) * 1000,
        heapBeforeMb: Math.round(parseInt(parallelRegionMatch[2], 10) / 1024),
        heapAfterMb: Math.round(parseInt(parallelRegionMatch[3], 10) / 1024),
        heapTotalMb: Math.round(parseInt(parallelRegionMatch[4], 10) / 1024),
      });
    }
  }

  // Calculate time span
  let timeSpanMs = 0;
  if (events.length > 1) {
    const firstTs = events[0].timestamp;
    const lastTs = events[events.length - 1].timestamp;
    timeSpanMs = (lastTs - firstTs) * 1000;
  }

  return { algorithm, events, timeSpanMs };
}
