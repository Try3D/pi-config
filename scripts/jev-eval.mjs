import { readFileSync } from "node:fs";
import { faceCriteria, INSTRUCTIONS, resetMoodHistory } from "../extensions/pi-mood/mood.ts";

const key = JSON.parse(readFileSync(`${process.env.HOME}/.pi/agent/auth.json`, "utf8"))["opencode-go"].key;
const palette = JSON.parse(readFileSync(new URL("../emoticons.json", import.meta.url), "utf8"));
const faceByKey = {};
{
	const c = new Map();
	for (const e of palette) {
		const n = (c.get(e.mood) ?? 0) + 1;
		c.set(e.mood, n);
		faceByKey[`${e.mood}${n}`] = e.emoticon;
	}
}

async function classify(situation) {
	const t = Date.now();
	const r = await fetch("https://opencode.ai/zen/v1/systemone", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model: "jev-1.13-free", state: { situation }, questions: { face: { type: "choice", instructions: INSTRUCTIONS, criteria: faceCriteria } } }),
	});
	const j = await r.json();
	return { ms: Date.now() - t, status: r.status, j };
}

const states = {
	"I hate my life": "user: I hate my life",
	"cant do this anymore": "user: I can't do this anymore",
	"everything is broken": "user: I'm so stressed, everything is broken and I can't fix it",
	"why keep failing": "user: ugh, why does this keep failing",
	"a little annoying": "user: this is a little annoying",
	"thanks works now": "user: thanks, that works now",
	"tool running": "the agent is in the middle of running the bash tool, the work is not done yet",
	done: "the agent just finished the work, the result looks good",
	failed: "a command or test just failed with an error",
	idle: "the agent is idle and waiting for the user",
};
console.log(`criteria: ${Object.keys(faceCriteria).length} faces`);
for (const [label, situation] of Object.entries(states)) {
	resetMoodHistory();
	const { ms, status, j } = await classify(situation);
	if (status !== 200) {
		console.log(label.padEnd(22), "ERROR", status, JSON.stringify(j).slice(0, 120));
		continue;
	}
	const a = j.answers.face;
	const top = Object.entries(a.probabilities)
		.sort((x, y) => y[1] - x[1])
		.slice(0, 3)
		.map(([k, p]) => `${faceByKey[k]} ${(p * 100).toFixed(0)}%`);
	console.log(label.padEnd(22), (faceByKey[a.choice] ?? a.choice).padEnd(14), "|", top.join("  "), `${ms}ms`);
}
