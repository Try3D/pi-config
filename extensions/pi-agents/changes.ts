/**
 * Working-tree change summary for a subagent's cwd.
 */

import { execFile } from "node:child_process";

function git(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], { encoding: "utf-8" }, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

/**
 * Returns a short human-readable summary of uncommitted changes, or "" if cwd
 * is not a git repo, or "none" if the tree is clean.
 */
export async function gitSummary(cwd: string): Promise<string> {
	let status: string;
	try {
		status = await git(cwd, ["status", "--porcelain"]);
	} catch {
		return ""; // not a git repo
	}
	if (!status.trim()) return "none";

	const stat = await git(cwd, ["diff", "--stat"]).catch(() => "");
	return [status.trim(), stat.trim()].filter(Boolean).join("\n");
}
