import { describe, it, expect } from "vitest";
import { parseJfrSummary } from "../src/parsers/jfr-summary.js";

const BASIC_SUMMARY = `
 Start: 2024-11-15 10:30:00
 Duration: 60 s

 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationInNewTLAB             542       28184
 jdk.GCPhasePause                          123       15600
 jdk.JavaMonitorEnter                       45        5400
 jdk.ThreadStart                            12        1440
 jdk.ClassLoad                              89        9800
 jdk.FileRead                              200       16000
 jdk.SocketRead                            150       12000
 jdk.Compilation                            67        8040
`;

describe("parseJfrSummary — basic parsing", () => {
  it("should parse event types with counts and sizes", () => {
    const result = parseJfrSummary(BASIC_SUMMARY);
    expect(result.events.length).toBe(8);
    expect(result.totalEvents).toBe(542 + 123 + 45 + 12 + 89 + 200 + 150 + 67);
  });

  it("should extract start time and duration", () => {
    const result = parseJfrSummary(BASIC_SUMMARY);
    expect(result.startTime).toBe("2024-11-15 10:30:00");
    expect(result.duration).toBe("60 s");
  });

  it("should calculate total size", () => {
    const result = parseJfrSummary(BASIC_SUMMARY);
    expect(result.totalSize).toBe(28184 + 15600 + 5400 + 1440 + 9800 + 16000 + 12000 + 8040);
  });

  it("should parse individual event correctly", () => {
    const result = parseJfrSummary(BASIC_SUMMARY);
    const tlabEvent = result.events.find(e => e.name === "jdk.ObjectAllocationInNewTLAB");
    expect(tlabEvent).toBeDefined();
    expect(tlabEvent!.count).toBe(542);
    expect(tlabEvent!.size).toBe(28184);
  });

  it("should throw on empty input", () => {
    expect(() => parseJfrSummary("")).toThrow("Empty JFR summary input");
    expect(() => parseJfrSummary("   ")).toThrow("Empty JFR summary input");
  });

  it("should throw when no events found", () => {
    expect(() => parseJfrSummary("Some random text\nwith no event data")).toThrow("No JFR events found");
  });
});

describe("parseJfrSummary — issue detection", () => {
  it("should detect high GC activity", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.GCPhasePause                         1500       90000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("GC"))).toBe(true);
  });

  it("should detect allocations outside TLAB", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationOutsideTLAB           200       10000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("TLAB"))).toBe(true);
  });

  it("should detect lock contention", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.JavaMonitorEnter                      800       48000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("contention"))).toBe(true);
  });

  it("should detect excessive exceptions", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.JavaExceptionThrow                    700       42000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("exception"))).toBe(true);
  });

  it("should detect thread churn", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ThreadStart                           300       18000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("thread"))).toBe(true);
  });

  it("should report no issues for healthy recording", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationInNewTLAB              50        2500
 jdk.GCPhasePause                           10        1200
 jdk.ThreadStart                             5         600
`;
    const result = parseJfrSummary(input);
    expect(result.issues.length).toBe(0);
  });

  it("should detect excessive Object.wait() events", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.JavaMonitorWait                      3000      180000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("Object.wait()"))).toBe(true);
    expect(result.recommendations.some(r => r.includes("producer"))).toBe(true);
  });

  it("should not flag low Object.wait() count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.JavaMonitorWait                       500       30000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("Object.wait()"))).toBe(false);
  });

  it("should flag allocations outside TLAB at exactly the threshold (100)", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationOutsideTLAB          100        5000
 jdk.ObjectAllocationInNewTLAB            500       25000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("TLAB"))).toBe(true);
  });

  it("should not flag allocations outside TLAB below threshold with low ratio (99 count, low ratio)", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationOutsideTLAB           99        4950
 jdk.ObjectAllocationInNewTLAB           2000      100000
`;
    // 99 / (99 + 2000) = 4.7% < 20% — should not fire on ratio either
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("TLAB"))).toBe(false);
  });

  it("should detect large object pressure via ratio when absolute count is low (25/100 = 25%)", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationOutsideTLAB           25        1250
 jdk.ObjectAllocationInNewTLAB             75        3750
`;
    // 25 / (25 + 75) = 25% > 20% — ratio-based detection should fire
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("TLAB"))).toBe(true);
    expect(result.issues.some(i => i.includes("%"))).toBe(true);
  });

  it("should not fire ratio check when outside-TLAB ratio is below 20%", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationOutsideTLAB           10         500
 jdk.ObjectAllocationInNewTLAB            200       10000
`;
    // 10 / (10 + 200) = 4.8% < 20% — neither check should fire
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("TLAB"))).toBe(false);
  });

  it("should detect dominant event type and recommend focus", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.FileRead                            9000      720000
 jdk.SocketRead                           500       40000
 jdk.GCPhasePause                          50        6000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("dominates"))).toBe(true);
  });

  it("should detect high file/socket I/O", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.FileRead                            3000      240000
 jdk.FileWrite                           1500      120000
 jdk.SocketRead                          1200       96000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    // 3000 + 1500 + 1200 = 5700 > 5000 threshold
    expect(result.issues.some(i => i.includes("I/O"))).toBe(true);
  });

  it("should not flag low I/O count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.FileRead                             500       40000
 jdk.SocketRead                           300       24000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("I/O"))).toBe(false);
  });

  it("should detect excessive JIT compilations", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.Compilation                          600       72000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("compilation"))).toBe(true);
  });

  it("should not flag low compilation count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.Compilation                          200       24000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.issues.some(i => i.includes("compilation"))).toBe(false);
  });
});

describe("parseJfrSummary — recommendations for missing issues", () => {
  it("should recommend thread pool for thread churn", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ThreadStart                           300       18000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("thread pool") || r.includes("thread creation"))).toBe(true);
  });

  it("should recommend heap histo analysis for excessive class loading", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ClassLoad                            1500       90000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("analyze_heap_histo"))).toBe(true);
  });

  it("should not recommend thread pool for low thread start count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ThreadStart                            50        3000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("thread pool"))).toBe(false);
  });

  it("should not recommend heap histo for low class load count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ClassLoad                             500       30000
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("analyze_heap_histo"))).toBe(false);
  });

  it("should recommend I/O profiling for high I/O event count", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.FileRead                            3000      240000
 jdk.SocketWrite                         2500      200000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    // 3000 + 2500 = 5500 > 5000
    expect(result.recommendations.some(r => r.includes("async-profiler") || r.includes("batching"))).toBe(true);
  });

  it("should recommend code cache check for excessive JIT compilations", () => {
    const input = `
 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.Compilation                          600       72000
 jdk.ObjectAllocationInNewTLAB            100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.recommendations.some(r => r.includes("ReservedCodeCacheSize"))).toBe(true);
  });
});

describe("parseJfrSummary — edge cases", () => {
  it("should handle events without size column", () => {
    const input = `
 Event Type                Count
 ================================
 jdk.GCPhasePause            50
 jdk.ThreadStart             10
`;
    const result = parseJfrSummary(input);
    expect(result.events.length).toBe(2);
    expect(result.events[0].size).toBe(0);
  });

  it("should handle metadata with colon format", () => {
    const input = `
Start time: 2024-12-01 08:00:00
Duration: 120 s

 Event Type                              Count  Size (bytes)
 =================================================================
 jdk.ObjectAllocationInNewTLAB             100        5000
`;
    const result = parseJfrSummary(input);
    expect(result.startTime).toBe("2024-12-01 08:00:00");
    expect(result.duration).toBe("120 s");
  });
});
