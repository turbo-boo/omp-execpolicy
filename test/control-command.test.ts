import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
	let getArgumentCompletions: ((prefix: string) => Array<{ value: string; label: string }> | null) | undefined;
	const eventHandlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let output = "";
	let sendMessageCalls = 0;
	let execCall: { command: string; args: string[]; cwd?: string } | undefined;
	let judgeModel = options.judgeModel ?? "@smol";

	const pi = {
		on(event: string, callback: (event: unknown, ctx: ExtensionContext) => unknown) {
			eventHandlers.set(event, callback);
		},
		registerCommand(
			_name: string,
			command: {
				handler: typeof handler;
				getArgumentCompletions?: typeof getArgumentCompletions;
			},
		) {
			handler = command.handler;
			getArgumentCompletions = command.getArgumentCompletions;
		},
		sendMessage() {
			sendMessageCalls++;
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

	const available = [...new Map(Object.values(options.resolvedModels ?? {}).map(model => [`${model.provider}/${model.id}`, model])).values()];
	const ctx = {
		cwd: "/repo",
		model: options.sessionModel as any,
		models: {
			list: () => available as any[],
			resolve: (spec: string) => options.resolvedModels?.[spec] as any,
		},
		ui: {
			setWidget(_key: string, widget: string[] | undefined) {
				output = widget === undefined ? "" : widget.join("\n");
			},
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
	eventHandlers.get("session_start")?.({}, ctx as unknown as ExtensionContext);

	return {
		async run(args: string) {
			if (handler === undefined) throw new Error("command not registered");
			await handler(args, ctx);
			return output;
		},
		complete(prefix: string) {
			return getArgumentCompletions?.(prefix) ?? null;
		},
		setSessionModel(model: { provider: string; id: string }) {
			(ctx as any).model = model;
		},
		get execCall() {
			return execCall;
		},
		get sendMessageCalls() {
			return sendMessageCalls;
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
		assert.equal(before, "judge: @smol → opencode-go/mimo-judge");
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
		assert.equal(output, "judge: @slow → anthropic/claude-judge");
		assert.deepEqual(h.execCall, {
			command: "omp",
			args: ["plugin", "config", "set", "omp-execpolicy", "judgeModel", "@slow"],
			cwd: "/repo",
		});
	});

	it("rejects an unknown judge model without changing plugin config", async () => {
		const h = controlHarness();
		assert.equal(await h.run("model missing/model"), "judge model not found: missing/model");
		assert.equal(h.execCall, undefined);
	});
});

describe("/execpolicy local UI", () => {
	it("renders command output without injecting a message into model context", async () => {
		const h = controlHarness({
			resolvedModels: { "@smol": { provider: "opencode-go", id: "mimo-judge" } },
		});
		assert.equal(await h.run("model"), "judge: @smol → opencode-go/mimo-judge");
		assert.equal(h.sendMessageCalls, 0);
	});
});

describe("/execpolicy autocomplete", () => {
	it("offers subcommands", () => {
		const h = controlHarness();
		assert.deepEqual(
			h.complete("mo")?.map(item => item.value),
			["model"],
		);
		assert.ok(h.complete("")?.some(item => item.value === "config"));
	});

	it("offers judge model roles and resolved models", () => {
		const h = controlHarness({
			resolvedModels: {
				"@smol": { provider: "opencode-go", id: "mimo-judge" },
				"@slow": { provider: "anthropic", id: "claude-judge" },
			},
		});
		const values = h.complete("model ")?.map(item => item.value) ?? [];
		assert.ok(values.includes("@smol"));
		assert.ok(values.includes("@slow"));
		assert.ok(values.includes("opencode-go/mimo-judge"));
		assert.ok(values.includes("anthropic/claude-judge"));
	});

	it("offers config actions and keys", () => {
		const h = controlHarness();
		assert.ok(h.complete("config ")?.some(item => item.value === "set"));
		const keys = h.complete("config set judge")?.map(item => item.value) ?? [];
		assert.ok(keys.includes("judgeModel"));
		assert.ok(keys.includes("judgeRetries"));
		assert.ok(keys.includes("judgeOnError"));
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
