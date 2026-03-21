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
