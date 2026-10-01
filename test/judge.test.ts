import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeCommand, type JudgeDeps } from "../src/judge.ts";

function assistant(text: string, stopReason = "stop", errorMessage?: string): any {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		stopReason,
		errorMessage,
		timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
	};
}

function baseDeps(complete: NonNullable<JudgeDeps["complete"]>, retries = 1): JudgeDeps {
	return {
		model: {} as JudgeDeps["model"],
		apiKey: undefined,
		sessionId: "test-session",
		retries,
		complete,
	};
}

const request = { command: "git status", cwd: "/repo", transcript: "user: inspect the repository" };

describe("judgeCommand structural recovery", () => {
	it("retries a malformed response once and accepts the repaired verdict", async () => {
		let calls = 0;
		const complete = (async (_model: unknown, context: any) => {
			calls++;
			if (calls === 1) return assistant("I think this is safe.");
			assert.match(context.messages[0].content, /# Output Repair/);
			return assistant(
				'{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"read-only"}',
			);
		}) as NonNullable<JudgeDeps["complete"]>;

		const result = await judgeCommand(request, baseDeps(complete, 1));
		assert.equal(calls, 2);
		assert.equal(result.ok, true);
	});

	it("retries an empty model response", async () => {
		let calls = 0;
		const complete = (async () => {
			calls++;
			return calls === 1
				? assistant("")
				: assistant('{"outcome":"deny","risk_level":"high","user_authorization":"low","rationale":"unsafe"}');
		}) as NonNullable<JudgeDeps["complete"]>;

		const result = await judgeCommand(request, baseDeps(complete, 1));
		assert.equal(calls, 2);
		assert.equal(result.ok, true);
	});

	it("does not retry provider failures", async () => {
		let calls = 0;
		const complete = (async () => {
			calls++;
			return assistant("", "error", "provider unavailable");
		}) as NonNullable<JudgeDeps["complete"]>;

		const result = await judgeCommand(request, baseDeps(complete, 2));
		assert.equal(calls, 1);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "provider");
	});

	it("returns the structural error when retries are disabled", async () => {
		let calls = 0;
		const complete = (async () => {
			calls++;
			return assistant("not json");
		}) as NonNullable<JudgeDeps["complete"]>;

		const result = await judgeCommand(request, baseDeps(complete, 0));
		assert.equal(calls, 1);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.kind, "structure");
	});
});
