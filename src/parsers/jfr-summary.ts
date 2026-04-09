/**
 * Parser for `jfr summary <file>` output.
 *
 * The jfr summary command prints event statistics from a JDK Flight Recorder
 * (.jfr) file: event types, counts, and sizes. This parser extracts that data
 * and produces analytical insights.
 */

export interface JfrEvent {
  name: string;
  count: number;
  size: number; // bytes
}

export interface JfrSummary {
  events: JfrEvent[];
  totalEvents: number;
  totalSize: number;
  startTime?: string;
  duration?: string;
  issues: string[];
  recommendations: string[];
}

/**
 * Parse `jfr summary` output text.
 *
 * Handles both the tabular format:
 *   Event Type                          Count  Size (bytes)
 *   ===========================================================
 *   jdk.ObjectAllocationInNewTLAB         542       28184
 *
 * And the summary lines at the top (start time, duration, etc.).
 */
export function parseJfrSummary(text: string): JfrSummary {
  if (!text || text.trim().length === 0) {
    throw new Error("Empty JFR summary input");
  }

  const lines = text.split("\n");
  const events: JfrEvent[] = [];
  let startTime: string | undefined;
  let duration: string | undefined;

  // Match event rows: event_name  count  size
  // Format: "  jdk.GCPhasePause                     123      45678"
  const eventLineRegex = /^\s*([\w.]+(?:\s+\([^)]+\))?)\s+(\d+)\s+(\d+)\s*$/;

  // Alternative format without size column
  const eventNoSizeRegex = /^\s*([\w.]+)\s+(\d+)\s*$/;

  // Header metadata patterns
  const startTimeRegex = /start\s*(?:time)?[:=]\s*(.+)/i;
  const durationRegex = /duration[:=]\s*(.+)/i;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines, headers, separators
    if (!trimmed || /^[=\-]+$/.test(trimmed) || /^Event\s+Type/i.test(trimmed)) {
      continue;
    }

    // Check for metadata lines
    const startMatch = trimmed.match(startTimeRegex);
    if (startMatch) {
      startTime = startMatch[1].trim();
      continue;
    }

    const durMatch = trimmed.match(durationRegex);
    if (durMatch) {
      duration = durMatch[1].trim();
      continue;
    }

    // Parse event lines (with size)
    const eventMatch = line.match(eventLineRegex);
    if (eventMatch) {
      events.push({
        name: eventMatch[1].trim(),
        count: parseInt(eventMatch[2], 10),
        size: parseInt(eventMatch[3], 10),
      });
      continue;
    }

    // Parse event lines (without size — some JFR versions)
    const noSizeMatch = line.match(eventNoSizeRegex);
    if (noSizeMatch && !trimmed.startsWith("#") && !/^[A-Z][a-z]+:/.test(trimmed)) {
      events.push({
        name: noSizeMatch[1].trim(),
        count: parseInt(noSizeMatch[2], 10),
        size: 0,
      });
    }
  }

  if (events.length === 0) {
    throw new Error("No JFR events found in summary. Ensure input is from `jfr summary <file>`.");
  }

  const totalEvents = events.reduce((sum, e) => sum + e.count, 0);
  const totalSize = events.reduce((sum, e) => sum + e.size, 0);

  const { issues, recommendations } = analyzeJfrEvents(events, totalEvents, totalSize);

  return {
    events,
    totalEvents,
    totalSize,
    startTime,
    duration,
    issues,
    recommendations,
  };
}

function analyzeJfrEvents(
  events: JfrEvent[],
  totalEvents: number,
  totalSize: number,
): { issues: string[]; recommendations: string[] } {
  const issues: string[] = [];
  const recommendations: string[] = [];

  // Build a lookup by event name
  const byName = new Map(events.map((e) => [e.name, e]));

  // Check for excessive GC events
  const gcEvents = events.filter((e) =>
    e.name.startsWith("jdk.GC") || e.name.startsWith("jdk.G1") || e.name.startsWith("jdk.ZGC"),
  );
  const gcCount = gcEvents.reduce((sum, e) => sum + e.count, 0);
  if (gcCount > 1000) {
    issues.push(
      `High GC activity: ${gcCount.toLocaleString()} GC events recorded. Possible memory pressure.`,
    );
    recommendations.push(
      "Analyze GC logs with `analyze_gc_log` for pause time breakdown and tuning recommendations.",
    );
  }

  // Check for excessive allocation events
  const allocTLAB = byName.get("jdk.ObjectAllocationInNewTLAB");
  const allocOutside = byName.get("jdk.ObjectAllocationOutsideTLAB");
  if (allocOutside && allocOutside.count > 100) {
    issues.push(
      `${allocOutside.count.toLocaleString()} allocations outside TLAB — objects too large for thread-local allocation buffers.`,
    );
    recommendations.push(
      "Review large object allocations. Consider increasing TLAB size with -XX:TLABSize or reducing object sizes.",
    );
  }

  // Check for thread contention
  const monitorEnter = byName.get("jdk.JavaMonitorEnter");
  const monitorWait = byName.get("jdk.JavaMonitorWait");
  if (monitorEnter && monitorEnter.count > 500) {
    issues.push(
      `${monitorEnter.count.toLocaleString()} monitor enter events — significant lock contention.`,
    );
    recommendations.push(
      "Use `analyze_thread_dump` to identify contention hotspots and consider lock-free alternatives.",
    );
  }

  // Check for threads spending time in Object.wait() — indicates producer-consumer imbalance
  if (monitorWait && monitorWait.count > 2000) {
    issues.push(
      `${monitorWait.count.toLocaleString()} Object.wait() events — threads frequently waiting for notifications. Producers may be slower than consumers.`,
    );
    recommendations.push(
      "Profile the producer side of producer-consumer queues. Consider bounded queues with backpressure or increasing producer thread count.",
    );
  }

  // Check for thread starts (churn)
  const threadStart = byName.get("jdk.ThreadStart");
  if (threadStart && threadStart.count > 200) {
    issues.push(
      `${threadStart.count.toLocaleString()} threads started — possible thread churn. Consider thread pooling.`,
    );
    recommendations.push(
      "Replace ad-hoc thread creation with a fixed-size thread pool (Executors.newFixedThreadPool) or virtual threads (Java 21+) to eliminate thread creation overhead.",
    );
  }

  // Check for exception events
  const exceptions = byName.get("jdk.JavaExceptionThrow");
  if (exceptions && exceptions.count > 500) {
    issues.push(
      `${exceptions.count.toLocaleString()} exceptions thrown — exceptions are expensive and may indicate control flow issues.`,
    );
    recommendations.push(
      "Review exception handling patterns. Avoid using exceptions for control flow.",
    );
  }

  // Check for class loading
  const classLoad = byName.get("jdk.ClassLoad");
  if (classLoad && classLoad.count > 1000) {
    issues.push(
      `${classLoad.count.toLocaleString()} class loads — excessive class loading may indicate classloader leak or dynamic proxy overuse.`,
    );
    recommendations.push(
      "Use `analyze_heap_histo` to check java.lang.Class instance count. If growing, look for frameworks that generate proxies or bytecode at runtime (Hibernate, Spring AOP, reflection-heavy libraries).",
    );
  }

  // Check for file/socket I/O
  const fileRead = byName.get("jdk.FileRead");
  const fileWrite = byName.get("jdk.FileWrite");
  const socketRead = byName.get("jdk.SocketRead");
  const socketWrite = byName.get("jdk.SocketWrite");
  const ioCount = [fileRead, fileWrite, socketRead, socketWrite]
    .filter(Boolean)
    .reduce((sum, e) => sum + e!.count, 0);
  if (ioCount > 5000) {
    issues.push(
      `High I/O activity: ${ioCount.toLocaleString()} file/socket events. Consider batching or buffering.`,
    );
  }

  // Check for compilation events
  const compilation = byName.get("jdk.Compilation");
  if (compilation && compilation.count > 500) {
    issues.push(
      `${compilation.count.toLocaleString()} JIT compilations — may indicate insufficient code cache or deoptimizations.`,
    );
    recommendations.push(
      "Check -XX:ReservedCodeCacheSize and look for deoptimization events.",
    );
  }

  // Recording size analysis
  if (totalSize > 100_000_000) {
    recommendations.push(
      `Recording is ${(totalSize / 1_048_576).toFixed(0)} MB. Consider narrowing event filters with jfc settings.`,
    );
  }

  // If dominant event type uses >50% of total
  if (events.length > 0) {
    const sorted = [...events].sort((a, b) => b.count - a.count);
    const topEvent = sorted[0];
    const topPct = totalEvents > 0 ? (topEvent.count / totalEvents) * 100 : 0;
    if (topPct > 50) {
      recommendations.push(
        `Event "${topEvent.name}" dominates at ${topPct.toFixed(0)}% of all events. Focus analysis there.`,
      );
    }
  }

  return { issues, recommendations };
}
