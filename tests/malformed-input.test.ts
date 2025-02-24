import { describe, it, expect } from "vitest";
import { parseThreadDump } from "../src/parsers/thread-dump.js";
import { parseGcLog } from "../src/parsers/gc-log.js";
import { parseHeapHisto } from "../src/parsers/heap-histo.js";

describe("Thread dump parser — malformed/truncated input", () => {
  it("handles Windows \\r\\n line endings", () => {
    const dump = [
      "2026-03-07 10:00:00",
      'Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):',
      "",
      '"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable',
      "   java.lang.Thread.State: RUNNABLE",
      "\tat com.example.App.main(App.java:10)",
      "",
    ].join("\r\n");

    const result = parseThreadDump(dump);
    expect(result.threads.length).toBe(1);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[0].state).toBe("RUNNABLE");
    expect(result.threads[0].stackTrace.length).toBe(1);
  });

  it("handles binary garbage input without crashing", () => {
    const garbage = Buffer.from([
      0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xde,
      0xad, 0xbe, 0xef, 0x00, 0x00, 0x00, 0x01,
    ]).toString("utf8");

    const result = parseThreadDump(garbage);
    expect(result.threads).toEqual([]);
    expect(result.jvmInfo).toBe("");
    expect(result.timestamp).toBe("");
  });

  it("handles truncated dump cut off mid-thread", () => {
    const truncated = `2026-03-07 10:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.process(App.java:42)
\tat com.example.App.main(App.java:10)

"worker-1" #30 daemon prio=5 os_prio=0 tid=0x00007f1234567893 nid=0x1e runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Worker.run(Worker.java:15)`;
    // No trailing newline — dump ends abruptly mid-thread

    const result = parseThreadDump(truncated);
    expect(result.threads.length).toBe(2);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[1].name).toBe("worker-1");
    expect(result.threads[1].stackTrace.length).toBe(1);
  });

  it("handles thread with no stack trace (GC/VM threads)", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"GC Thread#0" os_prio=0 tid=0x00007f1234500000 nid=0x5 runnable

"VM Periodic Task Thread" os_prio=0 tid=0x00007f1234500001 nid=0x6 waiting on condition

"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)
`;

    const result = parseThreadDump(dump);
    // GC Thread and VM Thread have no stack traces
    const gcThread = result.threads.find((t) => t.name === "GC Thread#0");
    expect(gcThread).toBeDefined();
    expect(gcThread!.stackTrace).toEqual([]);
  });

  it("handles mixed valid and invalid lines", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

RANDOM GARBAGE LINE
another invalid line 12345
=== MORE GARBAGE ===

"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)

MORE GARBAGE AFTER THREAD

"worker-1" #2 daemon prio=5 os_prio=0 tid=0x00007f1234567891 nid=0x2 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Worker.run(Worker.java:5)
`;

    const result = parseThreadDump(dump);
    expect(result.threads.length).toBe(2);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[1].name).toBe("worker-1");
  });

  it("handles empty string input", () => {
    const result = parseThreadDump("");
    expect(result.threads).toEqual([]);
    expect(result.jvmInfo).toBe("");
    expect(result.timestamp).toBe("");
  });

  it("handles thread header with minimal fields", () => {
    const dump = `"bare-thread" runnable
`;
    const result = parseThreadDump(dump);
    expect(result.threads.length).toBe(1);
    expect(result.threads[0].name).toBe("bare-thread");
    expect(result.threads[0].tid).toBe("");
    expect(result.threads[0].nid).toBe("");
    expect(result.threads[0].priority).toBe(5); // default
  });

  it("handles very long thread names with special characters", () => {
    const dump = `"pool-1-thread-[special chars] <foo> 'bar' \\"baz\\"" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)
`;
    const result = parseThreadDump(dump);
    expect(result.threads.length).toBe(1);
    // The regex captures everything between the first pair of quotes
    expect(result.threads[0].name).toContain("pool-1-thread-");
  });

  it("handles dump with only JVM header and no threads", () => {
    const dump = `2026-03-07 10:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

JNI global refs: 15
`;
    const result = parseThreadDump(dump);
    expect(result.threads).toEqual([]);
    expect(result.jvmInfo).toContain("OpenJDK");
    expect(result.timestamp).toBe("2026-03-07 10:00:00");
  });
});

describe("GC log parser — malformed input", () => {
  it("handles empty string", () => {
    const result = parseGcLog("");
    expect(result.events).toEqual([]);
    expect(result.algorithm).toBe("Unknown");
  });

  it("handles random text that isn't a GC log", () => {
    const result = parseGcLog(
      "This is not a GC log.\nJust some random text.\n12345"
    );
    expect(result.events).toEqual([]);
  });

  it("handles Windows \\r\\n line endings", () => {
    const log = [
      "[0.500s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 5.123ms",
      "[1.200s][info][gc] GC(1) Pause Young (Normal) (G1 Evacuation Pause) 32M->12M(256M) 3.456ms",
    ].join("\r\n");

    const result = parseGcLog(log);
    expect(result.events.length).toBe(2);
    expect(result.events[0].pauseMs).toBeCloseTo(5.123, 2);
  });

  it("handles partial/truncated GC events", () => {
    const log = `[0.500s][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 24M->8M(256M) 5.123ms
[1.200s][info][gc] GC(1) Pause Young (Normal) this line is truncated`;

    const result = parseGcLog(log);
    // First event should parse, truncated one should be skipped
    expect(result.events.length).toBe(1);
  });
});

describe("Heap histogram parser — malformed input", () => {
  it("handles empty string", () => {
    const result = parseHeapHisto("");
    expect(result.entries).toEqual([]);
  });

  it("handles Windows \\r\\n line endings", () => {
    const histo = [
      " num     #instances         #bytes  class name (module)",
      "----------------------------------------------",
      "   1:        123456       12345678  java.lang.String (java.base)",
      "   2:         98765        9876543  [B (java.base)",
      "Total        222221       22222221",
    ].join("\r\n");

    const result = parseHeapHisto(histo);
    expect(result.entries.length).toBe(2);
    expect(result.entries[0].className).toBe("java.lang.String");
  });

  it("handles garbage input", () => {
    const result = parseHeapHisto("not a histogram\nrandom text 12345");
    expect(result.entries).toEqual([]);
  });
});
