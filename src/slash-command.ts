/**
 * `/execpolicy` — inspect and configure omp-execpolicy.
 *
 * The command never changes omp's conversation model. Judge/model settings are
 * persisted through omp's plugin-config CLI so they stay independent from
 * `/switch`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { evaluationToJson, type Evaluation } from "./policy.ts";
import { describeRuleReason, evaluateDeterministic, heuristicsFor } from "./gate.ts";
import { renderPattern } from "./rules.ts";
import type { EngineState, LoadState } from "./state.ts";

const OUTPUT_TYPE = "execpolicy";
const PLUGIN_NAME = "omp-execpolicy";

type RuntimeControls = {
	exec?: (
		command: string,
		args: string[],
		options?: { cwd?: string; timeout?: number },
	) => Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
};

const HELP = `Usage: /execpolicy [status|rules|files|check <command>|explain <command>|model [spec]|config <action> ...]

  status                   Settings, rule files, and judge configuration.
  files                    Discovered rule files and parse diagnostics.
  rules [filter]           Compiled prefix rules.
  check <command>          Print the JSON evaluation (Codex-compatible shape).
  explain <command>        Human-readable verdict, deciding layer, and reason.
  model [spec]             Show or set the execpolicy judge model. Does not change /switch.
  config list              List omp-execpolicy plugin settings.
  config get <key>         Read one omp-execpolicy setting.
  config set <key> <value> Persist one omp-execpolicy setting.
  config reset <key>       Delete one persisted setting so its default applies.`;

function renderEvaluation(state: EngineState, command: string): Evaluation {
	return state.policy.check(command, heuristicsFor(state.settings));
}

function formatStatus(state: EngineState): string {
	const { settings, resolved, loaded } = state;
	const lines = [
		"# Execution policy",
		`enabled: ${settings.enabled ? "yes" : "no"}`,
		`rules loaded: ${loaded.policy.ruleCount}`,
		`prompt policy: ${settings.ask === "never" ? "never prompt (prompt verdicts become blocks)" : "ask the user"}`,
		`unmatched commands: ${settings.unmatched ?? "no opinion (allowed)"}`,
		`judge: ${settings.judge ? "on" : "off"}`,
		`judge model setting: ${settings.judgeModel}`,
		`judge timeout: ${settings.judgeTimeoutMs}ms`,
		`judge retries: ${settings.judgeRetries}`,
		`judge on error: ${settings.judgeOnError}`,
		`rule amendment: ${settings.amendRules ? settings.amendFile : "off"}`,
		"",
		"## Rule files (low → high precedence)",
	];
	if (resolved.files.length === 0) {
		lines.push("(none found)");
	} else {
		for (const file of resolved.files) {
			lines.push(`- ${file.path} (${loaded.counts[file.path] ?? 0} rules)`);
		}
	}
	const searched = resolved.searchedDirs.length === 0 ? "(none)" : resolved.searchedDirs.join(", ");
	lines.push("", `searched: ${searched}`);
	return lines.join("\n");
}

function formatFiles(state: EngineState): string {
	const lines = ["# Execution policy rule files", ""];
	if (state.resolved.files.length === 0) lines.push("(none found)");
	for (const file of state.resolved.files) lines.push(`- ${file.path}`);
	if (state.loaded.diagnostics.length > 0) {
		lines.push("", "## Diagnostics");
		for (const diagnostic of state.loaded.diagnostics) {
			lines.push(`- ${diagnostic.file}:${diagnostic.line} [${diagnostic.severity}] ${diagnostic.message}`);
		}
	} else {
		lines.push("", "No parse diagnostics.");
	}
	return lines.join("\n");
}

function formatRules(state: EngineState, filter: string | undefined): string {
	const rules = state.policy.rules().filter(rule => {
		if (filter === undefined || filter.trim().length === 0) return true;
		const haystack = `${renderPattern(rule.pattern)} ${rule.justification ?? ""}`;
		return haystack.toLowerCase().includes(filter.trim().toLowerCase());
	});
	if (rules.length === 0) return "# No rules matched.";
	const lines = ["# Prefix rules", ""];
	for (const rule of rules) {
		const justification = rule.justification === undefined ? "" : ` — ${rule.justification}`;
		lines.push(`- [${rule.decision}] ${renderPattern(rule.pattern)}${justification}`);
		lines.push(`  ${rule.file}:${rule.line}`);
	}
	return lines.join("\n");
}

function formatCheck(state: EngineState, command: string): string {
	const evaluation = renderEvaluation(state, command);
	return JSON.stringify(evaluationToJson(evaluation), null, 2);
}

function formatExplain(state: EngineState, command: string): string {
	const { evaluation, verdict } = evaluateDeterministic(state.policy, command, state.settings);
	const lines = [
		`command: ${command}`,
		`decision: ${verdict.decision ?? "(no opinion — allowed)"}`,
		`deciding layer: ${verdict.source}`,
	];
	if (verdict.reason !== undefined) lines.push(`reason: ${verdict.reason}`);
	const judged = evaluation.segments;
	if (judged.length > 1 || judged.some(segment => segment.argv.join(" ") !== segment.text)) {
		lines.push("", "evaluated segments:");
		for (const segment of judged) {
			const argv = segment.argv.join(" ");
			const note = segment.unresolved
				? " [not analysable: depth cap]"
				: argv !== segment.text
					? ` → ${argv}`
					: "";
			lines.push(`- ${segment.text}${note}`);
		}
	}
	if (evaluation.matchedRules.length > 0) {
		lines.push("", "matched rules:");
		for (const match of evaluation.matchedRules) {
			lines.push(
				match.kind === "prefix_rule"
					? `- [${match.decision}] prefix ${match.pattern} (${match.source.file}:${match.source.line})`
					: `- [${match.decision}] heuristics: ${match.command}`,
			);
		}
	}
	if (verdict.decision === "allow" && verdict.source === "rule") {
		lines.push("", `allow reason: ${describeRuleReason(evaluation, "allow")}`);
	}
	return lines.join("\n");
}

function splitHead(input: string): [string, string] {
	const trimmed = input.trim();
	if (trimmed.length === 0) return ["", ""];
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	return [match?.[1] ?? "", match?.[2]?.trim() ?? ""];
}

function formatResolvedJudgeModel(ctx: ExtensionCommandContext, selector: string): string {
	const model = ctx.models.resolve(selector);
	return model === undefined ? "(unresolved)" : `${model.provider}/${model.id}`;
}

async function runPluginConfig(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	args: string[],
): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
	const runtime = pi as unknown as RuntimeControls;
	if (typeof runtime.exec !== "function") {
		return { ok: false, output: "omp plugin config is not supported by this omp runtime" };
	}
	const result = await runtime.exec("omp", ["plugin", "config", ...args], { cwd: ctx.cwd, timeout: 30_000 });
	const stdout = result.stdout.trim();
	const stderr = result.stderr.trim();
	if (result.code !== 0) {
		return {
			ok: false,
			output: [`omp plugin config failed (exit ${result.code})`, stderr || stdout || "(no output)"].join("\n"),
		};
	}
	return { ok: true, output: stdout || stderr || "ok" };
}

async function handleJudgeModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	loadState: LoadState,
	spec: string,
): Promise<string> {
	if (spec.length === 0) {
		const state = await loadState(ctx.cwd);
		return [
			"# Execpolicy judge model",
			`setting: ${state.settings.judgeModel}`,
			`resolved: ${formatResolvedJudgeModel(ctx, state.settings.judgeModel)}`,
			"OMP /switch does not change this setting.",
		].join("\n");
	}

	const requested = ctx.models.resolve(spec);
	if (requested === undefined) {
		return `judge model not found: ${spec}\nNo execpolicy setting was changed.`;
	}

	const saved = await runPluginConfig(pi, ctx, ["set", PLUGIN_NAME, "judgeModel", spec]);
	if (!saved.ok) return saved.output;

	const state = await loadState(ctx.cwd);
	const effective = state.settings.judgeModel;
	const lines = [
		"# Execpolicy judge model updated",
		`setting: ${effective}`,
		`resolved: ${formatResolvedJudgeModel(ctx, effective)}`,
		"OMP /switch does not change this setting.",
	];
	if (effective !== spec) {
		lines.push(`saved value: ${spec}`, "A higher-precedence override is controlling the effective judge model.");
	}
	return lines.join("\n");
}

async function handleConfig(pi: ExtensionAPI, ctx: ExtensionCommandContext, args: string): Promise<string> {
	const [action, rest] = splitHead(args);
	let commandArgs: string[];

	switch (action) {
		case "list":
			if (rest.length > 0 && rest !== "--json") return "Usage: /execpolicy config list [--json]";
			commandArgs = ["list", PLUGIN_NAME, ...(rest === "--json" ? ["--json"] : [])];
			break;
		case "get": {
			const [key, extra] = splitHead(rest);
			if (key.length === 0 || (extra.length > 0 && extra !== "--json")) {
				return "Usage: /execpolicy config get <key> [--json]";
			}
			commandArgs = ["get", PLUGIN_NAME, key, ...(extra === "--json" ? ["--json"] : [])];
			break;
		}
		case "set": {
			const [key, value] = splitHead(rest);
			if (key.length === 0 || value.length === 0) return "Usage: /execpolicy config set <key> <value>";
			commandArgs = ["set", PLUGIN_NAME, key, value];
			break;
		}
		case "reset":
		case "delete": {
			const [key, extra] = splitHead(rest);
			if (key.length === 0 || extra.length > 0) return "Usage: /execpolicy config reset <key>";
			commandArgs = ["delete", PLUGIN_NAME, key];
			break;
		}
		default:
			return "Usage: /execpolicy config [list|get <key>|set <key> <value>|reset <key>]";
	}

	const result = await runPluginConfig(pi, ctx, commandArgs);
	return result.output;
}

export function registerExecpolicyCommand(pi: ExtensionAPI, loadState: LoadState): void {
	pi.registerCommand("execpolicy", {
		description: "Inspect and configure shell execution policy",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const trimmed = args.trim();
			const [subcommandRaw, rest] = splitHead(trimmed);
			const subcommand = subcommandRaw || "status";
			let output: string;

			switch (subcommand) {
				case "model":
				case "judge-model":
					output = await handleJudgeModel(pi, ctx, loadState, rest);
					break;
				case "config":
					output = await handleConfig(pi, ctx, rest);
					break;
				case "status":
				case "files":
				case "rules":
				case "check":
				case "explain":
				case "why":
				case "help": {
					const state = await loadState(ctx.cwd);
					switch (subcommand) {
						case "status":
							output = formatStatus(state);
							break;
						case "files":
							output = formatFiles(state);
							break;
						case "rules":
							output = formatRules(state, rest.length === 0 ? undefined : rest);
							break;
						case "check":
							output = rest.length === 0 ? HELP : formatCheck(state, rest);
							break;
						case "explain":
						case "why":
							output = rest.length === 0 ? HELP : formatExplain(state, rest);
							break;
						case "help":
							output = HELP;
							break;
						default:
							output = HELP;
					}
					break;
				}
				default:
					output = `Unknown subcommand ${JSON.stringify(subcommand)}.\n\n${HELP}`;
			}

			pi.sendMessage({ customType: OUTPUT_TYPE, content: output, display: true });
		},
	});
}
