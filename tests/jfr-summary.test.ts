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
