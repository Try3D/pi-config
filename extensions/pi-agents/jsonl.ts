/**
 * Parsing the child's raw.jsonl event stream: extracting the last assistant
 * text from a full file, and incrementally tailing appended bytes (split on
 * complete lines so a truncated read never corrupts the byte offset).
 */

import * as fs from "node:fs";

export interface RawEvent {
	type?: string;
	message?: {
		role?: string;
		content?: { type?: string; text?: string }[];
	};
}

/** Last assistant message_end text found in the given raw.jsonl content. */
function lastAssistantText(content: string): string {
	let text = "";
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let event: RawEvent;
		try {
			event = JSON.parse(line) as RawEvent;
		} catch {
			continue;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const parts = (event.message.content ?? [])
				.filter((p) => p.type === "text")
				.map((p) => p.text ?? "")
				.join("");
			if (parts) text = parts;
		}
	}
	return text;
}

/** Final assistant text for the whole child session (empty if unreadable). */
export function readFinalText(rawPath: string): string {
	let content: string;
	try {
		content = fs.readFileSync(rawPath, "utf-8");
	} catch {
		return "";
	}
	return lastAssistantText(content);
}

/** Read all bytes appended at/after fromByte, or undefined if nothing new. */
export function readRange(filePath: string, fromByte: number): Buffer | undefined {
	let fd: number;
	try {
		fd = fs.openSync(filePath, "r");
	} catch {
		return undefined;
	}
	try {
		const size = fs.fstatSync(fd).size;
		if (size <= fromByte) return undefined;
		const buffer = Buffer.alloc(size - fromByte);
		fs.readSync(fd, buffer, 0, size - fromByte, fromByte);
		return buffer;
	} catch {
		return undefined;
	} finally {
		fs.closeSync(fd);
	}
}
