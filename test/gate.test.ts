import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPolicy } from "../src/policy.ts";
import {
	evaluateDeterministic,
	formatBlockReason,
	formatPrompt,
	planAmendment,
	planGate,
	type DeterministicVerdict,
	type VerdictSource,
} from "../src/gate.ts";
import { resolveSettings, type PluginSettings } from "../src/settings.ts";
import { parseVerdict } from "../src/verdict.ts";

const RULES = `
prefix_rule(pattern = ["git", "status"], decision = "allow", justification = "read-only")
prefix_rule(pattern = ["git", "reset", "--hard"], decision = "forbidden", justification = "discards work")
prefix_rule(pattern = ["cp"], decision = "prompt", justification = "may overwrite files")
`;

function policy(content = RULES) {
	return buildPolicy({ files: [{ path: "test.rules", content }] }).policy;
}

function settings(overrides: Partial<PluginSettings> = {}): PluginSettings {
	return { ...resolveSettings({}), ...overrides };
}

describe("evaluateDeterministic", () => {
	it("reports a forbidden rule verdict with its justification and source", () => {
		const { verdict } = evaluateDeterministic(policy(), "git reset --hard", settings());
		assert.equal(verdict.decision, "forbidden");
		assert.equal(verdict.source, "rule");
		assert.match(verdict.reason!, /discards work/);
		assert.match(verdict.reason!, /test\.rules:3/);
		assert.equal(verdict.blocking.length, 1);
	});

	it("reports an allow rule verdict", () => {
		const { verdict } = evaluateDeterministic(policy(), "git status", settings());
		assert.equal(verdict.decision, "allow");
		assert.equal(verdict.source, "rule");
	});

	it("prompts for a prompt rule", () => {
		const { verdict } = evaluateDeterministic(policy(), "cp a b", settings());
		assert.equal(verdict.decision, "prompt");
		assert.equal(verdict.source, "rule");
	});

	it("prompts for a dangerous command no rule matched", () => {
		const { verdict } = evaluateDeterministic(policy(), "rm -rf /tmp/build", settings());
		assert.equal(verdict.decision, "prompt");
		assert.equal(verdict.source, "heuristics");
		assert.match(verdict.reason!, /forced rm/);
	});

	it("blocks a dangerous command when prompting is disabled", () => {
		const { verdict } = evaluateDeterministic(policy(), "rm -f /tmp/build", settings({ ask: "never" }));
		assert.equal(verdict.decision, "forbidden");
	});

	it("does not treat an unforced rm as dangerous", () => {
		// `unmatched: undefined` exercises the no-opinion path; the shipped default
		// is `prompt`, which would hold this for approval instead.
		const { verdict } = evaluateDeterministic(policy(), "rm /tmp/build/out.txt", settings({ unmatched: undefined }));
		assert.equal(verdict.decision, undefined);
		assert.equal(verdict.source, "none");
	});

	it("sees through wrappers when applying heuristics", () => {
		for (const command of ["sudo rm -rf /tmp/x", "env A=1 rm -rf /tmp/x", "bash -c 'rm -rf /tmp/x'"]) {
			const { verdict } = evaluateDeterministic(policy(), command, settings());
			assert.equal(verdict.decision, "prompt", command);
			assert.equal(verdict.source, "heuristics", command);
		}
	});

	it("keeps a rule verdict even when another segment is dangerous", () => {
		const { verdict } = evaluateDeterministic(policy(), "git status && rm -rf /tmp/x", settings());
		assert.equal(verdict.decision, "prompt");
		// One segment matched a rule, the other fell back to heuristics.
		assert.equal(verdict.source, "rule");
	});

	it("has no opinion for an ordinary unmatched command when unmatched is unset", () => {
		const { verdict } = evaluateDeterministic(policy(), "cargo build --release", settings({ unmatched: undefined }));
		assert.equal(verdict.decision, undefined);
	});

	it("holds every unmatched command for approval by default", () => {
		const { verdict } = evaluateDeterministic(policy(), "cargo build --release", settings());
		assert.equal(verdict.decision, "prompt");
		assert.equal(verdict.source, "unmatched");
	});

	it("applies the configured unmatched verdict", () => {
		const prompt = evaluateDeterministic(policy(), "cargo build", settings({ unmatched: "prompt" }));
		assert.equal(prompt.verdict.decision, "prompt");
		assert.equal(prompt.verdict.source, "unmatched");
		const allow = evaluateDeterministic(policy(), "cargo build", settings({ unmatched: "allow" }));
		assert.equal(allow.verdict.decision, "allow");
		assert.equal(allow.verdict.source, "unmatched");
	});

	it("keeps the heuristics verdict ahead of the unmatched verdict", () => {
		const { verdict } = evaluateDeterministic(policy(), "rm -rf /tmp/x", settings({ unmatched: "allow" }));
		assert.equal(verdict.decision, "prompt");
		assert.equal(verdict.source, "heuristics");
	});

	it("judges every segment of a compound command and takes the strictest", () => {
		const { verdict } = evaluateDeterministic(policy(), "git status && git reset --hard HEAD~1", settings());
		assert.equal(verdict.decision, "forbidden");
	});
});

describe("planGate", () => {
	const verdict = (decision: DeterministicVerdict["decision"], source: VerdictSource = "rule"): DeterministicVerdict => ({
		decision,
		source,
		blocking: [],
	});

	it("blocks forbidden and runs allow regardless of the reviewer", () => {
		for (const judge of [true, false]) {
			const config = settings({ judge });
			assert.equal(planGate(verdict("forbidden"), config), "block");
			assert.equal(planGate(verdict("allow"), config), "run");
		}
	});

	it("hands a prompt verdict to the reviewer, not to a second prompt", () => {
		// The reviewer stands in for the approval prompt; reading it as
		// "only when nothing decided" would make it unreachable once `unmatched`
		// is set, which is exactly the shipped default. Which side answers is the
		// Codex scope toggle (`judge`), not a per-rule choice.
		assert.equal(planGate(verdict("prompt"), settings({ judge: true, unmatched: "prompt" })), "review");
		assert.equal(planGate(verdict(undefined), settings({ judge: true })), "review");
	});

	it("asks the user when the reviewer is off", () => {
		assert.equal(planGate(verdict("prompt"), settings({ judge: false })), "ask");
		assert.equal(planGate(verdict(undefined), settings({ judge: false })), "pass");
	});

	it("still reviews an unmatched verdict the policy allowed", () => {
		const config = settings({ judge: true, unmatched: "allow" });
		assert.equal(planGate(verdict("allow", "unmatched"), config), "run");
	});
});

describe("formatBlockReason", () => {
	it("carries the rule justification to the model", () => {
		const { verdict } = evaluateDeterministic(policy(), "git reset --hard", settings());
		const reason = formatBlockReason(verdict);
		assert.match(reason, /Blocked by execution policy/);
		assert.match(reason, /discards work/);
	});

	it("refuses a command the policy forbids prompting for", () => {
		const { verdict } = evaluateDeterministic(policy(), "tar --help", settings({ unmatched: "prompt", ask: "never" }));
		assert.equal(verdict.decision, "prompt");
		// ask=never turns the prompt into a block at the call site; the reason is
		// still the rule's, so the model learns what the rule was.
		assert.match(formatBlockReason({ decision: "forbidden", source: "rule", blocking: [] }), /Blocked by execution policy/);
	});
});

describe("formatPrompt", () => {
	it("asks the question Codex asks and shows the reason and command", () => {
		const { verdict } = evaluateDeterministic(policy(), "cp a b", settings());
		const prompt = formatPrompt("cp a b", verdict);
		assert.equal(prompt.title, "Would you like to run the following command?");
		assert.equal(prompt.body, "Reason: may overwrite files [test.rules:4]\n\n$ cp a b");
	});

	it("omits the reason line when no layer gave one", () => {
		const prompt = formatPrompt("cargo build", { decision: "prompt", source: "judge", blocking: [] });
		assert.equal(prompt.body, "$ cargo build");
	});
});

describe("planAmendment", () => {
	it("proposes the full argv of a dangerous command", () => {
		const loaded = buildPolicy({ files: [{ path: "test.rules", content: "" }] });
		const config = settings();
		const { evaluation, verdict } = evaluateDeterministic(loaded.policy, "rm -rf /tmp/abc", config);
		assert.equal(verdict.decision, "prompt");
		assert.equal(verdict.source, "heuristics");
		assert.deepEqual(planAmendment(loaded.policy, evaluation, config, verdict.source), ["rm", "-rf", "/tmp/abc"]);
	});

	it("proposes the argv of an unmatched command the policy prompts for", () => {
		const loaded = buildPolicy({ files: [{ path: "test.rules", content: "" }] });
		const config = settings({ unmatched: "prompt" });
		const { evaluation, verdict } = evaluateDeterministic(loaded.policy, "cargo publish --token abc", config);
		assert.equal(verdict.source, "unmatched");
		assert.deepEqual(planAmendment(loaded.policy, evaluation, config, verdict.source), [
			"cargo",
			"publish",
			"--token",
			"abc",
		]);
	});

	it("proposes nothing when a rule already decides the command", () => {
		const config = settings();
		const command = "cp a b";
		const { evaluation, verdict } = evaluateDeterministic(policy(), command, config);
		assert.equal(verdict.source, "rule");
		assert.equal(planAmendment(policy(), evaluation, config, verdict.source), undefined);
	});

	it("proposes nothing when another segment of the line would keep prompting", () => {
		const config = settings();
		const command = "rm -rf /tmp/a && rm -rf /tmp/b";
		const { evaluation, verdict } = evaluateDeterministic(policy(), command, config);
		assert.equal(evaluation.segments.length, 2);
		assert.equal(planAmendment(policy(), evaluation, config, verdict.source), undefined);
	});

	it("proposes a prefix that covers every segment of the line", () => {
		const loaded = buildPolicy({ files: [{ path: "test.rules", content: "" }] });
		const config = settings({ unmatched: "prompt" });
		const command = "npm ci && npm ci";
		const { evaluation, verdict } = evaluateDeterministic(loaded.policy, command, config);
		assert.deepEqual(planAmendment(loaded.policy, evaluation, config, verdict.source), ["npm", "ci"]);
	});

	it("proposes nothing when the prefix itself spans lines", () => {
		// The approval label and the rendered rule line both break on a newline,
		// so Codex refuses the amendment; a token carrying one is the trigger.
		const loaded = buildPolicy({ files: [{ path: "test.rules", content: "" }] });
		const config = settings({ unmatched: "prompt" });
		const command = 'git commit -m "subject\n\nbody"';
		const { evaluation, verdict } = evaluateDeterministic(loaded.policy, command, config);
		assert.equal(verdict.decision, "prompt");
		assert.equal(planAmendment(loaded.policy, evaluation, config, verdict.source), undefined);
	});

	it("proposes nothing for a prefix that would approve an unbounded command class", () => {
		const loaded = buildPolicy({ files: [{ path: "test.rules", content: "" }] });
		const config = settings({ unmatched: "prompt" });
		const { evaluation, verdict } = evaluateDeterministic(loaded.policy, "git", config);
		assert.equal(verdict.decision, "prompt");
		assert.equal(planAmendment(loaded.policy, evaluation, config, verdict.source), undefined);
	});
});

describe("parseVerdict", () => {
	it("accepts a bare JSON object", () => {
		const result = parseVerdict('{"outcome":"deny","risk_level":"high","user_authorization":"low","rationale":"wide rm"}');
		assert.deepEqual(result, {
			ok: true,
			verdict: { outcome: "deny", riskLevel: "high", userAuthorization: "low", rationale: "wide rm" },
		});
	});

	it("accepts JSON wrapped in prose and fences", () => {
		const result = parseVerdict('Sure:\n```json\n{"outcome":"allow","risk_level":"low"}\n```\n');
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.verdict.outcome, "allow");
		assert.equal(result.ok && result.verdict.userAuthorization, "unknown");
	});

	it("treats an unreadable risk level on a denial as high risk", () => {
		const result = parseVerdict('{"outcome":"deny"}');
		assert.equal(result.ok && result.verdict.riskLevel, "high");
	});

	it("rejects a response with no verdict", () => {
		assert.deepEqual(parseVerdict("I cannot help with that."), {
			ok: false,
			kind: "structure",
			error: "judge returned no complete JSON object",
		});
	});

	it("rejects an unrecognized outcome", () => {
		const result = parseVerdict('{"outcome":"maybe"}');
		assert.equal(result.ok, false);
		assert.match(result.ok === false ? result.error : "", /unrecognized outcome/);
	});

	it("rejects malformed JSON", () => {
		const result = parseVerdict('{"outcome":"deny"');
		assert.equal(result.ok, false);
	});
});

describe("resolveSettings", () => {
	it("ships the reviewer-on, prompt-by-default posture", () => {
		const config = resolveSettings(undefined);
		assert.equal(config.enabled, true);
		assert.equal(config.ask, "always");
		// Everything unmatched is held for approval, and the reviewer answers those
		// prompts — the combination Codex exposes as "approve for me".
		assert.equal(config.unmatched, "prompt");
		assert.equal(config.judge, true);
		assert.equal(config.judgeModel, "@smol");
		assert.equal(config.amendRules, false);
	});

	it("reads persisted settings and lets env override them", () => {
		const persisted = resolveSettings({ ask: "never", unbiased: true, judge: true, judgeModel: "openai/gpt-5-mini" });
		assert.equal(persisted.ask, "never");
		assert.equal(persisted.judge, true);
		assert.equal(persisted.judgeModel, "openai/gpt-5-mini");
		process.env.OMP_EXECPOLICY_ASK = "always";
		try {
			assert.equal(resolveSettings({ ask: "never" }).ask, "always");
		} finally {
			delete process.env.OMP_EXECPOLICY_ASK;
		}
	});

	it("ignores values outside the documented enums", () => {
		assert.equal(resolveSettings({ ask: "sometimes" }).ask, "always");
		assert.equal(resolveSettings({ unmatched: "deny" }).unmatched, "prompt");
		assert.equal(resolveSettings({ judgeOnError: "deny" }).judgeOnError, "ask");
	});

	it("lets settings opt out of the shipped posture", () => {
		const config = resolveSettings({ judge: false, unmatched: "allow" });
		assert.equal(config.judge, false);
		assert.equal(config.unmatched, "allow");
		assert.equal(resolveSettings({ unmatched: "none" }).unmatched, undefined);
	});
});
