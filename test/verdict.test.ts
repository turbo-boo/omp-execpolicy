import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVerdict } from "../src/verdict.ts";

describe("parseVerdict", () => {
	it("accepts the canonical JSON shape", () => {
		const result = parseVerdict(
			'{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"read-only"}',
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(result.verdict, {
			outcome: "allow",
			riskLevel: "low",
			userAuthorization: "high",
			rationale: "read-only",
		});
	});

	it("extracts fenced JSON and normalizes enum casing", () => {
		const result = parseVerdict(`Here is the verdict:
\`\`\`json
{"outcome":"ALLOW","riskLevel":"MEDIUM","userAuthorization":"HIGH","reason":"bounded"}
\`\`\`
`);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.verdict.outcome, "allow");
		assert.equal(result.verdict.riskLevel, "medium");
		assert.equal(result.verdict.userAuthorization, "high");
		assert.equal(result.verdict.rationale, "bounded");
	});

	it("repairs a trailing comma without modifying commas inside strings", () => {
		const result = parseVerdict(
			'{"outcome":"deny","risk_level":"high","user_authorization":"low","rationale":"literal ,} remains",}',
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.verdict.rationale, "literal ,} remains");
	});

	it("ignores unrelated JSON objects when one valid verdict exists", () => {
		const result = parseVerdict(
			'{"debug":true}\n{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"ok"}',
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.verdict.outcome, "allow");
	});

	it("unwraps a common verdict envelope", () => {
		const result = parseVerdict(
			'{"verdict":{"outcome":"allow","risk_level":"low","user_authorization":"medium","rationale":"wrapped"}}',
		);
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.verdict.rationale, "wrapped");
	});

	it("accepts duplicate identical verdicts", () => {
		const verdict = '{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"same"}';
		const result = parseVerdict(`${verdict}\n${verdict}`);
		assert.equal(result.ok, true);
	});

	it("rejects conflicting valid verdicts instead of guessing", () => {
		const result = parseVerdict(
			'{"outcome":"allow","risk_level":"low","user_authorization":"high","rationale":"a"}\n' +
				'{"outcome":"deny","risk_level":"high","user_authorization":"high","rationale":"b"}',
		);
		assert.equal(result.ok, false);
		if (result.ok) return;
		assert.equal(result.kind, "invalid_verdict");
		assert.match(result.error, /conflicting/);
	});

	it("distinguishes structural failure from an invalid semantic verdict", () => {
		const structural = parseVerdict("ALLOW");
		assert.equal(structural.ok, false);
		if (!structural.ok) assert.equal(structural.kind, "structure");

		const semantic = parseVerdict('{"outcome":"maybe"}');
		assert.equal(semantic.ok, false);
		if (!semantic.ok) assert.equal(semantic.kind, "invalid_verdict");

		const wrongType = parseVerdict('{"outcome":"allow","risk_level":3}');
		assert.equal(wrongType.ok, false);
		if (!wrongType.ok) assert.equal(wrongType.kind, "invalid_verdict");
	});
});
