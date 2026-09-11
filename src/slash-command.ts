/**
 * `/execpolicy` — inspect the engine without running a command.
 *
 * Mirrors `codex execpolicy check`: `check` prints the JSON evaluation
 * (`{ matchedRules, decision }`) so scripts and humans can see exactly why a
 * command would be allowed, prompted, or blocked.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { evaluationToJson, type Evaluation } from "./policy.ts";
import { describeRuleReason, evaluateDeterministic, heuristicsFor } from "./gate.ts";
import { renderPattern } from "./rules.ts";
import type { EngineState, LoadState } from "./state.ts";

const OUTPUT_TYPE = "execpolicy";

const HELP = `Usage: /execpolicy [status|rules|files|check <command>|explain <command>]

  status            Settings, rule files, and judge configuration.
  files             Discovered rule files and parse diagnostics.
  rules [filter]    Compiled prefix rules.
  check <command>   Print the JSON evaluation (Codex-compatible shape).
  explain <command> Human-readable verdict, deciding layer, and reason.`;

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
		`judge: ${settings.judge ? `${settings.judgeModel} (timeout ${settings.judgeTimeoutMs}ms, on error: ${settings.judgeOnError})` : "off"}`,
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
	// The section earns its space only when what we judged differs from what the
	// user wrote: a compound line (several segments) or an unwrapped/nested
	// program (`sudo rm …` judged as `rm …`).
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

export function registerExecpolicyCommand(pi: ExtensionAPI, loadState: LoadState): void {
	pi.registerCommand("execpolicy", {
		description: "Inspect the shell-command execution policy (rules, verdicts, diagnostics)",
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const state = await loadState(ctx.cwd);
			const trimmed = args.trim();
			const spaceIndex = trimmed.indexOf(" ");
			const subcommand = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)) || "status";
			const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
			let output: string;
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
					output = `Unknown subcommand ${JSON.stringify(subcommand)}.\n\n${HELP}`;
			}
			pi.sendMessage({ customType: OUTPUT_TYPE, content: output, display: true });
		},
	});
}
