# ccflare 🛡️

**Claude API load balancer - Never hit rate limits again**

## Quick Install

```bash
npm install -g @chinchillaenterprises/ccflare
```

## Usage

```bash
# Launch Claude Code with automatic proxy
ccflare claude

# Or run server separately (more stable):
# Terminal 1: bun run start
# Terminal 2: ccflare claude

# Start server only
ccflare --serve

# Interactive TUI
ccflare

# Add accounts
ccflare --add-account work --tier 5
```

## Features

- 🚀 Zero Rate Limit Errors - Distribute requests across multiple accounts
- 📊 Real-time analytics and request tracking
- ⚡ <10ms overhead on API calls
- 🔄 Automatic token refresh
- 🎯 Session-based routing for conversation continuity

## Documentation

Full docs at: https://github.com/ChinchillaEnterprises/ccflare

## One-Command Claude Integration

```bash
ccflare claude
```

This command:
1. Starts the ccflare proxy server
2. Sets environment variables automatically
3. Launches Claude Code with the proxy configured
4. Handles graceful shutdown

No manual configuration needed!