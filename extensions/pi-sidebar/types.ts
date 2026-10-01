/**
 * Shared types, the status-shared directory, and layout constants for the
 * sidebar extension.
 */

import { join } from "node:path";

export const SHARED_DIR = join(process.env.PI_CODING_AGENT_DIR?.trim() || join(process.env.HOME ?? ".", ".pi", "agent"), "sidebar");
export const DEFAULT_WIDTH = 34;
export const MIN_WIDTH = 16;
export const MAX_WIDTH = 80;
/** Process label is truncated to this many columns by default. */
export const DEFAULT_LABEL_WIDTH = 20;
export const MIN_LABEL_WIDTH = 8;
export const MAX_LABEL_WIDTH = 60;
export const MIN_TERMINAL_WIDTH = 100;
export const MAX_PROCESSES = 12;
export const PROCESS_REFRESH_MS = 5000;

/** Nerd Font progress-spinner frames (nf-extra-progress_spinner_1..6, U+EE06-U+EE0B). */
export const SPINNER_FRAMES = ["\uee06", "\uee07", "\uee08", "\uee09", "\uee0a", "\uee0b"];
/** Marker for process rows that are not currently loading (Nerd Font icon, U+F09DE). */
export const INACTIVE_MARKER = "\u{f09de}";
/** Animation interval; ~8 fps is smooth without burning CPU. */
export const SPINNER_MS = 120;

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
	elapsed: string;
	current: boolean;
	cwd?: string;
	tmux?: TmuxTarget;
	/** Whether the process is currently generating (drives the spinner). */
	streaming?: boolean;
}

/** Per-process status published to disk so every sidebar sees every pi exactly as it sees itself. */
export interface SharedStatus {
	pid: number;
	label?: string;
	cwd?: string;
	pane?: string;
	streaming?: boolean;
	updatedAt: number;
}

export interface SidebarState {
	cwd: string;
	streaming: boolean;
	/** Spinner frame index, advanced while anything is streaming. */
	frame: number;
	processes: ProcessItem[];
}
