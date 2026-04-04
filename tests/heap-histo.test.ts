import { describe, it, expect } from "vitest";
import { parseHeapHisto } from "../src/parsers/heap-histo.js";

const SAMPLE_HISTO = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        285032       45605120  [B (java.base)
   2:        250411       12019728  java.lang.String (java.base)
   3:         92345        7387600  java.lang.Object[] (java.base)
   4:         45123        3609840  java.util.HashMap$Node (java.base)
   5:         12345        2469000  com.example.UserSession
   6:          8901        1780200  com.example.CacheEntry
   7:         30000        1440000  java.lang.Class (java.base)
   8:          5000         400000  java.lang.reflect.Method (java.base)
   9:          2000         160000  java.util.concurrent.ConcurrentHashMap$Node (java.base)
  10:          1500         120000  java.lang.ref.Finalizer (java.base)
Total        732657       74991488
`;

describe("parseHeapHisto", () => {
  it("parses standard jmap -histo output", () => {
    const report = parseHeapHisto(SAMPLE_HISTO);
    expect(report.entries.length).toBe(10);
    expect(report.totalInstances).toBe(732657);
    expect(report.totalBytes).toBe(74991488);
  });

  it("extracts class name and module", () => {
    const report = parseHeapHisto(SAMPLE_HISTO);
    expect(report.entries[0].className).toBe("[B");
    expect(report.entries[0].module).toBe("java.base");
    expect(report.entries[4].className).toBe("com.example.UserSession");
  });

  it("preserves rank ordering", () => {
    const report = parseHeapHisto(SAMPLE_HISTO);
    expect(report.entries[0].rank).toBe(1);
    expect(report.entries[9].rank).toBe(10);
  });

  it("detects byte arrays consuming >40% of heap", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:       1000000       50000000  [B (java.base)
   2:        500000       10000000  java.lang.String (java.base)
Total       1500000       60000000
`;
    const report = parseHeapHisto(histo);
    // [B is 83% of heap
    expect(report.issues.some(i => i.className === "[B" && i.severity === "WARNING")).toBe(true);
  });

  it("detects potential memory leak in application class", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        100000       60000000  com.example.LeakyObject
   2:         50000       40000000  java.lang.String (java.base)
Total        150000      100000000
`;
    const report = parseHeapHisto(histo);
    // com.example.LeakyObject is 60% of heap — CRITICAL
    expect(report.issues.some(i => i.severity === "CRITICAL" && i.className === "com.example.LeakyObject")).toBe(true);
    expect(report.recommendations.some(r => r.includes("LeakyObject"))).toBe(true);
  });

  it("detects high finalizer count", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        200000       20000000  [B (java.base)
   2:         15000        1200000  java.lang.ref.Finalizer (java.base)
Total        215000       21200000
`;
    const report = parseHeapHisto(histo);
    expect(report.issues.some(i => i.className === "java.lang.ref.Finalizer")).toBe(true);
    expect(report.recommendations.some(r => r.includes("Cleaner") || r.includes("finalize"))).toBe(true);
  });

  it("detects classloader leak", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        200000       20000000  [B (java.base)
   2:         35000        2800000  java.lang.Class (java.base)
Total        235000       22800000
`;
    const report = parseHeapHisto(histo);
    expect(report.issues.some(i => i.className === "java.lang.Class" && i.message.includes("classloader"))).toBe(true);
  });

  it("reports healthy histogram", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         50000        3000000  [B (java.base)
   2:         30000        3000000  java.lang.String (java.base)
   3:         10000        2000000  java.lang.Object[] (java.base)
   4:          5000        2000000  java.util.HashMap$Node (java.base)
Total         95000       10000000
`;
    const report = parseHeapHisto(histo);
    expect(report.issues.filter(i => i.severity === "CRITICAL")).toHaveLength(0);
    expect(report.issues.filter(i => i.severity === "WARNING")).toHaveLength(0);
    expect(report.recommendations.some(r => r.includes("healthy"))).toBe(true);
  });

  it("handles empty input", () => {
    const report = parseHeapHisto("");
    expect(report.entries).toHaveLength(0);
    expect(report.issues.some(i => i.severity === "CRITICAL")).toBe(true);
  });

  it("handles entries without module", () => {
    const histo = `
 num     #instances         #bytes  class name
-------------------------------------------------------
   1:         50000        5000000  [B
   2:         30000        3000000  com.example.Foo
Total         80000        8000000
`;
    const report = parseHeapHisto(histo);
    expect(report.entries.length).toBe(2);
    expect(report.entries[0].module).toBeNull();
    expect(report.entries[1].className).toBe("com.example.Foo");
  });

  it("detects high instance count for application class", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:       1000000       10000000  [B (java.base)
   2:        200000         500000  com.example.SmallDTO
Total       1200000       10500000
`;
    const report = parseHeapHisto(histo);
    // 200K instances of an app class (< 10% of heap but >100K instances)
    expect(report.issues.some(i => i.className === "com.example.SmallDTO" && i.severity === "WARNING")).toBe(true);
  });

  it("detects high instance count for application class ranked outside top 30", () => {
    // Build a histogram with 31 JDK-internal entries followed by an app class
    // with >100K instances. Without scanning beyond top 30, this would be missed.
    const jdkLines = Array.from({ length: 30 }, (_, i) =>
      `  ${i + 1}:        ${50000 - i * 100}        ${(50000 - i * 100) * 100}  java.util.HashMap$Node (java.base)`
    ).join("\n");
    const appLine = `  31:        150000          450000  com.example.TinyEvent`;
    const histo = ` num     #instances         #bytes  class name (module)\n-------------------------------------------------------\n${jdkLines}\n${appLine}\nTotal       1650000      500000000`;
    const report = parseHeapHisto(histo);
    // com.example.TinyEvent is rank 31 — only caught by the all-entries instance-count scan
    expect(report.issues.some(i => i.className === "com.example.TinyEvent" && i.severity === "WARNING")).toBe(true);
  });
});
