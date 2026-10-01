/**
 * Plugin settings.
 *
 * Values come from the plugin's persisted settings (visible in
 * `/settings` → Plugins) with environment-variable overrides so the plugin is
 * configurable in a headless run without touching the lockfile.
 *
 * Kept free of harness imports so the judging pipeline stays unit-testable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Directory inside a config dir that holds `*.rules` files. */
const RULES_DIR_NAME = "rules";

export interface PluginSettings {
	/** Master switch. Disabled = the extension loads but never judges. */
	enabled: boolean;
	/** When the gate may prompt: "always" or "never" (rules decide alone). */
	ask: "always" | "never";
	/**
	 * Verdict applied to commands no rule matched; `undefined` leaves them
	 * undecided so the harness's own approval gate owns them.
	 */
	unmatched: "allow" | "prompt" | undefined;
	/** Consult the model judge for commands that need approval. */
	judge: boolean;
	/** Model spec for the judge (`provider/id`, bare id, or `@slow` role alias). */
	judgeModel: string;
	/** Per-command timeout for the judge, in milliseconds. */
	judgeTimeoutMs: number;
	/** Number of extra attempts after an empty or malformed judge response. */
	judgeRetries: number;
	/** What to do when the judge cannot produce a verdict: ask the user, or allow. */
	judgeOnError: "ask" | "allow";
	/** Security policy text handed to the judge; replaces the bundled default. */
	judgePolicy: string | undefined;
	/** Skip judging a command whose verdict is already decided by a rule. */
	extraRuleFiles: string[];
	/** Write an `allow` prefix rule when the user approves a command with "always". */
	amendRules: boolean;
	/** Rule file amendments are appended to. */
	amendFile: string;
}

const DEFAULTS: PluginSettings = {
	enabled: true,
	ask: "always",
	unmatched: "prompt",
	judge: true,
	judgeModel: "@smol",
	judgeTimeoutMs: 15_000,
	judgeRetries: 1,
	judgeOnError: "ask",
	judgePolicy: undefined,
	extraRuleFiles: [],
	amendRules: false,
	amendFile: "",
};

function asBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value === "true" || value === "1") return true;
		if (value === "false" || value === "0") return false;
	}
	return fallback;
}

function asStringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
	if (typeof value === "string" && value.length > 0) return [value];
	return undefined;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

/**
 * A security policy is either the text itself or a path to a markdown file.
 * Reading is deferred to the engine so a changed file invalidates the cache the
 * same way a changed rule file does.
 */
function asPolicyText(envValue: unknown, storedValue: unknown): string | undefined {
	const direct = asStringList(envValue)?.[0];
	if (direct !== undefined && direct.length > 0) return direct.includes("\n") ? direct : `@${expandHome(direct)}`;
	const stored = typeof storedValue === "string" && storedValue.length > 0 ? storedValue : undefined;
	if (stored === undefined) return undefined;
	return stored.includes("\n") ? stored : `@${expandHome(stored)}`;
}

/**
 * The `unmatched` setting, where `"none"` is the explicit spelling of "no
 * opinion" (`undefined`). It must be distinguishable from *unset*: unset now
 * falls through to the shipped `prompt` default, while `"none"` opts out of it.
 */
function asUnmatched(value: unknown, fallback: PluginSettings["unmatched"]): PluginSettings["unmatched"] {
	if (value === "none") return undefined;
	return asEnum(value, ["allow", "prompt"] as const) ?? fallback;
}

function asNumber(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

function asNonNegativeInteger(value: unknown, fallback: number, max = Number.POSITIVE_INFINITY): number {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? Math.min(max, Math.floor(parsed)) : fallback;
}

function expandHome(target: string): string {
	if (target === "~") return os.homedir();
	if (target.startsWith("~/")) return path.join(os.homedir(), target.slice(2));
	return target;
}

/** Default user config dir omp uses for rules and settings. */
function userConfigDir(): string {
	return path.join(os.homedir(), ".omp", "agent");
}

/**
 * Resolve effective settings for the plugin instance.
 *
 * `persisted` is the plugin's stored settings map (global merged with project
 * overrides). Environment variables win over persisted values so the plugin is
 * configurable in a headless run without touching the lockfile.
 */
export function resolveSettings(persisted: Record<string, unknown> | undefined): PluginSettings {
	const stored = persisted ?? {};
	const env = process.env;
	const settings: PluginSettings = {
		enabled: asBoolean(env.OMP_EXECPOLICY_ENABLED, asBoolean(stored.enabled, DEFAULTS.enabled)),
		ask: asEnum(env.OMP_EXECPOLICY_ASK, ["always", "never"] as const) ?? asEnum(stored.ask, ["always", "never"] as const) ?? DEFAULTS.ask,
		unmatched: asUnmatched(env.OMP_EXECPOLICY_UNMATCHED, asUnmatched(stored.unmatched, DEFAULTS.unmatched)),
		judge: asBoolean(env.OMP_EXECPOLICY_JUDGE, asBoolean(stored.judge, DEFAULTS.judge)),
		judgeModel:
			(typeof env.OMP_EXECPOLICY_JUDGE_MODEL === "string" && env.OMP_EXECPOLICY_JUDGE_MODEL.length > 0
				? env.OMP_EXECPOLICY_JUDGE_MODEL
				: undefined) ??
			(typeof stored.judgeModel === "string" && stored.judgeModel.length > 0 ? stored.judgeModel : undefined) ??
			DEFAULTS.judgeModel,
		judgeTimeoutMs: asNumber(env.OMP_EXECPOLICY_JUDGE_TIMEOUT_MS ?? stored.judgeTimeoutMs, DEFAULTS.judgeTimeoutMs),
		judgeRetries: asNonNegativeInteger(
			env.OMP_EXECPOLICY_JUDGE_RETRIES ?? stored.judgeRetries,
			DEFAULTS.judgeRetries,
			3,
		),
		judgeOnError:
			asEnum(env.OMP_EXECPOLICY_JUDGE_ON_ERROR, ["ask", "allow"] as const) ??
			asEnum(stored.judgeOnError, ["ask", "allow"] as const) ??
			DEFAULTS.judgeOnError,
		judgePolicy: asPolicyText(env.OMP_EXECPOLICY_POLICY, stored.judgePolicy) ?? DEFAULTS.judgePolicy,
		extraRuleFiles: asStringList(env.OMP_EXECPOLICY_RULES ?? stored.extraRuleFiles)?.map(expandHome) ?? DEFAULTS.extraRuleFiles,
		amendRules: asBoolean(env.OMP_EXECPOLICY_AMEND, asBoolean(stored.amendRules, DEFAULTS.amendRules)),
		amendFile: expandHome(
			(typeof env.OMP_EXECPOLICY_AMEND_FILE === "string" && env.OMP_EXECPOLICY_AMEND_FILE.length > 0
				? env.OMP_EXECPOLICY_AMEND_FILE
				: undefined) ??
				(typeof stored.amendFile === "string" && stored.amendFile.length > 0 ? stored.amendFile : undefined) ??
				path.join(userConfigDir(), RULES_DIR_NAME, "default.rules"),
		),
	};
	return settings;
}
