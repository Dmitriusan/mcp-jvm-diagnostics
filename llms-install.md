# Install mcp-jvm-diagnostics via Cline

Run in Cline terminal:

```bash
npx -y mcp-jvm-diagnostics
```

# Configuration

No environment variables required. The server reads JVM artifacts (thread dumps, GC logs, heap histograms, JFR files) from content you paste or provide inline.

Add to your MCP client config:

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
