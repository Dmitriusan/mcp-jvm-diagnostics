[![npm version](https://img.shields.io/npm/v/mcp-jvm-diagnostics)](https://www.npmjs.com/package/mcp-jvm-diagnostics)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

# MCP JVM Diagnostics

A Model Context Protocol (MCP) server that gives AI assistants the ability to analyze JVM thread dumps and GC logs. It detects deadlocks, identifies lock contention hotspots, analyzes garbage collection pressure, and recommends JVM tuning parameters.

## Why This Tool?

JVM diagnostic MCP servers exist (TDA, jfr-mcp, Arthas) — but they're all **Java-based**, requiring a JVM runtime just to diagnose JVM problems. This tool runs on **Node.js** via `npx` — no JVM, no Docker, no SSH.

It analyzes **offline** artifacts (thread dumps, GC logs, heap histograms) rather than requiring a running JVM. Paste a thread dump or GC log and get instant analysis.

## Features

- **6 MCP tools** for comprehensive JVM diagnostics
- **Thread dump analysis** — deadlock detection, contention hotspots, thread state breakdown
- **GC log analysis** — pause statistics, heap trends, memory leak detection
- **Heap histogram analysis** — memory leak candidates, classloader leaks, finalization issues
- **JFR summary** — Java Flight Recorder file analysis
- **Unified diagnosis** — cross-correlates thread and GC data
- **Supports** G1, ZGC, Parallel, Serial, and Shenandoah GC formats
- **No external dependencies** — works on local text input, no API keys needed

## Pro Tier

**Generate exportable diagnostic reports (HTML + PDF)** with a Pro license key.

- Full JVM thread dump analysis report with actionable recommendations
- PDF export for sharing with your team
- Priority support

<!-- TODO: replace placeholder Stripe Payment Link once STRIPE_SECRET_KEY is configured -->
**$9.00/month** — [Get Pro License](https://buy.stripe.com/PLACEHOLDER)

Pro license key activates the `generate_report` MCP tool in mcp-jvm-diagnostics.

## Installation

```bash
npx mcp-jvm-diagnostics
```

Or install globally:

```bash
npm install -g mcp-jvm-diagnostics
```

## Configuration

### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jvm-diagnostics": {
      "command": "npx",
      "args": ["-y", "mcp-jvm-diagnostics"]
    }
  }
}
```

No environment variables needed — this tool works on text input you provide.

## Quick Demo

Try these prompts in Claude (paste your JVM output):

1. **"Analyze this thread dump: [paste jstack output]"** — Detects deadlocks, contention hotspots, and thread state breakdown
2. **"Analyze this GC log: [paste GC log]"** — Shows pause statistics, heap trends, and tuning recommendations
3. **"Compare these heap histograms to find memory leaks: BEFORE: [paste] AFTER: [paste]"** — Identifies growing classes, classloader leaks, and finalizer issues

## Tools

### `analyze_thread_dump`

Parse a JVM thread dump and analyze thread states, detect deadlocks, and identify lock contention.

**Parameters:**
- `thread_dump` — The full thread dump text (from `jstack <pid>`, `kill -3`, or VisualVM)

**Example prompt:** "Analyze this thread dump and tell me if there are any deadlocks"

### `analyze_gc_log`

Parse a GC log and analyze garbage collection patterns, pause times, and memory pressure.

**Parameters:**
- `gc_log` — The GC log text (from `-Xlog:gc*` or `-verbose:gc`)

**Example prompt:** "Analyze this GC log and tell me if there are any performance issues"

### `analyze_heap_histo`

Parse `jmap -histo` output and detect memory leak candidates, object creation hotspots, and classloader leaks.

**Parameters:**
- `histo` — The jmap -histo output text (from `jmap -histo <pid>` or `jmap -histo:live <pid>`)

**Example prompt:** "Analyze this heap histogram and tell me if there are any memory leak candidates"

### `diagnose_jvm`

Unified JVM diagnosis combining thread dump and GC log analysis for comprehensive root cause analysis.

**Parameters:**
- `thread_dump` (optional) — Thread dump text
- `gc_log` (optional) — GC log text

**Example prompt:** "I have both a thread dump and GC log from the same time — diagnose what's wrong"

### `compare_heap_histos`

Compare two `jmap -histo` snapshots taken at different times to detect memory growth patterns and leak candidates.

**Parameters:**
- `before` — The first (earlier) jmap -histo output
- `after` — The second (later) jmap -histo output

**Example prompt:** "Compare these two heap histograms and tell me what's growing"

**Detects:**
- Classes with growing instance/byte counts (leak candidates)
- New classes that appeared between snapshots
- Classes that disappeared (GC'd or unloaded)
- Overall heap growth rate
- Classloader leaks and finalizer queue growth

## Collecting JVM Diagnostics

### Thread Dump
```bash
# Using jstack
jstack <pid> > thread-dump.txt

# Using kill signal (Linux/Mac)
kill -3 <pid>

# Using jcmd
jcmd <pid> Thread.print > thread-dump.txt
```

### GC Log
Add these JVM flags to your application:
```bash
# Java 9+ (unified logging)
-Xlog:gc*:file=gc.log:time,level,tags

# Java 8
-verbose:gc -XX:+PrintGCDetails -XX:+PrintGCDateStamps -Xloggc:gc.log
```

## Contributing

1. Clone the repo
2. `npm install`
3. `npm run build`
4. `npm test`

## Limitations & Known Issues

- **Text input only**: Thread dumps, GC logs, and heap histograms must be provided as text. The server cannot attach to a running JVM or capture data automatically.
- **Java 9+ GC logs**: The GC log parser is optimized for unified logging format (`-Xlog:gc*`). Legacy `-verbose:gc` format (Java 8) has basic support but may miss some events.
- **Shenandoah GC**: Limited support. G1, ZGC, Parallel, and Serial are fully supported.
- **Virtual threads (Java 21+)**: Thread dump parser handles virtual threads but analysis recommendations are tuned for platform threads.
- **Heap histo comparison**: Requires standard `jmap -histo` or `jcmd GC.class_histogram` format. Custom formats or truncated output may not parse correctly.
- **Deadlock detection**: Detects monitor-based deadlocks. ReentrantLock deadlocks may not be detected if lock addresses are not visible in the thread dump.
- **No historical analysis**: Each analysis is a point-in-time snapshot. For trend analysis, compare multiple snapshots manually.
- **HotSpot/OpenJDK only**: Parser targets HotSpot/OpenJDK thread dump format. GraalVM native-image or Eclipse OpenJ9 dumps may parse incompletely.
- **Classloader leak detection**: Heap analysis flags growing ClassLoader instances but cannot definitively prove a leak without memory profiler data.

## Part of the MCP Java Backend Suite

- [mcp-db-analyzer](https://www.npmjs.com/package/mcp-db-analyzer) — PostgreSQL/MySQL/SQLite schema analysis
- [mcp-spring-boot-actuator](https://www.npmjs.com/package/mcp-spring-boot-actuator) — Spring Boot health, metrics, and bean analysis
- [mcp-redis-diagnostics](https://www.npmjs.com/package/mcp-redis-diagnostics) — Redis memory, slowlog, and client diagnostics
- [mcp-migration-advisor](https://www.npmjs.com/package/mcp-migration-advisor) — Flyway/Liquibase migration risk analysis

## License

MIT
