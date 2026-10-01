/**
 * Process launch helpers: quoting for the tmux command string (tmux runs it via
 * a shell) and resolving how to invoke pi from inside the child pane.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve how to invoke pi inside the child pane. */
export function piInvocation(): { command: string; prefixArgs: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtual && fs.existsSync(currentScript)) {
		return { command: process.execPath, prefixArgs: [currentScript] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) return { command: "pi", prefixArgs: [] };
	return { command: process.execPath, prefixArgs: [] };
}
