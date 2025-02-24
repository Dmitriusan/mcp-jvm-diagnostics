/**
 * Test against a real thread dump captured from a JetBrains Toolbox process.
 *
 * This validates the parser handles production JVM output correctly,
 * including Java 21+ format with [os_thread_id], Kotlin coroutines,
 * Netty event loops, and VM internal threads.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseThreadDump } from "../src/parsers/thread-dump.js";
import { detectDeadlocks } from "../src/analyzers/deadlock.js";
import { analyzeContention } from "../src/analyzers/contention.js";

const DUMP_PATH = join(__dirname, "fixtures", "jetbrains-toolbox-thread-dump.txt");
const RAW_DUMP = readFileSync(DUMP_PATH, "utf-8");

describe("Real thread dump — JetBrains Toolbox (Java 21)", () => {
  const parsed = parseThreadDump(RAW_DUMP);

  it("extracts JVM info", () => {
    expect(parsed.jvmInfo).toContain("OpenJDK");
    expect(parsed.jvmInfo).toContain("21.0");
  });

  it("extracts timestamp", () => {
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/);
  });

  it("parses all expected threads", () => {
    // The dump declares 42 threads in the SMR info
    // Not all may have parseable headers (VM Thread, VM Periodic Task Thread lack quotes)
    expect(parsed.threads.length).toBeGreaterThanOrEqual(35);
    expect(parsed.threads.length).toBeLessThanOrEqual(50);
  });

  it("identifies daemon threads correctly", () => {
    const daemons = parsed.threads.filter((t) => t.isDaemon);
    // Most threads in JetBrains Toolbox are daemons
    expect(daemons.length).toBeGreaterThan(20);
  });

  it("parses Kotlin coroutine dispatcher threads", () => {
    const coroutineWorkers = parsed.threads.filter((t) =>
      t.name.startsWith("DefaultDispatcher-worker-")
    );
    expect(coroutineWorkers.length).toBeGreaterThanOrEqual(8);
    for (const w of coroutineWorkers) {
      expect(w.isDaemon).toBe(true);
      expect(w.state).toBe("TIMED_WAITING");
      expect(w.stackTrace.some((l) => l.includes("CoroutineScheduler"))).toBe(true);
    }
  });

  it("parses Netty event loop threads", () => {
    const nettyThreads = parsed.threads.filter((t) => t.name.includes("Netty"));
    expect(nettyThreads.length).toBeGreaterThanOrEqual(3);
    for (const t of nettyThreads) {
      expect(t.state).toBe("RUNNABLE");
      expect(t.stackTrace.some((l) => l.includes("io.netty"))).toBe(true);
    }
  });

  it("parses Java 21+ format with os_thread_id in brackets", () => {
    // Java 21 format: "Common-Cleaner" #4 [248651] daemon prio=8
    const cleaner = parsed.threads.find((t) => t.name === "Common-Cleaner");
    expect(cleaner).toBeDefined();
    expect(cleaner!.isDaemon).toBe(true);
    expect(cleaner!.priority).toBe(8);
  });

  it("extracts lock information from Finalizer thread", () => {
    const finalizer = parsed.threads.find((t) => t.name === "Finalizer");
    expect(finalizer).toBeDefined();
    expect(finalizer!.state).toBe("WAITING");
    // Finalizer holds a lock on NativeReferenceQueue$Lock and waits on same object
    expect(finalizer!.holdsLocks.length).toBeGreaterThanOrEqual(1);
  });

  it("parses Netty threads with multiple locks", () => {
    const nettyServer = parsed.threads.find((t) => t.name === "Netty Station Server 1-1");
    expect(nettyServer).toBeDefined();
    // Netty holds 2 locks (Util$2 and EPollSelectorImpl)
    expect(nettyServer!.holdsLocks.length).toBe(2);
    expect(nettyServer!.state).toBe("RUNNABLE");
  });

  it("extracts DBus threads (non-daemon)", () => {
    const dbusSender = parsed.threads.find((t) => t.name === "DBus Sender Thread-1");
    expect(dbusSender).toBeDefined();
    // DBus Sender is NOT a daemon thread
    expect(dbusSender!.isDaemon).toBe(false);
  });

  it("detects no deadlocks in healthy JVM", () => {
    const deadlocks = detectDeadlocks(parsed.threads);
    expect(deadlocks).toHaveLength(0);
  });

  it("runs contention analysis without errors", () => {
    const contention = analyzeContention(parsed.threads);
    expect(contention).toBeDefined();
    expect(contention.hotspots).toBeDefined();
    expect(contention.recommendations).toBeDefined();
  });

  it("correctly handles thread with parking annotation", () => {
    const jnaCleaner = parsed.threads.find((t) => t.name === "JNA Cleaner");
    expect(jnaCleaner).toBeDefined();
    expect(jnaCleaner!.state).toBe("TIMED_WAITING");
    expect(jnaCleaner!.stackTrace.some((l) => l.includes("com.sun.jna"))).toBe(true);
  });

  it("groups thread states correctly", () => {
    const stateGroups = new Map<string, number>();
    for (const t of parsed.threads) {
      stateGroups.set(t.state, (stateGroups.get(t.state) ?? 0) + 1);
    }
    // Expect RUNNABLE, WAITING, TIMED_WAITING at minimum
    expect(stateGroups.has("RUNNABLE")).toBe(true);
    expect(stateGroups.has("WAITING")).toBe(true);
    expect(stateGroups.has("TIMED_WAITING")).toBe(true);
    // No BLOCKED threads in this healthy dump
    expect(stateGroups.get("BLOCKED") ?? 0).toBe(0);
  });
});
