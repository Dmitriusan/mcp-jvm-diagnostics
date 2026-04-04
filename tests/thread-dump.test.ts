import { describe, it, expect } from "vitest";
import { parseThreadDump } from "../src/parsers/thread-dump.js";
import { detectDeadlocks } from "../src/analyzers/deadlock.js";
import { analyzeContention } from "../src/analyzers/contention.js";

const SAMPLE_THREAD_DUMP = `
2026-03-07 10:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode, sharing):

"main" #1 prio=5 os_prio=0 cpu=150.00ms elapsed=10.00s tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.process(App.java:42)
\tat com.example.App.main(App.java:10)

"http-nio-8080-exec-1" #20 daemon prio=5 os_prio=0 cpu=50.00ms elapsed=8.00s tid=0x00007f1234567891 nid=0x14 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)
\tat com.example.Controller.handle(Controller.java:30)

"http-nio-8080-exec-2" #21 daemon prio=5 os_prio=0 cpu=30.00ms elapsed=8.00s tid=0x00007f1234567892 nid=0x15 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.getData(Service.java:55)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)
\tat com.example.Controller.handle(Controller.java:30)

"worker-1" #30 daemon prio=5 os_prio=0 cpu=200.00ms elapsed=9.00s tid=0x00007f1234567893 nid=0x1e runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Worker.run(Worker.java:15)
\t- locked <0x000000076ab00000> (a java.lang.Object)

"GC Thread#0" #2 daemon prio=5 os_prio=0 tid=0x00007f1234567894 nid=0x2 runnable

"Reference Handler" #3 daemon prio=10 os_prio=0 tid=0x00007f1234567895 nid=0x3 waiting on condition
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.ref.Reference.waitForReferencePendingList(java.base@21/Native Method)
\t- waiting on <0x000000076cc00000> (a java.lang.ref.Reference$Lock)
`;

const DEADLOCK_DUMP = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"Thread-A" #10 prio=5 os_prio=0 tid=0x00007f0001 nid=0xa waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.DeadlockDemo.methodA(DeadlockDemo.java:20)
\t- waiting to lock <0x000000076ab00001> (a java.lang.Object)
\t- locked <0x000000076ab00000> (a java.lang.Object)

"Thread-B" #11 prio=5 os_prio=0 tid=0x00007f0002 nid=0xb waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.DeadlockDemo.methodB(DeadlockDemo.java:30)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)
\t- locked <0x000000076ab00001> (a java.lang.Object)
`;

describe("Thread Dump Parser", () => {
  it("parses JVM info", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    expect(result.jvmInfo).toContain("OpenJDK");
  });

  it("parses timestamp", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    expect(result.timestamp).toBe("2026-03-07 10:00:00");
  });

  it("parses all threads", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    expect(result.threads.length).toBe(6);
  });

  it("parses thread names correctly", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const names = result.threads.map(t => t.name);
    expect(names).toContain("main");
    expect(names).toContain("http-nio-8080-exec-1");
    expect(names).toContain("worker-1");
    expect(names).toContain("GC Thread#0");
  });

  it("detects thread states", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const main = result.threads.find(t => t.name === "main");
    expect(main?.state).toBe("RUNNABLE");

    const blocked = result.threads.find(t => t.name === "http-nio-8080-exec-1");
    expect(blocked?.state).toBe("BLOCKED");
  });

  it("detects daemon threads", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const main = result.threads.find(t => t.name === "main");
    expect(main?.isDaemon).toBe(false);

    const exec = result.threads.find(t => t.name === "http-nio-8080-exec-1");
    expect(exec?.isDaemon).toBe(true);
  });

  it("parses waiting-to-lock info", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const blocked = result.threads.find(t => t.name === "http-nio-8080-exec-1");
    expect(blocked?.waitingOn).toBe("0x000000076ab00000");
  });

  it("parses held locks", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const worker = result.threads.find(t => t.name === "worker-1");
    expect(worker?.holdsLocks).toContain("0x000000076ab00000");
  });

  it("parses stack traces", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const main = result.threads.find(t => t.name === "main");
    expect(main?.stackTrace.length).toBe(2);
    expect(main?.stackTrace[0]).toContain("App.process");
  });
});

describe("Deadlock Detector", () => {
  it("detects no deadlocks in normal dump", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    expect(deadlocks.length).toBe(0);
  });

  it("detects deadlock cycle", () => {
    const result = parseThreadDump(DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    expect(deadlocks.length).toBe(1);
    expect(deadlocks[0].threads.length).toBe(2);
  });

  it("identifies threads in deadlock", () => {
    const result = parseThreadDump(DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    const threadNames = deadlocks[0].threads.map(t => t.name).sort();
    expect(threadNames).toEqual(["Thread-A", "Thread-B"]);
  });

  it("provides recommendation for deadlock", () => {
    const result = parseThreadDump(DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    expect(deadlocks[0].recommendation).toBeTruthy();
    expect(deadlocks[0].recommendation.length).toBeGreaterThan(10);
  });
});

describe("Thread Dump Parser — Edge Cases", () => {
  it("handles empty thread dump gracefully", () => {
    const result = parseThreadDump("");
    expect(result.threads.length).toBe(0);
    expect(result.jvmInfo).toBe("");
    expect(result.timestamp).toBe("");
  });

  it("handles thread dump with single thread", () => {
    const singleThread = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"main" #1 prio=5 os_prio=0 tid=0x00007f0001 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Main.main(Main.java:5)
`;
    const result = parseThreadDump(singleThread);
    expect(result.threads.length).toBe(1);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[0].state).toBe("RUNNABLE");
    expect(result.threads[0].isDaemon).toBe(false);
  });

  it("handles thread dump without timestamp", () => {
    const noTimestamp = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"main" #1 prio=5 os_prio=0 tid=0x00007f0001 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Main.main(Main.java:5)
`;
    const result = parseThreadDump(noTimestamp);
    expect(result.timestamp).toBe("");
  });

  it("handles threads without stack traces (GC/VM threads)", () => {
    const gcThread = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"GC Thread#0" #2 daemon prio=5 os_prio=0 tid=0x00007f0001 nid=0x2 runnable

"VM Thread" os_prio=0 tid=0x00007f0002 nid=0x3 runnable
`;
    const result = parseThreadDump(gcThread);
    expect(result.threads.length).toBeGreaterThanOrEqual(1);
    const gcT = result.threads.find(t => t.name === "GC Thread#0");
    expect(gcT?.stackTrace.length).toBe(0);
  });

  it("parses parking-to-wait-for lock info", () => {
    const parkingThread = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"ForkJoinPool-1-worker-1" #15 daemon prio=5 os_prio=0 tid=0x00007f0001 nid=0xf waiting on condition
   java.lang.Thread.State: WAITING (parking)
\tat jdk.internal.misc.Unsafe.park(java.base@21/Native Method)
\t- parking to wait for <0x000000076ff00000> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
\tat java.util.concurrent.locks.LockSupport.park(java.base@21/LockSupport.java:221)
`;
    const result = parseThreadDump(parkingThread);
    const worker = result.threads.find(t => t.name === "ForkJoinPool-1-worker-1");
    expect(worker?.waitingOn).toBe("0x000000076ff00000");
  });

  it("handles Java 21+ thread dump format with os_thread_id in brackets", () => {
    const java21Dump = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"Finalizer" #11 [2523503] daemon prio=8 os_prio=0 cpu=0.42ms elapsed=10.00s tid=0x00007f0001 nid=0x268a0f waiting on condition
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076cc00000> (a java.lang.ref.ReferenceQueue$Lock)
`;
    const result = parseThreadDump(java21Dump);
    const finalizer = result.threads.find(t => t.name === "Finalizer");
    expect(finalizer).toBeDefined();
    expect(finalizer?.isDaemon).toBe(true);
    expect(finalizer?.priority).toBe(8);
  });
});

describe("Contention Analyzer", () => {
  it("detects contention hotspots", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    expect(contention.hotspots.length).toBe(1);
    expect(contention.hotspots[0].lock).toBe("0x000000076ab00000");
    expect(contention.hotspots[0].blockedCount).toBe(2);
    expect(contention.hotspots[0].holderThread).toBe("worker-1");
  });

  it("lists waiting threads", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    expect(contention.hotspots[0].waitingThreads).toContain("http-nio-8080-exec-1");
    expect(contention.hotspots[0].waitingThreads).toContain("http-nio-8080-exec-2");
  });

  it("generates recommendations for contention", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    expect(contention.recommendations.length).toBeGreaterThan(0);
  });
});

// Thread-Multi-Lock holds two locks (LOCK_0 and LOCK_1) and waits for LOCK_2.
// Thread-Waiter holds LOCK_2 and waits for LOCK_1.
// The cycle lock for Thread-Multi-Lock is LOCK_1 (what Thread-Waiter needs),
// NOT LOCK_0 (just the first lock in holdsLocks).
const MULTI_LOCK_DEADLOCK_DUMP = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"Thread-Multi-Lock" #10 prio=5 os_prio=0 tid=0x00007f0001 nid=0xa waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.MultiLockDemo.methodA(MultiLockDemo.java:20)
\t- waiting to lock <0x000000076ab00002> (a java.lang.Object)
\t- locked <0x000000076ab00000> (a java.lang.Object)
\t- locked <0x000000076ab00001> (a java.lang.Object)

"Thread-Waiter" #11 prio=5 os_prio=0 tid=0x00007f0002 nid=0xb waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.MultiLockDemo.methodB(MultiLockDemo.java:30)
\t- waiting to lock <0x000000076ab00001> (a java.lang.Object)
\t- locked <0x000000076ab00002> (a java.lang.Object)
`;

const POOL_EXHAUSTION_DUMP = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"pool-1-thread-1" #10 daemon prio=5 os_prio=0 tid=0x00007f0001 nid=0xa waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.call(Service.java:20)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"pool-1-thread-2" #11 daemon prio=5 os_prio=0 tid=0x00007f0002 nid=0xb waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.call(Service.java:20)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"pool-1-thread-3" #12 daemon prio=5 os_prio=0 tid=0x00007f0003 nid=0xc waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
\tat com.example.Service.call(Service.java:20)
\t- waiting to lock <0x000000076ab00000> (a java.lang.Object)

"pool-1-thread-4" #13 daemon prio=5 os_prio=0 tid=0x00007f0004 nid=0xd runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Service.call(Service.java:20)
\t- locked <0x000000076ab00000> (a java.lang.Object)
`;

const WAITING_STARVATION_DUMP = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13 mixed mode):

"consumer-1" #10 daemon prio=5 os_prio=0 tid=0x00007f0001 nid=0xa in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-2" #11 daemon prio=5 os_prio=0 tid=0x00007f0002 nid=0xb in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-3" #12 daemon prio=5 os_prio=0 tid=0x00007f0003 nid=0xc in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-4" #13 daemon prio=5 os_prio=0 tid=0x00007f0004 nid=0xd in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-5" #14 daemon prio=5 os_prio=0 tid=0x00007f0005 nid=0xe in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-6" #15 daemon prio=5 os_prio=0 tid=0x00007f0006 nid=0xf in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-7" #16 daemon prio=5 os_prio=0 tid=0x00007f0007 nid=0x10 in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"consumer-8" #17 daemon prio=5 os_prio=0 tid=0x00007f0008 nid=0x11 in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
\tat java.lang.Object.wait(java.base@21/Native Method)
\t- waiting on <0x000000076bb00000> (a java.util.concurrent.LinkedBlockingQueue)

"producer-1" #18 daemon prio=5 os_prio=0 tid=0x00007f0009 nid=0x12 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Producer.produce(Producer.java:15)

"main" #1 prio=5 os_prio=0 tid=0x00007f000a nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)
`;

const VIRTUAL_THREAD_DUMP = `
Full thread dump OpenJDK 64-Bit Server VM (21.0.5+11 mixed mode):

"VirtualThreadScheduler-worker-1" #5 daemon prio=5 os_prio=0 tid=0x00007f0001 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Handler.handle(Handler.java:20)

"VirtualThreadScheduler-worker-2" #6 daemon prio=5 os_prio=0 tid=0x00007f0002 nid=0x2 waiting on condition
   java.lang.Thread.State: WAITING (parking)
\tat jdk.internal.misc.Unsafe.park(java.base@21/Native Method)

"main" #1 prio=5 os_prio=0 tid=0x00007f0003 nid=0x3 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:5)
`;

describe("Contention Analyzer — pool exhaustion", () => {
  it("warns when majority of a named thread pool is BLOCKED", () => {
    const result = parseThreadDump(POOL_EXHAUSTION_DUMP);
    const contention = analyzeContention(result.threads);
    // 3 of 4 pool-1-thread-* are BLOCKED (75%) — exceeds 50% threshold
    expect(contention.recommendations.some(r => r.includes("pool-") && r.includes("BLOCKED"))).toBe(true);
  });

  it("does not warn when pool has fewer than half blocked", () => {
    // In SAMPLE_THREAD_DUMP the http-nio threads (2) and worker (1) form a pool,
    // but only 2/3 "http-" or "worker-" pattern threads match individually and only
    // the "http-" pool is >50% blocked — this is a sanity check that normal contention
    // in a pool without exhaustion doesn't fire the pool exhaustion warning.
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    // "worker-" pool: 1 thread total, 0 BLOCKED — no exhaustion warning for worker-
    expect(
      contention.recommendations.some(r => r.includes("worker-") && r.includes("pool exhaustion"))
    ).toBe(false);
  });
});

describe("Contention Analyzer — WAITING starvation", () => {
  it("warns when more than 70% of threads are in WAITING state", () => {
    const result = parseThreadDump(WAITING_STARVATION_DUMP);
    const contention = analyzeContention(result.threads);
    // 8 of 10 threads are WAITING (80%) — exceeds the 70% threshold
    expect(contention.recommendations.some(r => r.includes("WAITING") && r.includes("starvation"))).toBe(true);
  });

  it("does not flag starvation when WAITING threads are below threshold", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    // Only 1 of 6 threads is WAITING (<70%)
    expect(contention.recommendations.some(r => r.includes("starvation"))).toBe(false);
  });
});

describe("Contention Analyzer — virtual thread pools", () => {
  it("adds virtual-thread caveat when VirtualThreadScheduler threads are present", () => {
    const result = parseThreadDump(VIRTUAL_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    expect(contention.recommendations.some(r => r.includes("Virtual thread pool"))).toBe(true);
    expect(contention.recommendations.some(r => r.includes("carrier thread"))).toBe(true);
  });

  it("does not add virtual-thread caveat for platform thread dumps", () => {
    const result = parseThreadDump(SAMPLE_THREAD_DUMP);
    const contention = analyzeContention(result.threads);
    expect(contention.recommendations.some(r => r.includes("Virtual thread pool"))).toBe(false);
  });
});

describe("Deadlock Detector — multiple locks per thread", () => {
  it("detects the deadlock when a thread holds more than one lock", () => {
    const result = parseThreadDump(MULTI_LOCK_DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    expect(deadlocks.length).toBe(1);
    expect(deadlocks[0].threads.length).toBe(2);
  });

  it("reports the cycle-forming lock, not the first lock held", () => {
    const result = parseThreadDump(MULTI_LOCK_DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    const multiLockEntry = deadlocks[0].threads.find(t => t.name === "Thread-Multi-Lock");
    expect(multiLockEntry).toBeDefined();
    // Thread-Multi-Lock holds [0xLOCK_0, 0xLOCK_1] and waits for 0xLOCK_2.
    // Thread-Waiter waits for 0xLOCK_1, so that is the cycle-forming lock.
    expect(multiLockEntry!.holdsLock).toBe("0x000000076ab00001");
    // The first lock (0xLOCK_0) is NOT the cycle-forming one
    expect(multiLockEntry!.holdsLock).not.toBe("0x000000076ab00000");
  });

  it("reports correct waitingOn for each thread in cycle", () => {
    const result = parseThreadDump(MULTI_LOCK_DEADLOCK_DUMP);
    const deadlocks = detectDeadlocks(result.threads);
    const multiLockEntry = deadlocks[0].threads.find(t => t.name === "Thread-Multi-Lock");
    const waiterEntry = deadlocks[0].threads.find(t => t.name === "Thread-Waiter");
    expect(multiLockEntry!.waitingOn).toBe("0x000000076ab00002");
    expect(waiterEntry!.waitingOn).toBe("0x000000076ab00001");
  });
});
