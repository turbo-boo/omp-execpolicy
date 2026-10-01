import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { registerExecpolicyCommand } from "../src/slash-command.ts";

interface HarnessOptions {
	model?: { provider: string; id: string };
	resolveModel?: { provider: string; id: string };
	modelAccepted?: boolean;
	thinking?: string;
	execResult?: { stdout: string; stderr: string; code: number; killed: boolean };
}

function controlHarness(options: HarnessOptions = {}) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	let output = "";
	let selectedModel: unknown;
	let selectedThinking: string | undefined;
	let execCall: { command: string; args: string[]; cwd?: string } | undefined;

	const pi = {
		registerCommand(_name: string, command: { handler: typeof handler }) {
			handler = command.handler;
		},
		sendMessage(message: { content: unknown }) {
			output = String(message.content);
		},
		async setModel(model: unknown) {
			selectedModel = model;
			return options.modelAccepted ?? true;
		},
		getThinkingLevel() {
			return options.thinking;
		},
		setThinkingLevel(level: string) {
			selectedThinking = level;
		},
		async exec(command: string, args: string[], execOptions?: { cwd?: string }) {
			execCall = { command, args, cwd: execOptions?.cwd };
			return options.execResult ?? { stdout: "ok\n", stderr: "", code: 0, killed: false };
		},
	} as unknown as ExtensionAPI;

	const model = options.model as any;
	const resolved = options.resolveModel as any;
	const ctx = {
		cwd: "/repo",
		model,
		models: {
			resolve: (spec: string) => (spec === "@slow" ? resolved : undefined),
		},
	} as unknown as ExtensionCommandContext;

	registerExecpolicyCommand(pi, async () => {
		throw new Error("control commands should not load policy state");
	});

	return {
		async run(args: string) {
			if (handler === undefined) throw new Error("command not registered");
			await handler(args, ctx);
			return output;
		},
		get selectedModel() {
			return selectedModel;
		},
		get selectedThinking() {
			return selectedThinking;
		},
		get execCall() {
			return execCall;
		},
	};
}

describe("/execpolicy model", () => {
	it("shows the current model", async () => {
		const h = controlHarness({ model: { provider: "openai", id: "gpt-test" } });
		assert.equal(await h.run("model"), "model: openai/gpt-test");
	});

	it("resolves and switches the live session model", async () => {
		const target = { provider: "anthropic", id: "claude-test" };
		const h = controlHarness({ resolveModel: target });
		assert.equal(await h.run("model @slow"), "model: anthropic/claude-test");
		assert.equal(h.selectedModel, target);
	});

	it("reports an unknown model without changing state", async () => {
		const h = controlHarness();
		assert.equal(await h.run("model missing/model"), "model not found: missing/model");
		assert.equal(h.selectedModel, undefined);
	});
});

describe("/execpolicy thinking", () => {
	it("shows and changes the live thinking level", async () => {
		const h = controlHarness({ thinking: "medium" });
		assert.equal(await h.run("thinking"), "thinking: medium");
		assert.equal(await h.run("thinking xhigh"), "thinking: xhigh");
		assert.equal(h.selectedThinking, "xhigh");
	});

	it("rejects an invalid level", async () => {
		const h = controlHarness();
		assert.match(await h.run("thinking enormous"), /invalid thinking level/);
		assert.equal(h.selectedThinking, undefined);
	});
});

describe("/execpolicy config", () => {
	it("delegates persistent writes to omp config without a shell", async () => {
		const h = controlHarness({ execResult: { stdout: "set\n", stderr: "", code: 0, killed: false } });
		assert.equal(await h.run('config set tools.approval {"bash":"allow", "read":"allow"}'), "set");
		assert.deepEqual(h.execCall, {
			command: "omp",
			args: ["config", "set", "tools.approval", '{"bash":"allow", "read":"allow"}'],
			cwd: "/repo",
		});
	});

	it("surfaces omp config failures", async () => {
		const h = controlHarness({ execResult: { stdout: "", stderr: "Unknown setting: nope\n", code: 1, killed: false } });
		const output = await h.run("config get nope");
		assert.match(output, /exit 1/);
		assert.match(output, /Unknown setting: nope/);
	});
});
