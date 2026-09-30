/**
 * Shared types, the status-shared directory, and layout constants for the
 * sidebar extension.
 */

import { join } from "node:path";

export const SHARED_DIR = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? ".", ".pi", "agent"), "sidebar");
export const WIDTH = 34;
export const MIN_TERMINAL_WIDTH = 100;
export const MAX_PROCESSES = 12;
export const PROCESS_REFRESH_MS = 5000;

export type Side = "left" | "right";

export interface TmuxTarget {
	session: string;
	window: string;
	pane: string;
	name?: string;
}

export interface ProcessItem {
	pid: number;
	label: string;
	version?: string;
	elapsed: string;
	current: boolean;
	cwd?: string;
	tmux?: TmuxTarget;
}

/** Per-process status published to disk so every sidebar sees every pi exactly as it sees itself. */
export interface SharedStatus {
	pid: number;
	label?: string;
	cwd?: string;
	model?: string;
	thinking?: string;
	branch?: string;
	pane?: string;
	updatedAt: number;
}

export interface SidebarState {
	model: string;
	thinking: string;
	cwd: string;
	branch?: string;
	contextWindow?: number;
	percent: number | null;
	turns: number;
	streaming: boolean;
	processes: ProcessItem[];
}
