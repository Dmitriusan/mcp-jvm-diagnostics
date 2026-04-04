/**
 * Lock contention analyzer.
 *
 * Identifies the most-contended locks and most-blocked threads.
 * Generates actionable recommendations.
 */

import type { ParsedThread } from "../parsers/thread-dump.js";

export interface ContentionHotspot {
  lock: string;
  blockedCount: number;
  holderThread: string;
  waitingThreads: string[];
}

export interface ContentionAnalysis {
  hotspots: ContentionHotspot[];
  recommendations: string[];
}

export function analyzeContention(threads: ParsedThread[]): ContentionAnalysis {
  // Map: lock address → thread holding it
  const lockHolders = new Map<string, string>();
  for (const t of threads) {
    for (const lock of t.holdsLocks) {
      lockHolders.set(lock, t.name);
    }
  }

  // Map: lock address → threads blocked on it
  const blockedOn = new Map<string, string[]>();
  for (const t of threads) {
    if (t.state === "BLOCKED" && t.blockedBy) {
      const existing = blockedOn.get(t.blockedBy) || [];
      existing.push(t.name);
      blockedOn.set(t.blockedBy, existing);
    }
  }

  // Build hotspot list sorted by blocked count
  const hotspots: ContentionHotspot[] = [];
  for (const [lock, waitingThreads] of blockedOn.entries()) {
    hotspots.push({
      lock,
      blockedCount: waitingThreads.length,
      holderThread: lockHolders.get(lock) || "unknown",
      waitingThreads,
    });
  }
  hotspots.sort((a, b) => b.blockedCount - a.blockedCount);

  // Generate recommendations
  const recommendations: string[] = [];
  const totalBlocked = threads.filter(t => t.state === "BLOCKED").length;
  const totalThreads = threads.length;

  if (totalBlocked > 0) {
    const pct = ((totalBlocked / totalThreads) * 100).toFixed(0);
    recommendations.push(
      `${totalBlocked} of ${totalThreads} threads (${pct}%) are BLOCKED — investigate contended locks.`
    );
  }

  if (hotspots.length > 0 && hotspots[0].blockedCount >= 5) {
    recommendations.push(
      `Lock \`${hotspots[0].lock}\` held by "${hotspots[0].holderThread}" is blocking ${hotspots[0].blockedCount} threads. This is a critical hotspot — consider reducing the lock scope or using a read-write lock.`
    );
  }

  if (hotspots.length > 3) {
    recommendations.push(
      "Multiple contention hotspots detected. Consider redesigning synchronization — ConcurrentHashMap, read-write locks, or lock-free data structures may reduce contention."
    );
  }

  // Check for thread pool exhaustion
  const platformPoolPatterns = ["pool-", "http-", "exec-", "ForkJoin", "worker-"];
  for (const pattern of platformPoolPatterns) {
    const poolThreads = threads.filter(t => t.name.includes(pattern));
    const poolBlocked = poolThreads.filter(t => t.state === "BLOCKED");
    if (poolThreads.length > 0 && poolBlocked.length > poolThreads.length * 0.5) {
      recommendations.push(
        `Thread pool "${pattern}*" has ${poolBlocked.length}/${poolThreads.length} threads BLOCKED — pool exhaustion risk. Consider increasing pool size or reducing lock hold time.`
      );
    }
  }

  // Virtual thread schedulers (Java 21+ VirtualThreadScheduler, Kotlin coroutines DefaultDispatcher).
  // BLOCKED/WAITING state in these pools does not exhaust OS carrier threads — add a caveat instead
  // of triggering the same exhaustion warning.
  const virtualPoolPatterns = ["VirtualThreadScheduler", "DefaultDispatcher"];
  const hasVirtualPool = threads.some(t =>
    virtualPoolPatterns.some(p => t.name.includes(p))
  );
  if (hasVirtualPool) {
    recommendations.push(
      "Virtual thread pool detected. BLOCKED and WAITING states do not exhaust OS carrier threads — monitor task queue depth and carrier thread saturation instead."
    );
  }

  // Check for WAITING threads that might indicate starvation
  const waitingCount = threads.filter(t => t.state === "WAITING").length;
  if (waitingCount > totalThreads * 0.7) {
    recommendations.push(
      `${waitingCount} of ${totalThreads} threads are WAITING — possible thread starvation. Check if producer threads are stuck or undersized.`
    );
  }

  return { hotspots, recommendations };
}
