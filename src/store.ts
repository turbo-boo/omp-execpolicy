/**
 * Engine state: settings + parsed rules, cached and invalidated on file change.
 *
 * Reading and parsing rule files on every shell command would be wasteful, but
 * caching them across a session would silently ignore an edit or a "don't ask
 * again" amendment. The cache key is therefore the settings plus each rule
 * file's `mtime`/size, so an edit is picked up on the next command and nothing
 * else pays for the check.
 *
 * This is the only module that reaches into the harness at runtime
 * (`getPluginSettings`), so the judging pipeline below it stays pure.
 */

import * as fs from "node:fs";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { resolveSettings } from "./settings.ts";
import { loadRuleFiles, resolveRuleDirs } from "./rule-files.ts";
import { buildPolicy } from "./policy.ts";
import type { EngineState } from "./state.ts";

export type { EngineState } from "./state.ts";

export interface EngineOptions {
	/** Must match the plugin's package name so persisted settings resolve. */
	pluginName: string;
	/** Harness agent directory (`getAgentDir()`), the root of user-level config. */
	agentDir: string;
}

/**
 * A policy setting is inline text or `@<path>`. Only the path form can change
 * underneath a session, so only it contributes a stat entry to the cache key.
 */
function policyStatKey(policy: string | undefined): string {
	return policy !== undefined && policy.startsWith("@") ? statKey(policy.slice(1)) : "-";
}

function readPolicy(policy: string | undefined): string | undefined {
	if (policy === undefined) return undefined;
	if (!policy.startsWith("@")) return policy;
	try {
		return fs.readFileSync(policy.slice(1), "utf8");
	} catch {
		return undefined;
	}
}

function statKey(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${file}:${stat.mtimeMs}:${stat.size}`;
	} catch {
		return `${file}:-`;
	}
}

export class Engine {
	readonly #options: EngineOptions;
	#key: string | undefined;
	#state: EngineState | undefined;
	#pending: Promise<EngineState> | undefined;

	constructor(options: EngineOptions) {
		this.#options = options;
	}

	/** Invalidate the cache; the next {@link state} call reloads from disk. */
	invalidate(): void {
		this.#key = undefined;
		this.#state = undefined;
	}

	/** Current settings and compiled policy for `cwd`, reloaded when the inputs changed. */
	async state(cwd: string): Promise<EngineState> {
		if (this.#pending !== undefined) return this.#pending;
		const pending = this.#load(cwd);
		this.#pending = pending;
		try {
			return await pending;
		} finally {
			this.#pending = undefined;
		}
	}

	async #load(cwd: string): Promise<EngineState> {
		const settings = resolveSettings(await this.#readSettings(cwd));
		const dirs = resolveRuleDirs(cwd, this.#options.agentDir);
		const resolved = loadRuleFiles(settings, dirs, cwd);
		const key = JSON.stringify([
			settings,
			resolved.files.map(file => statKey(file.path)),
			statKey(settings.amendFile),
			policyStatKey(settings.judgePolicy),
		]);
		if (this.#state !== undefined && this.#key === key) return this.#state;
		const loaded = buildPolicy({ files: resolved.files });
		const judgePolicy = readPolicy(settings.judgePolicy);
		const state: EngineState = { settings, resolved, loaded, policy: loaded.policy, judgePolicy };
		this.#key = key;
		this.#state = state;
		return state;
	}

	async #readSettings(cwd: string): Promise<Record<string, unknown>> {
		try {
			return await getPluginSettings(this.#options.pluginName, cwd);
		} catch {
			// A missing or unreadable plugin lockfile must not disable judging: the
			// environment-variable overrides and the built-in defaults still apply.
			return {};
		}
	}
}
