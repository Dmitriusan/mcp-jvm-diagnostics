# Changelog

All notable changes to MCP JVM Diagnostics will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-03-07

### Added
- MCP server for JVM diagnostics
- Thread dump parser supporting HotSpot format (Java 8-21+)
- Deadlock detector with lock wait graph cycle detection
- Lock contention analyzer with hotspot identification
- GC log parser supporting G1, ZGC, Parallel, Serial, and Shenandoah
- GC pressure analyzer with pause time P95, overhead calculation, and JVM tuning recommendations
- Heap histogram parser for `jmap -histo` output
- Memory leak detection (>10% heap for non-JDK classes)
- Classloader leak detection (>30K loaded classes)
- Unified `diagnose_jvm` tool with cross-correlation analysis
- Java 21+ thread dump format support (`[os_thread_id]` in header)
- Object.wait() self-loop filtering (prevents false positive deadlocks)
- `--help` CLI flag
