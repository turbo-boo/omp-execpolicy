/**
 * Model judge.
 *
 * The deterministic engine in `policy.ts` answers "does a rule decide this?".
 * When no rule decides it and the operator enabled the judge, this module asks
 * a cheap model the question Codex's Guardian reviewer is asked: is this
 * command risky, and did the user authorize it?
 *
 * The judge is deliberately non-authoritative: a provider error, timeout, or
 * unreadable response returns `{ ok: false }` and the caller decides what to do
 * (by default, ask the user). Nothing here blocks a tool call by itself.
 */

import type { Api, ApiKey, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from "./prompt.ts";
import { parseVerdict, type JudgeErrorKind, type JudgeResult } from "./verdict.ts";

export type {
	JudgeErrorKind,
	JudgeOutcome,
	JudgeResult,
	JudgeRiskLevel,
	JudgeUserAuthorization,
	JudgeVerdict,
} from "./verdict.ts";
export { parseVerdict };

export interface JudgeRequest {
	command: string;
	cwd: string;
	transcript: string;
	/** Tenant security policy text; the bundled default applies when omitted. */
	policy?: string;
	signal?: AbortSignal;
}

export interface JudgeDeps {
	model: Model<Api>;
	/** Static key or rotating resolver from `ctx.modelRegistry`. */
	apiKey: ApiKey | undefined;
	sessionId: string;
	maxTokens?: number;
	/** Number of extra attempts after a malformed/empty verdict. */
	retries?: number;
	/** Test seam; production lazily loads `completeSimple`. */
	complete?: typeof import("@oh-my-pi/pi-ai").completeSimple;
}

const DEFAULT_MAX_TOKENS = 4096;

function textOf(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

function isRetryable(kind: JudgeErrorKind): boolean {
	return kind === "empty" || kind === "structure" || kind === "invalid_verdict";
}

function classifyThrown(error: unknown, signal: AbortSignal | undefined): JudgeResult {
	const message = error instanceof Error ? error.message : String(error);
	const name = error instanceof Error ? error.name : "";
	if (signal?.aborted || name === "AbortError" || name === "TimeoutError") {
		return { ok: false, kind: "timeout", error: message };
	}
	return { ok: false, kind: "provider", error: message };
}

function repairInstruction(previous: JudgeResult): string {
	const reason = previous.ok ? "unknown parse failure" : previous.error;
	return [
		"",
		"# Output Repair",
		`The previous answer could not be consumed by the policy engine: ${reason}`,
		"Re-evaluate the same command and return exactly one JSON object.",
		"Do not use Markdown fences, prose before/after the object, comments, or multiple candidate verdicts.",
	].join("\n");
}

/** Ask the judge about one command. Never throws. */
export async function judgeCommand(request: JudgeRequest, deps: JudgeDeps): Promise<JudgeResult> {
	const basePrompt = buildJudgePrompt({
		command: request.command,
		cwd: request.cwd,
		transcript: request.transcript,
		...(request.policy === undefined ? {} : { policy: request.policy }),
	});
	const complete = deps.complete ?? (await import("@oh-my-pi/pi-ai")).completeSimple;
	const requestedRetries = deps.retries ?? 0;
	const retries = Number.isFinite(requestedRetries) ? Math.max(0, Math.floor(requestedRetries)) : 0;
	let previous: JudgeResult | undefined;

	for (let attempt = 0; attempt <= retries; attempt++) {
		if (request.signal?.aborted) {
			return { ok: false, kind: "timeout", error: "judge request aborted before a verdict was produced" };
		}
		const prompt = previous === undefined ? basePrompt : `${basePrompt}${repairInstruction(previous)}`;
		try {
			const message = await complete(
				deps.model,
				{
					systemPrompt: [JUDGE_SYSTEM_PROMPT],
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				{
					...(deps.apiKey === undefined ? {} : { apiKey: deps.apiKey }),
					sessionId: deps.sessionId,
					maxTokens: deps.maxTokens ?? DEFAULT_MAX_TOKENS,
					disableReasoning: true,
					...(request.signal === undefined ? {} : { signal: request.signal }),
				},
			);
			if (message.stopReason === "error") {
				return {
					ok: false,
					kind: "provider",
					error: `judge request failed: ${message.errorMessage ?? "unknown provider error"}`,
				};
			}
			const text = textOf(message);
			if (text.length === 0) {
				previous = { ok: false, kind: "empty", error: "judge returned an empty response" };
			} else {
				previous = parseVerdict(text);
			}
			if (previous.ok) return previous;
			if (!isRetryable(previous.kind) || attempt === retries) return previous;
		} catch (error) {
			return classifyThrown(error, request.signal);
		}
	}

	return previous ?? { ok: false, kind: "structure", error: "judge produced no verdict" };
}
