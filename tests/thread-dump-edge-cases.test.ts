import { describe, it, expect } from "vitest";
import { parseThreadDump } from "../src/parsers/thread-dump.js";

describe("Thread dump parser — malformed/edge case inputs", () => {
  it("should return empty threads for empty string", () => {
    const result = parseThreadDump("");
    expect(result.threads).toHaveLength(0);
    expect(result.jvmInfo).toBe("");
    expect(result.timestamp).toBe("");
  });

  it("should return empty threads for random text", () => {
    const result = parseThreadDump("this is not a thread dump at all\njust some random text\n");
    expect(result.threads).toHaveLength(0);
  });

  it("should return empty threads for binary garbage", () => {
    const garbage = Buffer.from([0x00, 0x01, 0xFF, 0xFE, 0x89, 0x50, 0x4E, 0x47]).toString("utf8");
    const result = parseThreadDump(garbage);
    expect(result.threads).toHaveLength(0);
  });

  it("should handle Windows line endings (\\r\\n)", () => {
    const dump = [
      '2026-03-11 10:00:00',
      'Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):',
      '',
      '"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable',
      '   java.lang.Thread.State: RUNNABLE',
      '\tat com.example.App.main(App.java:10)',
      '',
    ].join("\r\n");

    const result = parseThreadDump(dump);
    expect(result.threads.length).toBeGreaterThanOrEqual(1);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[0].state).toBe("RUNNABLE");
  });

  it("should handle truncated dump (header only, no threads)", () => {
    const dump = "Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):\n";
    const result = parseThreadDump(dump);
    expect(result.jvmInfo).toContain("OpenJDK");
    expect(result.threads).toHaveLength(0);
  });

  it("should handle truncated dump (thread header but no stack)", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].name).toBe("main");
    expect(result.threads[0].stackTrace).toHaveLength(0);
  });

  it("should handle thread with state line but no stack frames", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"GC-thread" #2 daemon prio=9 os_prio=0 tid=0x00007f1234567891 nid=0x2 runnable
   java.lang.Thread.State: RUNNABLE

`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].name).toBe("GC-thread");
    expect(result.threads[0].state).toBe("RUNNABLE");
    expect(result.threads[0].stackTrace).toHaveLength(0);
  });

  it("should handle dump with no JVM info header", () => {
    const dump = `"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)

`;
    const result = parseThreadDump(dump);
    expect(result.jvmInfo).toBe("");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].name).toBe("main");
  });

  it("should handle very long thread names with special characters", () => {
    const dump = `"pool-1-thread-1 [handling request /api/v2/users?q=test&limit=100]" #50 daemon prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x32 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.Handler.handle(Handler.java:42)

`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].name).toContain("pool-1-thread-1");
  });

  it("should handle multiple consecutive empty lines", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):



"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)



"worker" #2 daemon prio=5 os_prio=0 tid=0x00007f1234567891 nid=0x2 waiting on condition
   java.lang.Thread.State: TIMED_WAITING (sleeping)
\tat java.lang.Thread.sleep(java.base@21.0.2/Native Method)

`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(2);
  });

  it("should handle dump with only JNI global references line", () => {
    const dump = `Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

JNI global refs: 15, weak refs: 0

`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(0);
    expect(result.jvmInfo).toContain("OpenJDK");
  });

  it("should handle mixed valid and garbage content", () => {
    const dump = `Some garbage before the dump
2026-03-11 10:00:00
Full thread dump OpenJDK 64-Bit Server VM (21.0.2+13):

"main" #1 prio=5 os_prio=0 tid=0x00007f1234567890 nid=0x1 runnable
   java.lang.Thread.State: RUNNABLE
\tat com.example.App.main(App.java:10)

some garbage after
more garbage
`;
    const result = parseThreadDump(dump);
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].name).toBe("main");
    expect(result.timestamp).toBe("2026-03-11 10:00:00");
  });
});
