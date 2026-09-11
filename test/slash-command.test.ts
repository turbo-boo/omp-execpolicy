import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerExecpolicyCommand } from "../src/slash-command.ts";
import { buildPolicy, type Policy } from "../src/policy.ts";
import { loadRuleFiles, resolveRuleDirs } from "../src/rule-files.ts";
import { resolveSettings, type PluginSettings } from "../src/settings.ts";
import type { EngineState } from "../src/state.ts";

const RULES = `
prefix_rule(pattern = ["git", "status"], decision = "allow", justification = "read-only")
prefix_rule(pattern = ["git", "reset", "--hard"], decision = "forbidden", justification = "discards work")
prefix_rule(pattern = ["cp"], decision = "prompt")
`;

/** Build a state the way the engine would, without touching the harness. */
function stateFor(content: string, overrides: Partial<PluginSettings> = {}): EngineState {
	const settings = { ...resolveSettings({}), ...overrides };
	const files = content.length === 0 ? [] : [{ path: "/repo/.omp/rules/test.rules", content }];
	const loaded = buildPolicy({ files });
	return {
		settings,
		resolved: { files, searchedDirs: ["/repo/.omp/rules"] },
		loaded,
		policy: loaded.policy,
		judgePolicy: undefined,
	};
}

interface Harness {
	/** Invoke the registered `/execpolicy` handler and return its output text. */
	run: (args: string) => Promise<string>;
	commands: string[];
}

function harness(state: EngineState | (() => EngineState)): Harness {
	const commands: string[] = [];
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		registerCommand(name: string, options: { handler: typeof handler }) {
			commands.push(name);
			handler = options.handler;
		},
		sendMessage(message: { content: unknown }) {
			lastOutput = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
		},
	} as unknown as ExtensionAPI;
	let lastOutput = "";
	registerExecpolicyCommand(pi, async () => (typeof state === "function" ? state() : state));
	return {
		commands,
		async run(args: string) {
			if (handler === undefined) throw new Error("/execpolicy was never registered");
			const ctx = { cwd: "/repo" } as unknown as ExtensionCommandContext;
			await handler(args, ctx);
			return lastOutput;
		},
	};
}

describe("/execpolicy registration", () => {
	it("registers the command", () => {
		assert.deepEqual(harness(stateFor(RULES)).commands, ["execpolicy"]);
	});
});

describe("/execpolicy status", () => {
	it("reports settings, rule files, and the judge", async () => {
		const output = await harness(stateFor(RULES, { judge: true, judgeModel: "openai/gpt-5-mini" })).run("status");
		assert.match(output, /^# Execution policy/);
		assert.match(output, /enabled: yes/);
		assert.match(output, /rules loaded: 3/);
		assert.match(output, /prompt policy: ask the user/);
		assert.match(output, /openai\/gpt-5-mini/);
		assert.match(output, /\/repo\/\.omp\/rules\/test\.rules \(3 rules\)/);
		assert.match(output, /searched: \/repo\/\.omp\/rules/);
	});

	it("reports prompting disabled and no rule files", async () => {
		const output = await harness(stateFor("", { ask: "never", unmatched: "prompt" })).run("");
		assert.match(output, /prompt policy: never prompt/);
		assert.match(output, /unmatched commands: prompt/);
		assert.match(output, /\(none found\)/);
	});
});

describe("/execpolicy files", () => {
	it("lists discovered files and reports clean diagnostics", async () => {
		const output = await harness(stateFor(RULES)).run("files");
		assert.match(output, /\/repo\/\.omp\/rules\/test\.rules/);
		assert.match(output, /No parse diagnostics\./);
	});

	it("surfaces parse diagnostics with a line number", async () => {
		const output = await harness(stateFor('prefix_rule(\n  pattern = ["ls"],\n  decision = "nope",\n)')).run("files");
		assert.match(output, /test\.rules:1 \[error\]/);
		assert.match(output, /"allow", "prompt", or "forbidden"/);
	});
});

describe("/execpolicy rules", () => {
	it("lists every compiled rule with its decision and source", async () => {
		const output = await harness(stateFor(RULES)).run("rules");
		assert.match(output, /- \[allow\] git status — read-only/);
		assert.match(output, /- \[forbidden\] git reset --hard — discards work/);
		assert.match(output, /\/repo\/\.omp\/rules\/test\.rules:4/);
	});

	it("filters by pattern or justification", async () => {
		const output = await harness(stateFor(RULES)).run("rules discards");
		assert.match(output, /git reset --hard/);
		assert.doesNotMatch(output, /git status/);
	});

	it("reports an empty match set", async () => {
		assert.match(await harness(stateFor(RULES)).run("rules nothing-matches"), /# No rules matched\./);
	});
});

describe("/execpolicy check", () => {
	it("prints the Codex CLI JSON shape", async () => {
		const output = await harness(stateFor(RULES)).run("check git reset --hard");
		const json = JSON.parse(output) as {
			decision: string;
			matchedRules: { prefixRuleMatch: { matchedPrefix: string[]; decision: string } }[];
		};
		assert.equal(json.decision, "forbidden");
		assert.deepEqual(json.matchedRules[0]!.prefixRuleMatch.matchedPrefix, ["git", "reset", "--hard"]);
		assert.equal(json.matchedRules[0]!.prefixRuleMatch.decision, "forbidden");
	});

	it("omits the decision when nothing matches", async () => {
		const json = JSON.parse(await harness(stateFor(RULES)).run("check cargo build")) as Record<string, unknown>;
		assert.deepEqual(json.matchedRules, []);
		assert.equal("decision" in json, false);
	});

	it("prints help when no command is given", async () => {
		assert.match(await harness(stateFor(RULES)).run("check"), /^Usage: \/execpolicy/);
	});
});

describe("/execpolicy explain", () => {
	it("names the deciding layer and reason", async () => {
		const output = await harness(stateFor(RULES)).run("explain git reset --hard");
		assert.match(output, /decision: forbidden/);
		assert.match(output, /deciding layer: rule/);
		assert.match(output, /discards work/);
	});

	it("shows the dangerous-command fallback with its segments", async () => {
		const output = await harness(stateFor(RULES)).run("explain sudo rm -rf /tmp/x");
		assert.match(output, /decision: prompt/);
		assert.match(output, /deciding layer: heuristics/);
		assert.match(output, /forced rm/);
		assert.match(output, /evaluated segments/);
	});

	it("reports no opinion for an ordinary unmatched command", async () => {
		const output = await harness(stateFor(RULES, { unmatched: undefined })).run("explain cargo build --release");
		assert.match(output, /decision: \(no opinion — allowed\)/);
		assert.match(output, /deciding layer: none/);
	});

	it("applies the unmatched verdict when configured", async () => {
		const output = await harness(stateFor(RULES, { unmatched: "allow" })).run("explain cargo build");
		assert.match(output, /decision: allow/);
		assert.match(output, /deciding layer: unmatched/);
	});
});

describe("/execpolicy dispatch", () => {
	it("defaults to status and rejects unknown subcommands", async () => {
		assert.match(await harness(stateFor(RULES)).run(""), /^# Execution policy/);
		assert.match(await harness(stateFor(RULES)).run("nope"), /Unknown subcommand "nope"/);
	});

	it("prints help on request", async () => {
		assert.match(await harness(stateFor(RULES)).run("help"), /^Usage: \/execpolicy/);
	});
});

describe("rule-file discovery", () => {
	it("searches the omp config layout for both scopes, lowest precedence first", () => {
		const dirs = resolveRuleDirs("/repo", "/home/user/.omp/agent");
		assert.equal(dirs[0], "/repo/.gemini/rules");
		assert.ok(dirs.includes("/repo/.omp/rules"));
		assert.ok(dirs.includes("/home/user/.omp/agent/rules"));
		// The project `.omp` directory is the highest-precedence discovered input.
		assert.equal(dirs.at(-1), "/home/user/.omp/agent/rules");
		assert.equal(new Set(dirs).size, dirs.length);
	});

	it("loads only .rules files and honours explicit extras", () => {
		const settings = { ...resolveSettings({}), extraRuleFiles: ["/repo/extra.rules"] };
		const resolved = loadRuleFiles(settings, ["/definitely/missing"], "/repo");
		assert.deepEqual(resolved.searchedDirs, []);
		assert.deepEqual(resolved.files.map(file => file.path), []);
	});
});

describe("policy emptiness", () => {
	it("has no opinion with no rules", () => {
		const policy: Policy = buildPolicy({ files: [] }).policy;
		assert.equal(policy.check("anything at all").decision, undefined);
	});
});
