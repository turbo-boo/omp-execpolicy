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

import { completeSimple, type Api, type ApiKey, type AssistantMessage, type Model } from "@oh-my-pi/pi-ai";
import { JUDGE_SYSTEM_PROMPT, buildJudgePrompt } from "./prompt.ts";
import { parseVerdict, type JudgeResult } from "./verdict.ts";

export type { JudgeOutcome, JudgeResult, JudgeRiskLevel, JudgeUserAuthorization, JudgeVerdict } from "./verdict.ts";
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
}

const DEFAULT_MAX_TOKENS = 4096;

function textOf(message: AssistantMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") parts.push(block.text);
	}
	return parts.join("\n").trim();
}

/** Ask the judge about one command. Never throws. */
export async function judgeCommand(request: JudgeRequest, deps: JudgeDeps): Promise<JudgeResult> {
	const prompt = buildJudgePrompt({
		command: request.command,
		cwd: request.cwd,
		transcript: request.transcript,
		...(request.policy === undefined ? {} : { policy: request.policy }),
	});
	try {
		const message = await completeSimple(
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
			return { ok: false, error: `judge request failed: ${message.errorMessage ?? "unknown provider error"}` };
		}
		const text = textOf(message);
		if (text.length === 0) return { ok: false, error: "judge returned an empty response" };
		return parseVerdict(text);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}
