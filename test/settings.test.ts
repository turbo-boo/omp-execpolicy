import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSettings } from "../src/settings.ts";

describe("judge retry settings", () => {
	it("defaults to one structural retry", () => {
		assert.equal(resolveSettings({}).judgeRetries, 1);
	});

	it("accepts zero and floors positive numeric values", () => {
		assert.equal(resolveSettings({ judgeRetries: 0 }).judgeRetries, 0);
		assert.equal(resolveSettings({ judgeRetries: 2.9 }).judgeRetries, 2);
		assert.equal(resolveSettings({ judgeRetries: 99 }).judgeRetries, 3);
	});

	it("lets the environment override the persisted value", () => {
		process.env.OMP_EXECPOLICY_JUDGE_RETRIES = "3";
		try {
			assert.equal(resolveSettings({ judgeRetries: 1 }).judgeRetries, 3);
		} finally {
			delete process.env.OMP_EXECPOLICY_JUDGE_RETRIES;
		}
	});
});
