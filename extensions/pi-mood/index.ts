import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickRandomFace } from "./mood.ts";

/** How long each random face stays on screen. */
const ROTATE_MS = 5_000;

/**
 * pi-mood shows a small mascot in the footer. It swaps in a random face from
 * emoticons.json every few seconds. It reads no session data and sends nothing
 * over the network.
 */
export default function (pi: ExtensionAPI) {
	if (process.env.PI_MOOD_DISABLE === "1") return;

	let ctx: ExtensionContext | undefined;
	let current: string | undefined;
	let interval: ReturnType<typeof setInterval> | undefined;

	const isTui = (source: ExtensionContext): boolean => source.mode === "tui" && typeof source.ui.setStatus === "function";

	const show = (face: string): void => {
		try {
			ctx?.ui.setStatus("pi-mood", face);
		} catch {
			// The UI may already be disposed.
		}
	};

	const rotate = (): void => {
		current = pickRandomFace(current);
		show(current);
	};

	pi.on("session_start", (_event, source) => {
		if (interval) clearInterval(interval);
		interval = undefined;
		ctx = isTui(source) ? source : undefined;
		if (!ctx) return;
		rotate();
		interval = setInterval(rotate, ROTATE_MS);
	});

	pi.on("session_shutdown", () => {
		if (interval) clearInterval(interval);
		interval = undefined;
		try {
			ctx?.ui.setStatus("pi-mood", undefined);
		} catch {
			// The UI may already be disposed.
		}
		ctx = undefined;
	});
}
