/**
 * Deadlock detector.
 *
 * Builds a lock wait graph from thread dump data and detects cycles
 * indicating deadlocks.
 */

import type { ParsedThread } from "../parsers/thread-dump.js";

export interface DeadlockThread {
  name: string;
  holdsLock: string;
  waitingOn: string;
}

export interface Deadlock {
  threads: DeadlockThread[];
  recommendation: string;
}

/**
 * Detect deadlocks by finding cycles in the lock wait graph.
 *
 * Algorithm:
 * 1. Build a map: lock address → holding thread
 * 2. Build a map: thread → lock it's waiting on
 * 3. For each waiting thread, follow the chain:
 *    thread waits on lock → lock held by thread2 → thread2 waits on lock2 → ...
 *    If we revisit a thread, we found a cycle (deadlock).
 */
export function detectDeadlocks(threads: ParsedThread[]): Deadlock[] {
  // Map: lock address → thread that holds it
  const lockHolders = new Map<string, ParsedThread>();
  for (const t of threads) {
    for (const lock of t.holdsLocks) {
      lockHolders.set(lock, t);
    }
  }

  // Only consider threads that are waiting on a lock AND hold at least one lock
  // (a deadlock cycle requires each thread to hold one lock while waiting for another)
  // Exclude threads waiting on a lock they already hold — this is Object.wait()
  // (the thread temporarily releases the monitor while waiting on a condition)
  const waitingThreads = threads.filter(
    t => t.waitingOn !== null &&
      t.holdsLocks.length > 0 &&
      !t.holdsLocks.includes(t.waitingOn!)
  );

  const deadlocks: Deadlock[] = [];
  const visited = new Set<string>();

  for (const startThread of waitingThreads) {
    if (visited.has(startThread.name)) continue;

    const chain: ParsedThread[] = [];
    const chainNames = new Set<string>();
    let current: ParsedThread | undefined = startThread;

    while (current && !chainNames.has(current.name)) {
      chain.push(current);
      chainNames.add(current.name);

      // Find who holds the lock this thread is waiting on
      const waitingOnLock = current.waitingOn;
      if (!waitingOnLock) break;

      const holder = lockHolders.get(waitingOnLock);
      if (!holder || !holder.waitingOn) break;

      current = holder;
    }

    // Check if we found a cycle
    if (current && chainNames.has(current.name)) {
      // Extract just the cycle portion
      const cycleStartIdx = chain.findIndex(t => t.name === current!.name);
      const cycleThreads = chain.slice(cycleStartIdx);

      // Skip if we've already found this deadlock
      const cycleKey = cycleThreads.map(t => t.name).sort().join(",");
      if (visited.has(cycleKey)) continue;
      visited.add(cycleKey);

      // Mark all threads in cycle as visited
      for (const t of cycleThreads) {
        visited.add(t.name);
      }

      const dlThreads: DeadlockThread[] = cycleThreads.map(t => ({
        name: t.name,
        holdsLock: t.holdsLocks[0] || "unknown",
        waitingOn: t.waitingOn || "unknown",
      }));

      deadlocks.push({
        threads: dlThreads,
        recommendation: generateRecommendation(cycleThreads),
      });
    }
  }

  return deadlocks;
}

function generateRecommendation(threads: ParsedThread[]): string {
  // Analyze the stack traces to give a meaningful recommendation
  const stackMethods = threads.flatMap(t => t.stackTrace).join("\n");

  if (stackMethods.includes("synchronized")) {
    return "Use java.util.concurrent locks with tryLock() and timeout instead of synchronized blocks. Ensure consistent lock ordering across all threads.";
  }

  if (stackMethods.includes("ReentrantLock")) {
    return "Use tryLock(timeout) instead of lock() to prevent indefinite blocking. Review lock ordering for consistency.";
  }

  return "Ensure consistent lock ordering across all threads. Consider using java.util.concurrent locks with tryLock(timeout) to prevent indefinite blocking.";
}
