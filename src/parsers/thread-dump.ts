/**
 * HotSpot thread dump parser.
 *
 * Parses jstack/kill -3 output into structured thread data including:
 * - Thread name, state, daemon status
 * - Stack traces
 * - Lock information (waiting on, holding)
 */

export interface ParsedThread {
  name: string;
  state: string;
  isDaemon: boolean;
  priority: number;
  tid: string;
  nid: string;
  stackTrace: string[];
  waitingOn: string | null;
  holdsLocks: string[];
  blockedBy: string | null;
}

export interface ParsedThreadDump {
  jvmInfo: string;
  timestamp: string;
  threads: ParsedThread[];
}

// Java 21+ thread dumps include [os_thread_id] after #id:
// "Finalizer" #11 [2523503] daemon prio=8 os_prio=0 ...
const THREAD_HEADER_RE =
  /^"(.+?)"\s*(#\d+)?\s*(?:\[\d+\])?\s*(daemon)?\s*(?:prio=(\d+))?\s*(?:os_prio=\d+)?\s*(?:cpu=[\d.]+ms)?\s*(?:elapsed=[\d.]+s)?\s*(?:tid=(0x[0-9a-f]+))?\s*(?:nid=(0x[0-9a-f]+|\d+))?\s*(.*)/;

const STATE_RE = /java\.lang\.Thread\.State:\s*(\S+)/;
const WAITING_ON_RE = /- waiting to lock\s+<(0x[0-9a-f]+)>/;
const LOCKED_RE = /- locked\s+<(0x[0-9a-f]+)>/;
const PARKING_RE = /- parking to wait for\s+<(0x[0-9a-f]+)>/;
const WAITING_OBJ_RE = /- waiting on\s+<(0x[0-9a-f]+)>/;

export function parseThreadDump(text: string): ParsedThreadDump {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const threads: ParsedThread[] = [];
  let jvmInfo = "";
  let timestamp = "";

  // Extract JVM info and timestamp from header
  for (const line of lines) {
    if (line.startsWith("Full thread dump")) {
      jvmInfo = line.replace("Full thread dump ", "").replace(":", "").trim();
      break;
    }
  }

  // Look for timestamp (common format: YYYY-MM-DD HH:MM:SS)
  const tsMatch = text.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})/);
  if (tsMatch) {
    timestamp = tsMatch[1];
  }

  let currentThread: ParsedThread | null = null;
  let inStack = false;

  for (const line of lines) {
    // Try matching thread header
    const headerMatch = line.match(THREAD_HEADER_RE);
    if (headerMatch && line.startsWith('"')) {
      // Save previous thread
      if (currentThread) {
        threads.push(currentThread);
      }

      currentThread = {
        name: headerMatch[1],
        state: "UNKNOWN",
        isDaemon: headerMatch[3] === "daemon",
        priority: headerMatch[4] ? parseInt(headerMatch[4], 10) : 5,
        tid: headerMatch[5] || "",
        nid: headerMatch[6] || "",
        stackTrace: [],
        waitingOn: null,
        holdsLocks: [],
        blockedBy: null,
      };

      // Some thread headers include state inline (e.g., "runnable", "waiting on condition")
      const inlineState = headerMatch[7]?.trim();
      if (inlineState) {
        if (inlineState.includes("runnable")) currentThread.state = "RUNNABLE";
        else if (inlineState.includes("waiting on condition")) currentThread.state = "TIMED_WAITING";
        else if (inlineState.includes("waiting for monitor")) currentThread.state = "BLOCKED";
        else if (inlineState.includes("in Object.wait")) currentThread.state = "WAITING";
        else if (inlineState.includes("sleeping")) currentThread.state = "TIMED_WAITING";
      }

      inStack = true;
      continue;
    }

    if (!currentThread || !inStack) continue;

    // Thread state line
    const stateMatch = line.match(STATE_RE);
    if (stateMatch) {
      currentThread.state = stateMatch[1];
      continue;
    }

    // Stack trace line
    if (line.match(/^\s+at\s+/)) {
      currentThread.stackTrace.push(line.trim());
      continue;
    }

    // Lock information
    const waitMatch = line.match(WAITING_ON_RE);
    if (waitMatch) {
      currentThread.waitingOn = waitMatch[1];
      currentThread.blockedBy = waitMatch[1];
      continue;
    }

    const lockMatch = line.match(LOCKED_RE);
    if (lockMatch) {
      currentThread.holdsLocks.push(lockMatch[1]);
      continue;
    }

    const parkMatch = line.match(PARKING_RE);
    if (parkMatch) {
      currentThread.waitingOn = parkMatch[1];
      continue;
    }

    const waitObjMatch = line.match(WAITING_OBJ_RE);
    if (waitObjMatch) {
      currentThread.waitingOn = waitObjMatch[1];
      continue;
    }

    // Empty line ends the current thread's stack
    if (line.trim() === "" && currentThread.stackTrace.length > 0) {
      inStack = false;
    }
  }

  // Push last thread
  if (currentThread) {
    threads.push(currentThread);
  }

  return { jvmInfo, timestamp, threads };
}
