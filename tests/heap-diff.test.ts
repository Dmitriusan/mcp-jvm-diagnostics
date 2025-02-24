import { describe, it, expect } from "vitest";
import { compareHeapHistos } from "../src/analyzers/heap-diff.js";

const BEFORE_HISTO = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        100000       10000000  [B (java.base)
   2:         80000        6400000  java.lang.String (java.base)
   3:         50000        2000000  com.example.UserSession
   4:         30000        1200000  com.example.CacheEntry
   5:         10000         400000  com.example.Request
Total        270000       20000000
`;

const AFTER_HISTO = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        120000       12000000  [B (java.base)
   2:         90000        7200000  java.lang.String (java.base)
   3:        150000        6000000  com.example.UserSession
   4:         25000        1000000  com.example.CacheEntry
   5:         12000         480000  com.example.Request
   6:          5000         500000  com.example.LeakedResource
Total        402000       27180000
`;

const STABLE_HISTO = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        100000       10000000  [B (java.base)
   2:         80000        6400000  java.lang.String (java.base)
   3:         50000        2000000  com.example.UserSession
Total        230000       18400000
`;

describe("Heap Histogram Diff", () => {
  it("detects growing classes", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    expect(report.growing.length).toBeGreaterThan(0);
    const userSession = report.growing.find(e => e.className === "com.example.UserSession");
    expect(userSession).toBeDefined();
    expect(userSession!.bytesDelta).toBe(4000000); // 6M - 2M
    expect(userSession!.instancesDelta).toBe(100000); // 150K - 50K
    expect(userSession!.growthPct).toBe(200); // 200% growth
  });

  it("detects shrinking classes", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    const cacheEntry = report.shrinking.find(e => e.className === "com.example.CacheEntry");
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry!.bytesDelta).toBe(-200000);
  });

  it("detects new classes", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    expect(report.newClasses.length).toBe(1);
    expect(report.newClasses[0].className).toBe("com.example.LeakedResource");
    expect(report.newClasses[0].bytesAfter).toBe(500000);
  });

  it("detects removed classes", () => {
    // Use after as before (has LeakedResource), before as after (doesn't have it)
    const report = compareHeapHistos(AFTER_HISTO, BEFORE_HISTO);
    const removed = report.removedClasses.find(e => e.className === "com.example.LeakedResource");
    expect(removed).toBeDefined();
    expect(removed!.bytesBefore).toBe(500000);
    expect(removed!.bytesAfter).toBe(0);
  });

  it("calculates total heap delta", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    expect(report.totalBytesBefore).toBe(20000000);
    expect(report.totalBytesAfter).toBe(27180000);
    expect(report.totalBytesDelta).toBe(7180000);
  });

  it("flags memory leak candidates for non-JDK classes with significant growth", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    // UserSession grew by 4MB (non-JDK) — should be flagged
    expect(report.issues.some(i => i.includes("com.example.UserSession"))).toBe(true);
    expect(report.issues.some(i => i.includes("memory leak"))).toBe(true);
  });

  it("generates recommendations for growing classes", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    expect(report.recommendations.some(r => r.includes("Investigate"))).toBe(true);
    expect(report.recommendations.some(r => r.includes("Eclipse MAT"))).toBe(true);
  });

  it("reports stable heap when no growth", () => {
    const report = compareHeapHistos(STABLE_HISTO, STABLE_HISTO);
    expect(report.growing.length).toBe(0);
    expect(report.shrinking.length).toBe(0);
    expect(report.totalBytesDelta).toBe(0);
    expect(report.recommendations.some(r => r.includes("stable") || r.includes("no memory leak"))).toBe(true);
  });

  it("handles empty histograms", () => {
    const report = compareHeapHistos("", "");
    expect(report.growing.length).toBe(0);
    expect(report.totalBytesDelta).toBe(0);
  });

  it("sorts growing classes by bytes delta (largest first)", () => {
    const report = compareHeapHistos(BEFORE_HISTO, AFTER_HISTO);
    for (let i = 1; i < report.growing.length; i++) {
      expect(report.growing[i - 1].bytesDelta).toBeGreaterThanOrEqual(report.growing[i].bytesDelta);
    }
  });
});

describe("Heap Histogram Diff — edge cases", () => {
  it("handles completely different histos (no overlapping classes)", () => {
    const histo1 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         10000        1000000  com.example.Alpha
   2:          5000         500000  com.example.Beta
Total         15000        1500000
`;
    const histo2 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:          8000         800000  com.example.Gamma
   2:          3000         300000  com.example.Delta
Total         11000        1100000
`;
    const report = compareHeapHistos(histo1, histo2);
    expect(report.newClasses).toHaveLength(2);
    expect(report.removedClasses).toHaveLength(2);
    expect(report.growing).toHaveLength(0);
    expect(report.shrinking).toHaveLength(0);
    expect(report.newClasses[0].className).toBe("com.example.Gamma");
  });

  it("handles histo with only JDK classes (no leak flags)", () => {
    const histo1 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        100000       10000000  [B (java.base)
   2:         80000        6400000  java.lang.String (java.base)
Total        180000       16400000
`;
    const histo2 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:        200000       20000000  [B (java.base)
   2:        160000       12800000  java.lang.String (java.base)
Total        360000       32800000
`;
    const report = compareHeapHistos(histo1, histo2);
    expect(report.growing).toHaveLength(2);
    // JDK classes should NOT generate "memory leak" issues
    expect(report.issues.filter(i => i.includes("memory leak"))).toHaveLength(0);
    // With 100% heap growth, a general heap growth issue is raised but no leak flagged
    expect(report.issues.some(i => i.includes("Heap grew"))).toBe(true);
  });

  it("detects classloader leak pattern (java.lang.Class growth)", () => {
    const histo1 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         10000        1000000  java.lang.Class (java.base)
Total         10000        1000000
`;
    const histo2 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         12000        1200000  java.lang.Class (java.base)
Total         12000        1200000
`;
    const report = compareHeapHistos(histo1, histo2);
    expect(report.issues.some(i => i.includes("classloader leak"))).toBe(true);
    expect(report.recommendations.some(r => r.includes("classloader"))).toBe(true);
  });

  it("detects finalizer queue backup", () => {
    const histo1 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:          1000         100000  java.lang.ref.Finalizer (java.base)
Total          1000         100000
`;
    const histo2 = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         10000        1000000  java.lang.ref.Finalizer (java.base)
Total         10000        1000000
`;
    const report = compareHeapHistos(histo1, histo2);
    expect(report.issues.some(i => i.includes("Finalizer queue grew"))).toBe(true);
    expect(report.recommendations.some(r => r.includes("Cleaner"))).toBe(true);
  });

  it("handles malformed histo (random text)", () => {
    const report = compareHeapHistos("not a histo at all", "also not valid");
    expect(report.totalBytesBefore).toBe(0);
    expect(report.totalBytesAfter).toBe(0);
    expect(report.growing).toHaveLength(0);
  });

  it("handles histo with single entry (before empty, after has data)", () => {
    const histo = `
 num     #instances         #bytes  class name (module)
-------------------------------------------------------
   1:         50000        5000000  com.example.Leaked
Total         50000        5000000
`;
    const report = compareHeapHistos("", histo);
    expect(report.newClasses).toHaveLength(1);
    expect(report.newClasses[0].className).toBe("com.example.Leaked");
    expect(report.newClasses[0].bytesAfter).toBe(5000000);
  });
});
