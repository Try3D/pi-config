// Turn the pi-mood sample log into a dataset.
//
//   node scripts/mood-dataset.mjs [log.jsonl] [--min-confidence 0.0] > dataset.jsonl
//
// Reads <agent dir>/pi-mood/log.jsonl by default (or PI_MOOD_LOG). Output is
// lossless: every `palette` record is emitted once, then every `sample` record
// unchanged, so each line carries its own state, full distribution, reweighted
// scores, usage, and the label set it was classified against.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let minConfidence = 0;
let logPath;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--min-confidence") minConfidence = Number(args[++i]) || 0;
	else if (!args[i].startsWith("--")) logPath = args[i];
}
logPath ??= process.env.PI_MOOD_LOG ?? join(homedir(), ".pi", "agent", "pi-mood", "log.jsonl");

let text;
try {
	text = readFileSync(logPath, "utf8");
} catch {
	console.error(`No log at ${logPath}`);
	process.exit(1);
}

const records = text
	.split("\n")
	.filter(Boolean)
	.map((line) => {
		try {
			return JSON.parse(line);
		} catch {
			return undefined;
		}
	})
	.filter(Boolean);

const palettes = new Map();
for (const record of records) if (record.type === "palette") palettes.set(record.hash, record);
for (const palette of palettes.values()) process.stdout.write(`${JSON.stringify(palette)}\n`);

let kept = 0;
for (const record of records) {
	if (record.type !== "sample" || record.confidence < minConfidence) continue;
	kept++;
	process.stdout.write(`${JSON.stringify(record)}\n`);
}

console.error(`kept ${kept} samples from ${logPath} (palettes: ${palettes.size})`);
