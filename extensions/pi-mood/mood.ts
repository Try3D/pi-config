import { readFileSync } from "node:fs";

interface Emoticon {
	emoticon: string;
	mood: string;
	description: string;
	use_when?: string;
}

/** The palette is the classifier's label set; edit emoticons.json to change it. */
function loadPalette(): Emoticon[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(new URL("../../emoticons.json", import.meta.url), "utf8"));
		if (Array.isArray(parsed)) {
			const entries = parsed.filter(
				(e): e is Emoticon =>
					typeof e === "object" && e !== null && typeof (e as Emoticon).emoticon === "string" && typeof (e as Emoticon).description === "string",
			);
			if (entries.length > 0) {
				return entries.map((entry) => ({
					...entry,
					mood: typeof entry.mood === "string" ? entry.mood : "mood",
					use_when: typeof entry.use_when === "string" ? entry.use_when : undefined,
				}));
			}
		}
	} catch {
		/* fall through to a single default */
	}
	return [{ emoticon: "(•_•)", mood: "waiting", description: "waiting for input" }];
}

const counts = new Map<string, number>();
const palette = loadPalette().map((entry) => {
	// The option key must be a meaningful word for the classifier; the mood is
	// that word and the counter only makes repeated moods unique.
	const n = (counts.get(entry.mood) ?? 0) + 1;
	counts.set(entry.mood, n);
	return { ...entry, key: `${entry.mood}${n}` };
});

export const INSTRUCTIONS =
	"You are a tiny mascot in the status bar of a coding agent. Read the current situation, including the user's own messages, and pick the single face that best matches how things are right now. Match the intensity, not just the direction.";

export const faceCriteria: Record<string, string> = Object.fromEntries(
	palette.map((entry) => [entry.key, entry.use_when ? `${entry.description}. Use when ${entry.use_when}.` : entry.description]),
);

/** The full label set: every option key with the face it renders and what it means. */
export const paletteEntries = palette.map(({ key, emoticon, mood, description, use_when }) => ({ key, emoticon, mood, description, use_when }));

/** How much a face is discounted each time it has been shown. 1 disables variety. */
const decay = (() => {
	const raw = Number(process.env.PI_MOOD_DECAY);
	return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0.5;
})();

const usage = new Map<string, number>();

/** Forget how often each face has been shown, e.g. at the start of a session. */
export function resetMoodHistory(): void {
	usage.clear();
}

/** Presence weight: 1 for a face never shown, then fading geometrically with use. */
function presenceWeight(face: string): number {
	return decay ** (usage.get(face) ?? 0);
}

/**
 * Pick the face with the highest probability times presence weight, so a face
 * that has already appeared is less likely, but a strong match can still repeat.
 * Returns the reweighted scores too, so the choice is reproducible.
 */
export function pickFace(probabilities: Record<string, number>): { face: string; description: string; scores: Record<string, number> } {
	const first = palette[0];
	if (!first) throw new Error("pi-mood: emoticons.json must contain at least one face");
	const scores: Record<string, number> = {};
	let best = first;
	let bestScore = -1;
	for (const entry of palette) {
		const score = (probabilities[entry.key] ?? 0) * presenceWeight(entry.emoticon);
		scores[entry.key] = score;
		if (score > bestScore) {
			bestScore = score;
			best = entry;
		}
	}
	usage.set(best.emoticon, (usage.get(best.emoticon) ?? 0) + 1);
	return { face: best.emoticon, description: best.description, scores };
}
