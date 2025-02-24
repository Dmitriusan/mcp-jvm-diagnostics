/**
 * Tests for the diagnose_jvm combined tool logic.
 *
 * The diagnose_jvm tool combines thread dump + GC log analysis with
 * cross-correlation. These tests verify the combined analysis path
 * that individual parser tests don't cover.
 */
import { describe, it, expect } from "vitest";
import { parseThreadDump } from "../src/parsers/thread-dump.js";
import { detectDeadlocks } from "../src/analyzers/deadlock.js";
import { analyzeContention } from "../src/analyzers/contention.js";
import { parseGcLog } from "../src/parsers/gc-log.js";
import { analyzeGcPressure } from "../src/analyzers/gc-pressure.js";

// --- Fixtures ---

const THREAD_DUMP_WITH_GC_THREADS = `
2026-03-13 12:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"main" #1 prio=5 os_prio=0 cpu=100.00ms elapsed=10.00s tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)

"G1 Young RemSet Sampling" #2 daemon prio=5 os_prio=0 cpu=5.00ms elapsed=10.00s tid=0x00007f1234567891 nid=0x2 runnable
   java.lang.Thread.State: RUNNABLE

"G1 Conc#0" #3 daemon prio=5 os_prio=0 cpu=20.00ms elapsed=10.00s tid=0x00007f1234567892 nid=0x3 runnable
   java.lang.Thread.State: RUNNABLE

"http-nio-8080-exec-1" #20 daemon prio=5 os_prio=0 cpu=50.00ms elapsed=8.00s tid=0x00007f1234567893 nid=0x14 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"http-nio-8080-exec-2" #21 daemon prio=5 os_prio=0 cpu=30.00ms elapsed=8.00s tid=0x00007f1234567894 nid=0x15 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"http-nio-8080-exec-3" #22 daemon prio=5 os_prio=0 cpu=25.00ms elapsed=8.00s tid=0x00007f1234567895 nid=0x16 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"http-nio-8080-exec-4" #23 daemon prio=5 os_prio=0 cpu=22.00ms elapsed=8.00s tid=0x00007f1234567896 nid=0x17 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"http-nio-8080-exec-5" #24 daemon prio=5 os_prio=0 cpu=18.00ms elapsed=8.00s tid=0x00007f1234567897 nid=0x18 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"http-nio-8080-exec-6" #25 daemon prio=5 os_prio=0 cpu=15.00ms elapsed=8.00s tid=0x00007f1234567898 nid=0x19 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"worker-1" #30 daemon prio=5 os_prio=0 cpu=200.00ms elapsed=9.00s tid=0x00007f1234567899 nid=0x1e runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Worker.run(Worker.java:15)
\t- locked <0x000000076ab00000> (a java.lang.Object)
`;

const HIGH_PRESSURE_GC_LOG = `
[0.005s][info][gc] Using G1
[0.100s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 240M->230M(256M) 50.0ms
[0.200s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 245M->235M(256M) 55.0ms
[0.300s][info][gc] GC(2) Pause Full (G1 Compaction Pause) 250M->200M(256M) 500.0ms
[0.400s][info][gc] GC(3) Pause Full (G1 Compaction Pause) 252M->210M(256M) 600.0ms
[0.500s][info][gc] GC(4) Pause Full (G1 Compaction Pause) 248M->215M(256M) 550.0ms
[0.600s][info][gc] GC(5) Pause Full (G1 Compaction Pause) 250M->220M(256M) 620.0ms
`;

const HEALTHY_GC_LOG = `
[0.005s][info][gc] Using G1
[0.100s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 5.0ms
[0.500s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 32M->12M(256M) 3.0ms
[1.000s][info][gc] GC(2) Pause Young (Normal) (G1 Evacuation Pause) 40M->16M(256M) 4.0ms
`;

const SIMPLE_THREAD_DUMP = `
2026-03-13 12:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"main" #1 prio=5 os_prio=0 cpu=100.00ms elapsed=10.00s tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)
`;

// --- Helper: replicate diagnose_jvm logic ---

function diagnoseJvm(threadDump?: string, gcLog?: string) {
  if (!threadDump && !gcLog) {
    return { text: "Please provide at least one of: thread_dump or gc_log" };
  }

  const sections: string[] = [];
  sections.push("## JVM Diagnostic Report");

  let threadAnalysis: { parsed: ReturnType<typeof parseThreadDump>; deadlocks: ReturnType<typeof detectDeadlocks>; contention: ReturnType<typeof analyzeContention> } | null = null;
  let gcAnalysis: { parsed: ReturnType<typeof parseGcLog>; pressure: ReturnType<typeof analyzeGcPressure> } | null = null;

  if (threadDump) {
    const parsed = parseThreadDump(threadDump);
    const deadlocks = detectDeadlocks(parsed.threads);
    const contention = analyzeContention(parsed.threads);
    threadAnalysis = { parsed, deadlocks, contention };

    sections.push("\n### Thread Analysis");
    sections.push(`- Total threads: ${parsed.threads.length}`);
    sections.push(`- Deadlocks: ${deadlocks.length > 0 ? `**${deadlocks.length} DETECTED**` : "None"}`);
    sections.push(`- Contention hotspots: ${contention.hotspots.length}`);

    const blockedCount = parsed.threads.filter(t => t.state === "BLOCKED").length;
    const waitingCount = parsed.threads.filter(t => t.state === "WAITING" || t.state === "TIMED_WAITING").length;
    sections.push(`- Blocked threads: ${blockedCount}`);
    sections.push(`- Waiting threads: ${waitingCount}`);
  }

  if (gcLog) {
    const parsed = parseGcLog(gcLog);
    const pressure = analyzeGcPressure(parsed);
    gcAnalysis = { parsed, pressure };

    sections.push("\n### GC Analysis");
    sections.push(`- Algorithm: ${parsed.algorithm}`);
    sections.push(`- Events: ${parsed.events.length}`);
    sections.push(`- Max pause: ${pressure.maxPauseMs.toFixed(1)} ms`);
    sections.push(`- GC overhead: ${pressure.gcOverheadPct.toFixed(1)}%`);
    sections.push(`- Issues: ${pressure.issues.length}`);
  }

  // Cross-correlation
  if (threadAnalysis && gcAnalysis) {
    sections.push("\n### Cross-Correlation");

    const gcThreads = threadAnalysis.parsed.threads.filter(
      t => t.name.includes("GC") || t.name.includes("G1") || t.name.includes("ZGC")
    );
    if (gcThreads.length > 0) {
      sections.push(`- GC-related threads: ${gcThreads.length}`);
    }

    if (gcAnalysis.pressure.gcOverheadPct > 10 && threadAnalysis.contention.hotspots.length > 0) {
      sections.push(`- **Warning**: High GC overhead (${gcAnalysis.pressure.gcOverheadPct.toFixed(1)}%) combined with lock contention — threads may be blocked during GC pauses`);
    }

    if (gcAnalysis.pressure.maxPauseMs > 500 && threadAnalysis.parsed.threads.filter(t => t.state === "BLOCKED").length > 5) {
      sections.push(`- **Warning**: Long GC pauses (${gcAnalysis.pressure.maxPauseMs.toFixed(0)}ms) with many blocked threads — GC may be causing cascading blocks`);
    }
  }

  // Overall assessment
  sections.push("\n### Overall Assessment");
  const issues: string[] = [];
  if (threadAnalysis?.deadlocks.length) issues.push(`${threadAnalysis.deadlocks.length} deadlock(s) — application may be hung`);
  if (threadAnalysis && threadAnalysis.contention.hotspots.length > 3) issues.push("Significant lock contention detected");
  if (gcAnalysis?.pressure.gcOverheadPct && gcAnalysis.pressure.gcOverheadPct > 15) issues.push("High GC overhead — consider heap tuning");
  if (gcAnalysis?.pressure.maxPauseMs && gcAnalysis.pressure.maxPauseMs > 1000) issues.push("GC pauses exceed 1 second — latency impact");

  if (issues.length === 0) {
    sections.push("JVM appears healthy based on provided diagnostics.");
  } else {
    sections.push(`**${issues.length} issue(s) found:**`);
    for (const issue of issues) {
      sections.push(`- ${issue}`);
    }
  }

  return { text: sections.join("\n"), threadAnalysis, gcAnalysis, issues };
}

// --- Tests ---

describe("diagnose_jvm combined analysis", () => {
  it("returns error when no input is provided", () => {
    const result = diagnoseJvm();
    expect(result.text).toContain("Please provide at least one of");
  });

  it("produces thread-only diagnosis when only thread dump is provided", () => {
    const result = diagnoseJvm(SIMPLE_THREAD_DUMP, undefined);
    expect(result.text).toContain("## JVM Diagnostic Report");
    expect(result.text).toContain("### Thread Analysis");
    expect(result.text).not.toContain("### GC Analysis");
    expect(result.text).not.toContain("### Cross-Correlation");
    expect(result.text).toContain("### Overall Assessment");
    expect(result.text).toContain("JVM appears healthy");
  });

  it("produces GC-only diagnosis when only GC log is provided", () => {
    const result = diagnoseJvm(undefined, HEALTHY_GC_LOG);
    expect(result.text).toContain("## JVM Diagnostic Report");
    expect(result.text).toContain("### GC Analysis");
    expect(result.text).not.toContain("### Thread Analysis");
    expect(result.text).not.toContain("### Cross-Correlation");
    expect(result.text).toContain("### Overall Assessment");
  });

  it("produces combined diagnosis with cross-correlation when both inputs provided", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, HIGH_PRESSURE_GC_LOG);
    expect(result.text).toContain("### Thread Analysis");
    expect(result.text).toContain("### GC Analysis");
    expect(result.text).toContain("### Cross-Correlation");
    expect(result.text).toContain("### Overall Assessment");
  });

  it("detects GC-related threads in cross-correlation", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, HEALTHY_GC_LOG);
    expect(result.text).toContain("GC-related threads: 2");
  });

  it("warns about high GC overhead combined with contention", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, HIGH_PRESSURE_GC_LOG);
    expect(result.text).toContain("High GC overhead");
    expect(result.text).toContain("combined with lock contention");
  });

  it("warns about long GC pauses with many blocked threads", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, HIGH_PRESSURE_GC_LOG);
    expect(result.text).toContain("Long GC pauses");
    expect(result.text).toContain("GC may be causing cascading blocks");
  });

  it("reports correct blocked thread count", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, undefined);
    expect(result.text).toContain("Blocked threads: 6");
  });

  it("reports correct contention hotspot count", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, undefined);
    expect(result.text).toContain("Contention hotspots:");
    expect(result.threadAnalysis!.contention.hotspots.length).toBeGreaterThanOrEqual(1);
  });

  it("detects issues in overall assessment for problematic JVM", () => {
    const result = diagnoseJvm(THREAD_DUMP_WITH_GC_THREADS, HIGH_PRESSURE_GC_LOG);
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    expect(result.text).toContain("issue(s) found");
  });

  it("reports healthy JVM when thread dump and GC are both clean", () => {
    const result = diagnoseJvm(SIMPLE_THREAD_DUMP, HEALTHY_GC_LOG);
    expect(result.text).toContain("JVM appears healthy");
    expect(result.issues.length).toBe(0);
  });

  it("handles empty string inputs gracefully", () => {
    const result = diagnoseJvm("", "");
    // Empty strings are falsy — should be treated as no input
    expect(result.text).toContain("Please provide at least one of");
  });
});
