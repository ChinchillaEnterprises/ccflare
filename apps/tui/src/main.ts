#!/usr/bin/env bun
import { Config } from "@ccflare/config";
import { NETWORK, shutdown } from "@ccflare/core";
import { container, SERVICE_KEYS } from "@ccflare/core-di";
import { DatabaseFactory } from "@ccflare/database";
import { Logger } from "@ccflare/logger";
// Import server
import startServer from "@ccflare/server";
import * as tuiCore from "@ccflare/tui-core";
import { parseArgs } from "@ccflare/tui-core";
import { render } from "ink";
import React from "react";
import { App } from "./App";

// Global singleton for auto-started server
let runningServer: ReturnType<typeof startServer> | null = null;

async function ensureServer(port: number) {
	if (!runningServer) {
		runningServer = startServer({ port, withDashboard: true });
	}
	return runningServer;
}

async function main() {
	// Initialize DI container and services
	container.registerInstance(SERVICE_KEYS.Config, new Config());
	container.registerInstance(SERVICE_KEYS.Logger, new Logger("TUI"));

	// Initialize database factory
	DatabaseFactory.initialize();
	const dbOps = DatabaseFactory.getInstance();
	container.registerInstance(SERVICE_KEYS.Database, dbOps);

	const args = process.argv.slice(2);

	// Handle "ccflare claude" command
	if (args[0] === "claude") {
		const config = new Config();
		const port = config.getRuntime().port || NETWORK.DEFAULT_PORT;

		// Start server in background (completely silent)
		const server = startServer({ port, withDashboard: true, silent: true });

		// Wait a bit for server to start
		await new Promise((resolve) => setTimeout(resolve, 1000));

		// Launch Claude with environment variable
		const { spawn } = await import("node:child_process");
		const claudeArgs = args.slice(1); // Remove "claude" from args
		
		const claudeProcess = spawn("claude", claudeArgs, {
			stdio: "inherit",
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://localhost:${port}`,
			},
		});

		// Handle Claude process exit
		claudeProcess.on("exit", async (code) => {
			server.stop();
			await shutdown();
			process.exit(code || 0);
		});

		// Handle interrupt signals
		const handleSignal = async (signal: string) => {
			claudeProcess.kill();
			server.stop();
			await shutdown();
			process.exit(0);
		};

		process.on("SIGINT", () => handleSignal("SIGINT"));
		process.on("SIGTERM", () => handleSignal("SIGTERM"));

		return;
	}

	const parsed = parseArgs(args);

	// Handle help
	if (parsed.help) {
		console.log(`
🎯 ccflare - Load Balancer for Claude

Usage: ccflare [command] [options]

Commands:
  claude               Start ccflare server and launch Claude Code with proxy

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --mode <max|console>  Account mode (default: max)
    --tier <1|5|20>       Account tier (default: 1)
  --list               List all accounts
  --remove <name>      Remove an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --analyze            Analyze database performance
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --help, -h           Show this help message

Interactive Mode:
  ccflare          Launch interactive TUI (default)

Examples:
  ccflare claude                 # Start server & launch Claude Code
  ccflare claude --help          # Pass args to Claude Code
  ccflare                        # Interactive mode
  ccflare --serve                # Start server only
  ccflare --add-account work     # Add account
  ccflare --stats                # View stats
`);
		process.exit(0);
	}

	// Handle non-interactive commands
	if (parsed.serve) {
		const config = new Config();
		const port =
			parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
		startServer({ port, withDashboard: true });
		// Keep process alive
		await new Promise(() => {});
		return;
	}

	if (parsed.logs !== undefined) {
		const limit = typeof parsed.logs === "number" ? parsed.logs : 100;

		// First print historical logs if limit was specified
		if (typeof parsed.logs === "number") {
			const history = await tuiCore.getLogHistory(limit);
			for (const log of history) {
				console.log(`[${log.level}] ${log.msg}`);
			}
			console.log("--- Live logs ---");
		}

		// Then stream live logs
		await tuiCore.streamLogs((log) => {
			console.log(`[${log.level}] ${log.msg}`);
		});
		return;
	}

	if (parsed.stats) {
		const stats = await tuiCore.getStats();
		console.log(JSON.stringify(stats, null, 2));
		return;
	}

	if (parsed.addAccount) {
		await tuiCore.addAccount({
			name: parsed.addAccount,
			mode: parsed.mode || "max",
			tier: parsed.tier || 1,
		});
		console.log(`✅ Account "${parsed.addAccount}" added successfully`);
		return;
	}

	if (parsed.list) {
		const accounts = await tuiCore.getAccounts();
		if (accounts.length === 0) {
			console.log("No accounts configured");
		} else {
			console.log("\nAccounts:");
			accounts.forEach((acc) => {
				console.log(`  - ${acc.name} (${acc.mode} mode, tier ${acc.tier})`);
			});
		}
		return;
	}

	if (parsed.remove) {
		await tuiCore.removeAccount(parsed.remove);
		console.log(`✅ Account "${parsed.remove}" removed successfully`);
		return;
	}

	if (parsed.resetStats) {
		await tuiCore.resetStats();
		console.log("✅ Statistics reset successfully");
		return;
	}

	if (parsed.clearHistory) {
		await tuiCore.clearHistory();
		console.log("✅ Request history cleared successfully");
		return;
	}

	if (parsed.pause) {
		const result = await tuiCore.pauseAccount(parsed.pause);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.resume) {
		const result = await tuiCore.resumeAccount(parsed.resume);
		console.log(result.message);
		if (!result.success) {
			process.exit(1);
		}
		return;
	}

	if (parsed.analyze) {
		await tuiCore.analyzePerformance();
		return;
	}

	// Default: Launch interactive TUI with auto-started server
	const config = new Config();
	const port = parsed.port || config.getRuntime().port || NETWORK.DEFAULT_PORT;
	await ensureServer(port);
	const { waitUntilExit } = render(React.createElement(App));
	await waitUntilExit();

	// Cleanup server when TUI exits
	if (runningServer) {
		runningServer.stop();
	}

	// Shutdown all resources
	await shutdown();
}

// Run main and handle errors
main().catch(async (error) => {
	console.error("Error:", error.message);
	try {
		await shutdown();
	} catch (shutdownError) {
		console.error("Error during shutdown:", shutdownError);
	}
	process.exit(1);
});

// Handle process termination
process.on("SIGINT", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});

process.on("SIGTERM", async () => {
	try {
		await shutdown();
	} catch (error) {
		console.error("Error during shutdown:", error);
	}
	process.exit(0);
});
