/**
 * Transcript digest for the model judge.
 *
 * Codex's Guardian reviewer sees a bounded transcript plus the planned action;
 * full session history is neither necessary nor affordable. This module renders
 * the trailing slice of the session into compact text: user turns, the agent's
 * short text, and the commands already run — enough to answer "did the user
 * authorize this action?" without dragging tool output into the prompt.
 */

import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";

const MAX_ENTRIES = 60;
const MAX_TEXT_CHARS = 600;
const MAX_MESSAGE_CHARS = 12_000;
const BASH_COMMAND_CHARS = 400;

function clip(value: string, limit: number): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
	}
	return parts.join("\n");
}

function assistantLine(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block === null || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		if (record.type === "text" && typeof record.text === "string") parts.push(record.text);
		else if (record.type === "toolCall" && typeof record.name === "string") {
			const args = record.arguments ?? record.input;
			const command =
				args !== null && typeof args === "object" && typeof (args as Record<string, unknown>).command === "string"
					? ` ${JSON.stringify(clip((args as Record<string, unknown>).command as string, BASH_COMMAND_CHARS))}`
					: "";
			parts.push(`[calls ${record.name}${command}]`);
		}
	}
	return parts.join(" ");
}

/**
 * Render the tail of the session as `role: text` lines. Entries older than the
 * window are dropped; if that drops everything, the function keeps shrinking
 * until at least the most recent entry fits.
 */
export function renderTranscript(entries: readonly SessionEntry[]): string {
	const lines: string[] = [];
	for (const entry of entries.slice(-MAX_ENTRIES)) {
		if (entry.type === "message") {
			const message = entry.message as { role?: string; content?: unknown };
			if (message.role === "user") {
				const text = messageText(message.content);
				if (text.length > 0) lines.push(`user: ${clip(text, MAX_TEXT_CHARS)}`);
			} else if (message.role === "assistant") {
				const text = assistantLine(message.content);
				if (text.length > 0) lines.push(`agent: ${clip(text, MAX_TEXT_CHARS)}`);
			}
		} else if (entry.type === "custom_message" && entry.customType !== "execpolicy-judge") {
			const text = messageText(entry.content);
			if (text.length > 0) lines.push(`context: ${clip(text, MAX_TEXT_CHARS)}`);
		}
	}
	let rendered = lines.join("\n");
	if (rendered.length <= MAX_MESSAGE_CHARS) return rendered;
	rendered = rendered.slice(rendered.length - MAX_MESSAGE_CHARS);
	const firstBreak = rendered.indexOf("\n");
	return firstBreak === -1 ? rendered : rendered.slice(firstBreak + 1);
}
