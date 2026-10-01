/**
 * pi's stock footer with the `• <session name>` suffix suppressed: the session
 * title is redundant there because tmux already names the window from the
 * terminal title. The numeric context readout and the token/cache stats are
 * replaced by a labeled usage bar plus cost; the model stays on the right.
 */

import { type ReadonlyFooterDataProvider, type Theme, FooterComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Label shown before the usage bar. */
const CONTEXT_LABEL = "ctx ";
const BAR_CELLS = 12;
/** Built-in context readout: `42.0%/200k (auto)`, `?/1.0M`, etc. */
const CONTEXT_RE = /(?:\d+\.\d+%|\?)\/[0-9.]+[kM]?(?: \(auto\))?/;
/** Cost from the built-in stats, including the subscription suffix. */
const COST_RE = /\$\d+\.\d+(?: \(sub\))?/;
// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Render the readout's window (`200k`, `1.0M`, `500`) as rounded thousands. */
function windowLabel(display: string | undefined): string {
	if (!display) return "";
	const match = /^([0-9.]+)([kM]?)$/.exec(display);
	if (!match) return ` ${display}`;
	const value = Number(match[1]);
	if (value <= 0) return "";
	const thousands = match[2] === "M" ? value * 1_000 : match[2] === "k" ? value : value / 1_000;
	return thousands >= 1 ? ` ${Math.round(thousands)}k` : ` ${value}`;
}

/** Colored usage gauge rebuilt from the readout the base footer already rendered. */
function contextBar(theme: Theme, readout: string): string {
	const label = theme.fg("muted", CONTEXT_LABEL);
	const percent = readout.startsWith("?") ? null : Number(/([0-9.]+)%/.exec(readout)?.[1]);
	const window = windowLabel(/\/([0-9.]+[kM]?)/.exec(readout)?.[1]);
	if (percent === null || !Number.isFinite(percent)) return label + theme.fg("dim", `?${window}`);
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.min(BAR_CELLS, Math.round((clamped / 100) * BAR_CELLS));
	const color = clamped >= 85 ? "error" : clamped >= 65 ? "warning" : "success";
	return label + theme.fg(color, "█".repeat(filled) + "░".repeat(BAR_CELLS - filled)) + theme.fg("dim", ` ${Math.round(clamped)}%${window}`);
}

export class QuietFooter extends FooterComponent {
	constructor(footerData: ReadonlyFooterDataProvider, stub: unknown, private readonly theme: Theme) {
		super(stub as never, footerData);
	}

	/** Ignore pi swapping in the real session, which would re-add the name. */
	override setSession(): void {}

	override render(width: number): string[] {
		const lines = super.render(width);
		const index = lines.findIndex((line) => CONTEXT_RE.test(line.replace(ANSI_RE, "")));
		const line = lines[index];
		if (index === -1 || !line) return lines;
		const clean = line.replace(ANSI_RE, "");
		const match = CONTEXT_RE.exec(clean);
		if (!match) return lines;
		// Rebuild the stats line: bar + cost on the left, model right-aligned. Drop
		// the built-in token/cache/cache-hit stats.
		const left = clean.slice(0, match.index);
		const right = clean.slice(match.index + match[0].length);
		const bar = contextBar(this.theme, match[0]);
		const cost = left.match(COST_RE)?.[0];
		const head = cost ? `${bar} ${this.theme.fg("dim", cost)}` : bar;
		const tail = right.trimStart();
		const gap = Math.max(2, width - visibleWidth(head) - visibleWidth(tail));
		lines[index] = truncateToWidth(head + this.theme.fg("dim", " ".repeat(gap) + tail), width, "");
		return lines;
	}
}
