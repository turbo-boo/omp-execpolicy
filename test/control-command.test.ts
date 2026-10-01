import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerExecpolicyCommand } from "../src/slash-command.ts";
import { resolveSettings } from "../src/settings.ts";
import type { EngineState } from "../src/state.ts";

interface HarnessOptions {
	judgeModel?: string;
	sessionModel?: { provider: string; id: string };
	resolvedModels?: Record<string, { provider: string; id: string }>;
	execResult?: { stdout: string; stderr: string; code: number; killed: boolean };
}

function controlHarness(options: HarnessOptions = {}) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let output = "";
	let execCall: { command: string; args: string[]; cwd?: string } | undefined;
	let judgeModel = options.judgeModel ?? "@smol";

	const pi = {
		registerCommand(_name: string, command: { handler: typeof handler }) {
			handler = command.handler;
		},
		sendMessage(message: { content: unknown }) {
			output = String(message.content);
		},
		async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
			execCall = { command, args, cwd: execOptions?.cwd };
			if (
				command === "omp" &&
				args[0] === "plugin" &&
				args[1] === "config" &&
				args[2] === "set" &&
				args[3] === "omp-execpolicy" &&
				args[4] === "judgeModel"
			) {
				judgeModel = args[5] ?? judgeModel;
			}
			return options.execResult ?? { stdout: "ok\n", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		cwd: "/repo",
		model: options.sessionModel as any,
		models: {
			resolve: (spec: string) => options.resolvedModels?.[spec] as any,
		},
	} as unknown as ExtensionCommandContext;

	const loadState = async () =>
		({
			settings: { ...resolveSettings({}), judgeModel },
			resolved: { files: [], searchedDirs: [] },
			loaded: { policy: { ruleCount: 0 }, counts: {}, diagnostics: [] },
			policy: { check: () => ({ segments: [], matchedRules: [] }) },
			judgePolicy: undefined,
		}) as unknown as EngineState;

	registerExecpolicyCommand(pi, loadState);

	return {
		async run(args: string) {
			if (handler === undefined) throw new Error("command not registered");
			await handler(args, ctx);
			return output;
		},
		setSessionModel(model: { provider: string; id: string }) {
			(ctx as any).model = model;
		},
		get execCall() {
			return execCall;
		},
	};
}

describe("/execpolicy model", () => {
	it("shows the judge model, not the current conversation model", async () => {
		const h = controlHarness({
			judgeModel: "@smol",
			sessionModel: { provider: "anthropic", id: "claude-opus-session" },
			resolvedModels: { "@smol": { provider: "opencode-go", id: "mimo-judge" } },
		});
		const before = await h.run("model");
		assert.match(before, /# Execpolicy judge model/);
		assert.match(before, /setting: @smol/);
		assert.match(before, /resolved: opencode-go\/mimo-judge/);
		assert.doesNotMatch(before, /claude-opus-session/);

		h.setSessionModel({ provider: "openai", id: "gpt-session" });
		assert.equal(await h.run("model"), before);
	});

	it("persists the judge model through omp plugin config without switching the session", async () => {
		const h = controlHarness({
			judgeModel: "@smol",
			resolvedModels: { "@slow": { provider: "anthropic", id: "claude-judge" } },
		});
		const output = await h.run("model @slow");
		assert.match(output, /# Execpolicy judge model updated/);
		assert.match(output, /setting: @slow/);
		assert.match(output, /resolved: anthropic\/claude-judge/);
		assert.deepEqual(h.execCall, {
			command: "omp",
			args: ["plugin", "config", "set", "omp-execpolicy", "judgeModel", "@slow"],
			cwd: "/repo",
		});
	});

	it("rejects an unknown judge model without changing plugin config", async () => {
		const h = controlHarness();
		assert.equal(await h.run("model missing/model"), "judge model not found: missing/model\nNo execpolicy setting was changed.");
		assert.equal(h.execCall, undefined);
	});
});

describe("/execpolicy config", () => {
	it("delegates persistent writes to omp plugin config without a shell", async () => {
		const h = controlHarness({ execResult: { stdout: "set\n", stderr: "", code: 0, killed: false } });
		assert.equal(await h.run("config set judgeRetries 2"), "set");
		assert.deepEqual(h.execCall, {
			command: "omp",
			args: ["plugin", "config", "set", "omp-execpolicy", "judgeRetries", "2"],
			cwd: "/repo",
		});
	});

	it("maps reset to the plugin config delete command", async () => {
		const h = controlHarness();
		await h.run("config reset judgeRetries");
		assert.deepEqual(h.execCall, {
			command: "omp",
			args: ["plugin", "config", "delete", "omp-execpolicy", "judgeRetries"],
			cwd: "/repo",
		});
	});

	it("surfaces plugin config failures", async () => {
		const h = controlHarness({ execResult: { stdout: "", stderr: "Unknown setting: nope\n", code: 1, killed: false } });
		const output = await h.run("config get nope");
		assert.match(output, /exit 1/);
		assert.match(output, /Unknown setting: nope/);
	});
});
