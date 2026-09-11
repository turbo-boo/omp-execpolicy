import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPolicy, evaluationToJson, Policy } from "../src/policy.ts";
import { parseRuleFile, renderAllowAmendment } from "../src/rules.ts";
import { analyzeCommand } from "../src/command.ts";

const GIT_RULES = `
prefix_rule(
    pattern = ["git", ["status", "log"]],
    decision = "allow",
    justification = "read-only git inspection",
    match = ["git status", ["git", "log", "--oneline"]],
    not_match = [["git", "push"]],
)

prefix_rule(
    pattern = ["git", "reset", "--hard"],
    decision = "forbidden",
    justification = "discards uncommitted work",
)

prefix_rule(
    pattern = ["git", "push"],
    decision = "prompt",
)
`;

function load(...files: { path: string; content: string }[]) {
	return buildPolicy({ files });
}

describe("parseRuleFile", () => {
	it("parses patterns, alternatives, decisions, and examples", () => {
		const result = parseRuleFile(GIT_RULES, "test.rules");
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.rules.length, 3);
		assert.deepEqual(result.rules[0]!.pattern, [
			{ kind: "single", value: "git" },
			{ kind: "alts", values: ["status", "log"] },
		]);
		assert.equal(result.rules[0]!.decision, "allow");
		assert.equal(result.rules[1]!.decision, "forbidden");
		assert.deepEqual(result.rules[0]!.notMatch, [["git", "push"]]);
	});

	it("defaults decision to allow, like Codex", () => {
		const result = parseRuleFile('prefix_rule(pattern = ["ls"])', "test.rules");
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.rules[0]!.decision, "allow");
	});

	it("reports unknown directives and arguments without throwing", () => {
		const result = parseRuleFile('network_rule(host = "example.com")\nprefix_rule(pattern=["ls"], nope=1)', "test.rules");
		assert.equal(result.rules.length, 1);
		assert.ok(result.diagnostics.some(d => d.message.includes("unknown directive network_rule")));
		assert.ok(result.diagnostics.some(d => d.message.includes("unknown argument nope")));
	});

	it("reports malformed rules with a line number", () => {
		const result = parseRuleFile('prefix_rule(\n  pattern = ["ls"],\n  decision = "maybe",\n)', "test.rules");
		assert.equal(result.rules.length, 0);
		assert.equal(result.diagnostics[0]!.line, 1);
		assert.ok(result.diagnostics[0]!.message.includes('"allow", "prompt", or "forbidden"'));
	});

	it("requires a non-empty pattern", () => {
		const result = parseRuleFile("prefix_rule(pattern = [])", "test.rules");
		assert.equal(result.rules.length, 0);
		assert.ok(result.diagnostics[0]!.message.includes("non-empty pattern"));
	});

	it("requires host_executable paths to match their basename", () => {
		const result = parseRuleFile('host_executable(name = "git", paths = ["/tmp/other"])', "test.rules");
		assert.equal(result.hostExecutables.length, 0);
		assert.ok(result.diagnostics[0]!.message.includes("must be absolute with basename"));
	});

	it("round-trips a rendered allow amendment", () => {
		const line = renderAllowAmendment(["git", "push", "origin"], "approved");
		const result = parseRuleFile(line, "amended.rules");
		assert.deepEqual(result.diagnostics, []);
		assert.equal(result.rules[0]!.decision, "allow");
		assert.deepEqual(result.rules[0]!.pattern, [
			{ kind: "single", value: "git" },
			{ kind: "single", value: "push" },
			{ kind: "single", value: "origin" },
		]);
	});
});

describe("Policy.check", () => {
	it("matches alternatives on any token position", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		assert.equal(policy.check("git log --oneline").decision, "allow");
		assert.equal(policy.check("git status").decision, "allow");
		assert.equal(policy.check("git push origin main").decision, "prompt");
	});

	it("returns no decision when nothing matches", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const evaluation = policy.check("cargo build");
		assert.equal(evaluation.decision, undefined);
		assert.deepEqual(evaluation.matchedRules, []);
	});

	it("takes the strictest decision across matching rules", () => {
		const { policy } = load({
			path: "test.rules",
			content: `
prefix_rule(pattern = ["git"], decision = "allow")
prefix_rule(pattern = ["git", "reset"], decision = "forbidden")
`,
		});
		assert.equal(policy.check("git reset --hard HEAD~3").decision, "forbidden");
	});

	it("evaluates every segment of a compound command", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const evaluation = policy.check("git status && git reset --hard HEAD~1");
		assert.equal(evaluation.decision, "forbidden");
		assert.deepEqual(evaluation.segments.map(segment => segment.text), ["git status", "git reset --hard HEAD~1"]);
	});

	it("sees through nested shells and wrappers before matching", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		assert.equal(policy.check("bash -c 'git reset --hard HEAD~1'").decision, "forbidden");
		assert.equal(policy.check("sudo git reset --hard HEAD~1").decision, "forbidden");
		assert.equal(policy.check("echo hi | git push origin main").decision, "prompt");
	});

	it("ignores rules that only match a longer prefix", () => {
		const { policy } = load({
			path: "test.rules",
			content: 'prefix_rule(pattern = ["git", "push", "--force"], decision = "forbidden")',
		});
		assert.equal(policy.check("git push origin main").decision, undefined);
		assert.equal(policy.check("git push --force origin main").decision, "forbidden");
	});

	it("falls back to basename rules for an absolute program path", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const evaluation = policy.check("/usr/bin/git status");
		assert.equal(evaluation.decision, "allow");
		const match = evaluation.matchedRules[0]!;
		assert.equal(match.kind === "prefix_rule" && match.resolvedProgram, "/usr/bin/git");
	});

	it("prefers an exact absolute first token over basename fallback", () => {
		const { policy } = load({
			path: "test.rules",
			content: `${GIT_RULES}\nprefix_rule(pattern = ["/usr/bin/git", "status"], decision = "prompt")`,
		});
		assert.equal(policy.check("/usr/bin/git status").decision, "prompt");
	});

	it("honours host_executable paths for basename fallback", () => {
		const { policy } = load({
			path: "test.rules",
			content: `${GIT_RULES}\nhost_executable(name = "git", paths = ["/usr/bin/git"])`,
		});
		assert.equal(policy.check("/usr/bin/git status").decision, "allow");
		// An unlisted copy of the program does not inherit the `git` rules.
		assert.equal(policy.check("/tmp/git status").decision, undefined);
	});

	it("only applies host_executable constraints to the listed basename", () => {
		const { policy } = load({
			path: "test.rules",
			content: `${GIT_RULES}\nhost_executable(name = "git", paths = ["/usr/bin/git"])`,
		});
		assert.equal(policy.check("/usr/local/bin/git status").decision, undefined);
	});

	it("merges later files additively", () => {
		const { policy } = load(
			{ path: "low.rules", content: 'prefix_rule(pattern = ["ls"], decision = "allow")' },
			{ path: "high.rules", content: 'prefix_rule(pattern = ["ls", "-la"], decision = "prompt")' },
		);
		assert.equal(policy.check("ls").decision, "allow");
		assert.equal(policy.check("ls -la").decision, "prompt");
	});
});

describe("example validation", () => {
	it("flags a match example the rule does not match", () => {
		const loaded = load({
			path: "test.rules",
			content: 'prefix_rule(pattern = ["git"], match = [["git", "status"]])',
		});
		assert.deepEqual(loaded.diagnostics, []);
	});

	it("flags a match example with a different first token", () => {
		const loaded = load({
			path: "test.rules",
			content: 'prefix_rule(pattern = ["git"], match = [["ls", "-la"]])',
		});
		assert.ok(loaded.diagnostics.some(d => d.message.includes("does not match")));
	});

	it("validates examples against the declaration's own expanded variants", () => {
		// One declaration with a first-token alternation expands into one rule per
		// alternative. Each example belongs to the declaration, not to a single
		// variant, so `npm install` must not be required to match the `pnpm` rule.
		const loaded = load({
			path: "test.rules",
			content: `prefix_rule(
	pattern = [["npm", "pnpm"]],
	decision = "prompt",
	match = ["npm install", ["pnpm", "add", "left-pad"]],
)`,
		});
		assert.deepEqual(loaded.diagnostics, []);
		assert.equal(loaded.policy.check("npm install").decision, "prompt");
		assert.equal(loaded.policy.check("pnpm add left-pad").decision, "prompt");
	});

	it("flags a not_match example that matches", () => {
		const loaded = load({
			path: "test.rules",
			content: 'prefix_rule(pattern = ["git"], not_match = ["git push"])',
		});
		assert.ok(loaded.diagnostics.some(d => d.message.includes("matches git")));
	});
});

describe("evaluationToJson", () => {
	it("emits the Codex CLI shape", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const json = evaluationToJson(policy.check("git reset --hard")) as {
			decision: string;
			matchedRules: { prefixRuleMatch: { matchedPrefix: string[]; decision: string; justification?: string } }[];
		};
		assert.equal(json.decision, "forbidden");
		assert.deepEqual(json.matchedRules[0]!.prefixRuleMatch.matchedPrefix, ["git", "reset", "--hard"]);
		assert.equal(json.matchedRules[0]!.prefixRuleMatch.justification, "discards uncommitted work");
	});

	it("omits the decision when nothing matched", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const json = evaluationToJson(policy.check("cargo build")) as Record<string, unknown>;
		assert.deepEqual(json.matchedRules, []);
		assert.equal("decision" in json, false);
	});
});

describe("withPrefixRule", () => {
	it("appends an allow rule for a command no rule governed", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const amended = policy.withPrefixRule(["cargo", "publish"], "allow");
		assert.equal(amended.check("cargo publish").decision, "allow");
		assert.equal(amended.check("cargo publish --dry-run").decision, "allow");
	});

	it("cannot soften a broader rule that already decides the command", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const amended = policy.withPrefixRule(["git", "push", "origin", "main"], "allow");
		assert.equal(amended.check("git push origin main").decision, "prompt");
	});

	it("leaves the original policy untouched", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		policy.withPrefixRule(["cargo", "publish"], "allow");
		assert.equal(policy.check("cargo publish").decision, undefined);
	});

	it("cannot soften a forbidden rule", () => {
		const { policy } = load({ path: "test.rules", content: GIT_RULES });
		const amended = policy.withPrefixRule(["git", "reset", "--hard"], "allow");
		assert.equal(amended.check("git reset --hard").decision, "forbidden");
	});
});

describe("unresolvable segments", () => {
	it("are skipped rather than matched", () => {
		const policy = Policy.empty();
		const evaluation = policy.check(`${"sudo ".repeat(12)}rm -rf /`);
		assert.equal(evaluation.decision, undefined);
		assert.equal(analyzeCommand(`${"sudo ".repeat(12)}rm -rf /`).segments.some(segment => segment.unresolved), true);
	});
});
