import { readFileSync } from "node:fs";

/** Fallback face when emoticons.json is missing or unreadable. */
const DEFAULT_FACE = "(•_•)";

/** Read the distinct faces from emoticons.json next to this module. */
function loadFaces(): string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(new URL("./emoticons.json", import.meta.url), "utf8"));
		if (Array.isArray(parsed)) {
			const faces = parsed
				.filter((entry): entry is { emoticon: string } => {
					if (typeof entry !== "object" || entry === null) return false;
					return typeof (entry as { emoticon?: unknown }).emoticon === "string";
				})
				.map((entry) => entry.emoticon);
			const unique = [...new Set(faces)];
			if (unique.length > 0) return unique;
		}
	} catch {
		/* fall through to the default face */
	}
	return [DEFAULT_FACE];
}

const faces = loadFaces();

/** Pick a random face, avoiding the previous one when there is another face. */
export function pickRandomFace(previous?: string): string {
	const pool = previous === undefined || faces.length < 2 ? faces : faces.filter((face) => face !== previous);
	return pool[Math.floor(Math.random() * pool.length)] ?? DEFAULT_FACE;
}
