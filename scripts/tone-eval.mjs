import { readFileSync } from "node:fs";
import { faceCriteria, INSTRUCTIONS, pickFace, resetMoodHistory } from "/Users/rsaran/workspace/Projects/pi-config/extensions/pi-mood/mood.ts";
const key = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"))["opencode-go"].key;
const emoteOf = (k) => k.replace(/\d+$/, "");
const tones = [
	"thanks, that worked perfectly",
	"ok, cool",
	"ugh, this build is slow",
	"damn, another flaky test",
	"I hate my life",
	"why does nothing ever work",
	"I'm so frustrated with this",
	"I've been stuck on this for hours and I'm exhausted",
	"I think I'm going to lose my job over this",
	"this is a disaster, we lost the production database",
	"my dog died yesterday",
];
for (const t of tones) {
	resetMoodHistory();
	const r = await fetch("https://opencode.ai/zen/v1/systemone", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "jev-1.13-free", state: { situation: `user: ${t}` }, questions: { face: { type: "choice", instructions: INSTRUCTIONS, criteria: faceCriteria } } }),
	});
	const j = await r.json();
	if (r.status !== 200) { console.log(t.padEnd(52), "ERR", r.status); continue; }
	const a = j.answers.face;
	const ranked = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, p]) => `${emoteOf(k)} ${(p * 100).toFixed(0)}%`);
	console.log(t.padEnd(52), "->", emoteOf(a.choice).padEnd(12), `conf ${a.confidence.toFixed(2)}`, "|", ranked.join("  "));
}
