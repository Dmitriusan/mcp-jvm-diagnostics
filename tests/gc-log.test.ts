import { describe, it, expect } from "vitest";
import { parseGcLog } from "../src/parsers/gc-log.js";
import { analyzeGcPressure } from "../src/analyzers/gc-pressure.js";

const G1_LOG = `
[0.005s][info][gc] Using G1
[0.100s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 5.123ms
[0.300s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 32M->12M(256M) 3.456ms
[0.500s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 40M->16M(256M) 4.789ms
[1.000s][info][gc] GC(3) Pause Young (Normal) (G1 Evacuation Pause) 48M->20M(256M) 6.012ms
[2.000s][info][gc] GC(4) Pause Young (Concurrent Start) (G1 Evacuation Pause) 56M->24M(256M) 8.234ms
[2.100s][info][gc] GC(5) Concurrent Mark 12.345ms
[3.000s][info][gc] GC(6) Pause Full (G1 Compaction Pause) 200M->50M(256M) 150.678ms
`;

const HIGH_PRESSURE_LOG = `
[0.005s][info][gc] Using G1
[0.100s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 240M->230M(256M) 50.0ms
[0.200s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 245M->235M(256M) 55.0ms
[0.300s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 248M->240M(256M) 60.0ms
[0.400s][info][gc] GC(3) Pause Full (G1 Compaction Pause) 250M->200M(256M) 500.0ms
[0.500s][info][gc] GC(4) Pause Young (Normal) (G1 Evacuation Pause) 245M->238M(256M) 65.0ms
[0.600s][info][gc] GC(5) Pause Full (G1 Compaction Pause) 252M->210M(256M) 600.0ms
[0.700s][info][gc] GC(6) Pause Full (G1 Compaction Pause) 248M->215M(256M) 550.0ms
[0.800s][info][gc] GC(7) Pause Full (G1 Compaction Pause) 250M->220M(256M) 620.0ms
`;

const SHENANDOAH_LOG = `
[0.005s][info][gc] Using Shenandoah
[0.521s][info][gc] GC(0) Pause Init Mark 2.606ms
[0.534s][info][gc] GC(0) Concurrent Mark 13.361ms
[0.534s][info][gc] GC(0) Pause Final Mark 1.496ms
[0.535s][info][gc] GC(0) Concurrent Cleanup 0.442ms
[0.545s][info][gc] GC(0) Concurrent Evacuation 10.084ms
[0.552s][info][gc] GC(0) Pause Init Update Refs 0.041ms
[0.561s][info][gc] GC(0) Concurrent Update Refs 9.699ms
[0.561s][info][gc] GC(0) Pause Final Update Refs 1.016ms
`;

const LEGACY_LOG = `
[GC (Allocation Failure) 65536K->12345K(251392K), 0.0123456 secs]
[GC (Allocation Failure) 77881K->15000K(251392K), 0.0098765 secs]
[Full GC (Ergonomics) 200000K->50000K(251392K), 0.5678900 secs]
`;

// Parallel GC -verbose:gc output with PSYoungGen/ParOldGen region detail (Java 8 style)
const PARALLEL_REGION_LOG = `
[GC (Allocation Failure) [PSYoungGen: 65536K->5432K(76288K)] 65536K->5432K(251392K), 0.0123456 secs] [Times: user=0.04 sys=0.00, real=0.01 secs]
[GC (Allocation Failure) [PSYoungGen: 70000K->6000K(76288K)] 70000K->6000K(251392K), 0.0098765 secs] [Times: user=0.03 sys=0.00, real=0.01 secs]
[Full GC (Ergonomics) [PSYoungGen: 5000K->0K(76288K)] [ParOldGen: 100000K->50000K(175104K)] 105000K->50000K(251392K), [Metaspace: 10000K->10000K(1056768K)], 0.5678900 secs] [Times: user=1.50 sys=0.00, real=0.57 secs]
`;

// ZGC unified logging format
const ZGC_LOG = `
[0.005s][info][gc] Using ZGC
[0.100s][info][gc] GC(0) Garbage Collection (Warmup) 24M(9%)->8M(3%) 1.234ms
[0.200s][info][gc] GC(1) Garbage Collection (Normal) 32M(12%)->10M(4%) 0.987ms
[0.500s][info][gc] GC(2) Garbage Collection (Normal) 48M(18%)->12M(5%) 1.567ms
`;

describe("GC Log Parser", () => {
  it("detects G1 algorithm", () => {
    const result = parseGcLog(G1_LOG);
    expect(result.algorithm).toBe("G1");
  });

  it("parses all GC events", () => {
    const result = parseGcLog(G1_LOG);
    // 6 pause events + 1 concurrent
    expect(result.events.length).toBe(7);
  });

  it("parses pause times correctly", () => {
    const result = parseGcLog(G1_LOG);
    const firstPause = result.events[0];
    expect(firstPause.pauseMs).toBeCloseTo(5.123, 2);
  });

  it("parses heap sizes", () => {
    const result = parseGcLog(G1_LOG);
    const firstPause = result.events[0];
    expect(firstPause.heapBeforeMb).toBe(24);
    expect(firstPause.heapAfterMb).toBe(8);
    expect(firstPause.heapTotalMb).toBe(256);
  });

  it("identifies concurrent events", () => {
    const result = parseGcLog(G1_LOG);
    const concurrent = result.events.find(e => e.type === "Concurrent Mark");
    expect(concurrent).toBeDefined();
    expect(concurrent!.pauseMs).toBe(0);
  });

  it("calculates time span", () => {
    const result = parseGcLog(G1_LOG);
    expect(result.timeSpanMs).toBeGreaterThan(0);
  });

  it("parses legacy format", () => {
    const result = parseGcLog(LEGACY_LOG);
    expect(result.events.length).toBe(3);
    expect(result.events[0].pauseMs).toBeCloseTo(12.3456, 1);
    expect(result.events[2].type).toBe("Pause Full");
  });

  it("converts legacy KB to MB", () => {
    const result = parseGcLog(LEGACY_LOG);
    expect(result.events[0].heapBeforeMb).toBe(64); // 65536K ≈ 64M
    expect(result.events[0].heapAfterMb).toBe(12); // 12345K ≈ 12M
  });

  it("detects Shenandoah algorithm", () => {
    const result = parseGcLog(SHENANDOAH_LOG);
    expect(result.algorithm).toBe("Shenandoah");
  });

  it("parses Shenandoah pause events", () => {
    const result = parseGcLog(SHENANDOAH_LOG);
    const pauseEvents = result.events.filter(e => e.pauseMs > 0);
    // Init Mark, Final Mark, Init Update Refs, Final Update Refs
    expect(pauseEvents.length).toBe(4);
  });

  it("parses Shenandoah pause times correctly", () => {
    const result = parseGcLog(SHENANDOAH_LOG);
    const initMark = result.events.find(e => e.type === "Pause Init Mark");
    expect(initMark).toBeDefined();
    expect(initMark!.pauseMs).toBeCloseTo(2.606, 2);
  });

  it("treats Shenandoah concurrent phases as non-pausing", () => {
    const result = parseGcLog(SHENANDOAH_LOG);
    const concurrent = result.events.filter(e => e.type.startsWith("Concurrent"));
    expect(concurrent.length).toBeGreaterThan(0);
    expect(concurrent.every(e => e.pauseMs === 0)).toBe(true);
  });
});

describe("GC Pressure Analyzer", () => {
  it("calculates pause statistics", () => {
    const parsed = parseGcLog(G1_LOG);
    const pressure = analyzeGcPressure(parsed);
    expect(pressure.minPauseMs).toBeGreaterThan(0);
    expect(pressure.maxPauseMs).toBeGreaterThan(pressure.minPauseMs);
    expect(pressure.avgPauseMs).toBeGreaterThan(0);
  });

  it("calculates GC overhead", () => {
    const parsed = parseGcLog(G1_LOG);
    const pressure = analyzeGcPressure(parsed);
    expect(pressure.gcOverheadPct).toBeGreaterThan(0);
    expect(pressure.gcOverheadPct).toBeLessThan(100);
  });

  it("detects high pressure issues", () => {
    const parsed = parseGcLog(HIGH_PRESSURE_LOG);
    const pressure = analyzeGcPressure(parsed);
    expect(pressure.issues.length).toBeGreaterThan(0);
    // Should detect Full GC events
    const fullGcIssue = pressure.issues.find(i => i.includes("Full GC"));
    expect(fullGcIssue).toBeDefined();
  });

  it("detects low reclaim ratio", () => {
    const parsed = parseGcLog(HIGH_PRESSURE_LOG);
    const pressure = analyzeGcPressure(parsed);
    // High pressure log has very low reclaim ratio
    const reclaimIssue = pressure.issues.find(i => i.includes("reclaim"));
    expect(reclaimIssue).toBeDefined();
  });

  it("generates recommendations", () => {
    const parsed = parseGcLog(HIGH_PRESSURE_LOG);
    const pressure = analyzeGcPressure(parsed);
    expect(pressure.recommendations.length).toBeGreaterThan(0);
  });

  it("recommends heap increase for high overhead", () => {
    const parsed = parseGcLog(HIGH_PRESSURE_LOG);
    const pressure = analyzeGcPressure(parsed);
    const heapRec = pressure.recommendations.find(r => r.includes("heap") || r.includes("-Xmx"));
    expect(heapRec).toBeDefined();
  });

  it("handles empty log gracefully", () => {
    const parsed = parseGcLog("");
    const pressure = analyzeGcPressure(parsed);
    expect(pressure.minPauseMs).toBe(0);
    expect(pressure.maxPauseMs).toBe(0);
    expect(pressure.issues.length).toBe(0);
  });
});

describe("Parallel GC verbose:gc with PSYoungGen/ParOldGen regions", () => {
  it("detects Parallel algorithm from PSYoungGen content", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    expect(result.algorithm).toBe("Parallel");
  });

  it("parses all events including Full GC", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    expect(result.events.length).toBe(3);
  });

  it("parses young GC pause times correctly", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    expect(result.events[0].pauseMs).toBeCloseTo(12.3456, 1);
  });

  it("parses Full GC with Metaspace region correctly", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    const fullGc = result.events.find(e => e.type === "Pause Full");
    expect(fullGc).toBeDefined();
    expect(fullGc!.pauseMs).toBeCloseTo(567.89, 0);
  });

  it("converts heap sizes from KB to MB", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    // 65536K -> 64MB, 5432K -> 5MB, 251392K -> 245MB
    expect(result.events[0].heapBeforeMb).toBe(64);
    expect(result.events[0].heapAfterMb).toBe(5);
  });

  it("classifies event types correctly", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    expect(result.events[0].type).toBe("Pause Young");
    expect(result.events[2].type).toBe("Pause Full");
  });
});

describe("ZGC format", () => {
  it("detects ZGC algorithm", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.algorithm).toBe("ZGC");
  });

  it("parses all ZGC Garbage Collection events", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.events.length).toBe(3);
  });

  it("parses ZGC pause times correctly", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.events[0].pauseMs).toBeCloseTo(1.234, 2);
    expect(result.events[1].pauseMs).toBeCloseTo(0.987, 2);
  });

  it("parses ZGC heap sizes", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.events[0].heapBeforeMb).toBe(24);
    expect(result.events[0].heapAfterMb).toBe(8);
  });

  it("assigns correct event type label for ZGC", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.events[0].type).toBe("Pause Young (ZGC)");
  });

  it("calculates time span across ZGC events", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.timeSpanMs).toBeGreaterThan(0);
  });
});

describe("ParsedGcLog hasTimestamps", () => {
  it("sets hasTimestamps=true for unified G1 log", () => {
    const result = parseGcLog(G1_LOG);
    expect(result.hasTimestamps).toBe(true);
  });

  it("sets hasTimestamps=true for ZGC log", () => {
    const result = parseGcLog(ZGC_LOG);
    expect(result.hasTimestamps).toBe(true);
  });

  it("sets hasTimestamps=true for Shenandoah log", () => {
    const result = parseGcLog(SHENANDOAH_LOG);
    expect(result.hasTimestamps).toBe(true);
  });

  it("sets hasTimestamps=false for legacy -verbose:gc log", () => {
    const result = parseGcLog(LEGACY_LOG);
    expect(result.hasTimestamps).toBe(false);
  });

  it("sets hasTimestamps=false for Parallel PSYoungGen legacy log", () => {
    const result = parseGcLog(PARALLEL_REGION_LOG);
    expect(result.hasTimestamps).toBe(false);
  });

  it("sets hasTimestamps=false for empty log", () => {
    const result = parseGcLog("");
    expect(result.hasTimestamps).toBe(false);
  });

  it("timeSpanMs is 0 for legacy log (no timestamps to compute span)", () => {
    const result = parseGcLog(LEGACY_LOG);
    expect(result.timeSpanMs).toBe(0);
  });

  it("gcOverheadPct stays 0 for legacy log (cannot compute without timestamps)", () => {
    const result = parseGcLog(LEGACY_LOG);
    const pressure = analyzeGcPressure(result);
    // timeSpanMs is 0 so overhead cannot be calculated — should not show a fake 0%
    expect(result.hasTimestamps).toBe(false);
    expect(pressure.gcOverheadPct).toBe(0);
  });
});

describe("GC Pressure Analyzer — P95 percentile precision", () => {
  // Build a synthetic ParsedGcLog with known pause values so we can assert
  // P95 is computed with linear interpolation, not Math.floor(n*0.95).
  function syntheticLog(pausesMs: number[]) {
    return {
      algorithm: "G1",
      timeSpanMs: 10_000,
      hasTimestamps: true,
      events: pausesMs.map((p, i) => ({
        timestamp: i * 0.1,
        type: "Pause Young",
        pauseMs: p,
        heapBeforeMb: 100,
        heapAfterMb: 50,
        heapTotalMb: 256,
      })),
    };
  }

  it("p95 is not the max for a 10-event sample", () => {
    // Sorted: 10,20,30,40,50,60,70,80,90,100. Math.floor(10*0.95)=9 → max=100.
    // Linear: idx=(9)*0.95=8.55 → 90 + 0.55*(100-90)=95.5
    const log = syntheticLog([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    const pressure = analyzeGcPressure(log);
    expect(pressure.p95PauseMs).toBeCloseTo(95.5, 1);
    expect(pressure.p95PauseMs).toBeLessThan(pressure.maxPauseMs);
  });

  it("p95 is not the max for a 20-event sample", () => {
    // Sorted: 5,10,15,...,100 (step 5). Math.floor(20*0.95)=19 → max=100.
    // Linear: idx=19*0.95=18.05 → pauses[18]=95, pauses[19]=100 → 95+0.05*(5)=95.25
    const log = syntheticLog([5,10,15,20,25,30,35,40,45,50,55,60,65,70,75,80,85,90,95,100]);
    const pressure = analyzeGcPressure(log);
    expect(pressure.p95PauseMs).toBeCloseTo(95.25, 1);
    expect(pressure.p95PauseMs).toBeLessThan(pressure.maxPauseMs);
  });

  it("p95 equals the single value for a 1-event sample", () => {
    const log = syntheticLog([42]);
    const pressure = analyzeGcPressure(log);
    expect(pressure.p95PauseMs).toBe(42);
  });

  it("p95 equals max for a 2-event sample (both are at or above P95)", () => {
    // idx=(2-1)*0.95=0.95 → pauses[0]+0.95*(pauses[1]-pauses[0])=10+0.95*90=95.5
    const log = syntheticLog([10, 100]);
    const pressure = analyzeGcPressure(log);
    expect(pressure.p95PauseMs).toBeCloseTo(95.5, 1);
  });
});

describe("GC Log Parser — European locale (comma decimal separator)", () => {
  // JVMs on systems with a European locale (de, fr, pl, …) write GC logs with
  // commas as the decimal separator: [0,123s] and 5,123ms instead of [0.123s]
  // and 5.123ms.  The parser must handle both forms to avoid silently producing
  // wrong pause-time and timestamp values.
  const EUROPEAN_LOCALE_LOG = `
[0,005s][info][gc] Using G1
[0,100s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 5,123ms
[0,300s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 32M->12M(256M) 3,456ms
[0,500s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 40M->16M(256M) 4,789ms
[1,000s][info][gc] GC(3) Pause Young (Normal) (G1 Evacuation Pause) 48M->20M(256M) 6,012ms
[2,000s][info][gc] GC(4) Pause Young (Concurrent Start) (G1 Evacuation Pause) 56M->24M(256M) 8,234ms
[2,100s][info][gc] GC(5) Concurrent Mark 12,345ms
[3,000s][info][gc] GC(6) Pause Full (G1 Compaction Pause) 200M->50M(256M) 150,678ms
`;

  it("detects G1 algorithm from European locale log", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    expect(result.algorithm).toBe("G1");
  });

  it("parses correct event count", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    expect(result.events.length).toBe(7);
  });

  it("parses pause times with comma decimal separator correctly", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    expect(result.events[0].pauseMs).toBeCloseTo(5.123, 2);
    expect(result.events[1].pauseMs).toBeCloseTo(3.456, 2);
    expect(result.events[6].pauseMs).toBeCloseTo(150.678, 2);
  });

  it("parses timestamps with comma decimal separator correctly", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    expect(result.events[0].timestamp).toBeCloseTo(0.1, 3);
    expect(result.events[4].timestamp).toBeCloseTo(2.0, 3);
    expect(result.events[6].timestamp).toBeCloseTo(3.0, 3);
  });

  it("calculates time span from comma-delimited timestamps", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    // span = (3.0 - 0.1) * 1000 = 2900 ms
    expect(result.timeSpanMs).toBeCloseTo(2900, 0);
    expect(result.hasTimestamps).toBe(true);
  });

  it("treats concurrent event as zero-pause", () => {
    const result = parseGcLog(EUROPEAN_LOCALE_LOG);
    const concurrent = result.events.find(e => e.type === "Concurrent Mark");
    expect(concurrent).toBeDefined();
    expect(concurrent!.pauseMs).toBe(0);
  });
});
