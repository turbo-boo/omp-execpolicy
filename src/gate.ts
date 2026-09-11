/**
 * The verdict pipeline.
 *
 * Mirrors Codex's `create_exec_approval_requirement` layering:
 *
 *   1. rules decide → `allow` | `prompt` | `forbidden`
 *   2. no rule matched → dangerous-command heuristics decide (`prompt`, or
 *      `forbidden` when prompting is impossible)
 *   3. still nothing → the configured `unmatched` verdict
 *   4. still nothing → the model judge (when enabled)
 *
 * Pure functions only: the caller owns the UI, the judge call, and rule
 * amendments, so this logic stays testable without a session.
 */

import { dangerousCommandMatch, describeDangerousMatch } from "./dangerous.ts";
import type { Decision } from "./decision.ts";
import type { Evaluation, HeuristicsFallback, Policy, RuleMatch } from "./policy.ts";
import type { PluginSettings } from "./settings.ts";

export type VerdictSource = "rule" | "heuristics" | "unmatched" | "judge" | "none";

export interface DeterministicVerdict {
	/** `undefined` means no deterministic layer had an opinion. */
	decision: Decision | undefined;
	source: VerdictSource;
	/** Human-readable justification assembled from the deciding layer. */
	reason?: string;
	/** Matches that produced a `forbidden` verdict, for the block message. */
	blocking: RuleMatch[];
}

/**
 * Prefixes that must never be written as a blanket `allow` amendment: approving
 * one of these approves an unbounded class of commands (bare `git`, bare
 * `python`, any interpreter body) rather than the command the user just read.
 * Ported verbatim from Codex's `BANNED_PREFIX_SUGGESTIONS`.
 */
const BANNED_AMENDMENT_PREFIXES: string[][] = [
	["/bin/bash"],
	["/bin/bash", "-c"],
	["/bin/bash", "-lc"],
	["/bin/sh"],
	["/bin/sh", "-c"],
	["/bin/sh", "-lc"],
	["/bin/zsh"],
	["/bin/zsh", "-c"],
	["/bin/zsh", "-lc"],
	["Rscript"],
	["bash"],
	["bash", "-c"],
	["bash", "-lc"],
	["bun"],
	["bun", "-e"],
	["bun", "run"],
	["cmd"],
	["cmd", "/c"],
	["cmd", "/k"],
	["cmd.exe"],
	["cmd.exe", "/c"],
	["cmd.exe", "/k"],
	["dash"],
	["dash", "-c"],
	["deno"],
	["deno", "eval"],
	["env"],
	["fish"],
	["fish", "-c"],
	["git"],
	["julia"],
	["julia", "-e"],
	["ksh"],
	["ksh", "-c"],
	["lua"],
	["lua", "-e"],
	["node"],
	["node", "-e"],
	["nodejs"],
	["nodejs", "-e"],
	["npm", "run"],
	["osascript"],
	["perl"],
	["perl", "-e"],
	["php"],
	["php", "-r"],
	["pnpm", "run"],
	["powershell"],
	["powershell", "-Command"],
	["powershell", "-EncodedCommand"],
	["powershell", "-File"],
	["powershell", "-c"],
	["powershell.exe"],
	["powershell.exe", "-Command"],
	["powershell.exe", "-EncodedCommand"],
	["powershell.exe", "-File"],
	["powershell.exe", "-c"],
	["pwsh"],
	["pwsh", "-Command"],
	["pwsh", "-EncodedCommand"],
	["pwsh", "-File"],
	["pwsh", "-c"],
	["pwsh", "-e"],
	["pwsh", "-ec"],
	["pwsh", "-f"],
	["py"],
	["py", "-3"],
	["pypy"],
	["pypy3"],
	["python"],
	["python", "-"],
	["python", "-c"],
	["python3"],
	["python3", "-"],
	["python3", "-c"],
	["pythonw"],
	["pyw"],
	["rm"],
	["ruby"],
	["ruby", "-e"],
	["sh"],
	["sh", "-c"],
	["sh", "-lc"],
	["sudo"],
	["yarn", "run"],
	["zsh"],
	["zsh", "-c"],
	["zsh", "-lc"],
];

export function heuristicsFor(settings: PluginSettings): HeuristicsFallback {
	return (argv, command) => {
		const match = dangerousCommandMatch(argv);
		if (match === undefined) return undefined;
		// Codex: a dangerous command is forbidden when the policy forbids
		// prompting at all, otherwise it prompts.
		return {
			decision: settings.ask === "never" ? "forbidden" : "prompt",
			justification: `Dangerous command (${describeDangerousMatch(match)}): ${command}`,
		};
	};
}

/** Run the deterministic layers of the pipeline. */
export function evaluateDeterministic(
	policy: Policy,
	command: string,
	settings: PluginSettings,
): { evaluation: Evaluation; verdict: DeterministicVerdict } {
	const evaluation = policy.check(command, heuristicsFor(settings));
	if (evaluation.decision === "forbidden") {
		return {
			evaluation,
			verdict: {
				decision: "forbidden",
				source: "rule",
				reason: describeRuleReason(evaluation, "forbidden"),
				blocking: evaluation.matchedRules.filter(match => match.decision === "forbidden"),
			},
		};
	}
	if (evaluation.decision === "prompt") {
		return {
			evaluation,
			verdict: {
				decision: "prompt",
				source: hasRuleMatch(evaluation) ? "rule" : "heuristics",
				reason: describeRuleReason(evaluation, "prompt"),
				blocking: [],
			},
		};
	}
	if (evaluation.decision === "allow") {
		return {
			evaluation,
			verdict: {
				decision: "allow",
				source: hasRuleMatch(evaluation) ? "rule" : "heuristics",
				reason: describeRuleReason(evaluation, "allow"),
				blocking: [],
			},
		};
	}
	if (settings.unmatched !== undefined) {
		return {
			evaluation,
			verdict: {
				decision: settings.unmatched,
				source: "unmatched",
				reason:
					settings.unmatched === "prompt"
						? "No execution-policy rule matched this command."
						: "No execution-policy rule matched this command; unmatched commands are allowed.",
				blocking: [],
			},
		};
	}
	return { evaluation, verdict: { decision: undefined, source: "none", blocking: [] } };
}

function hasRuleMatch(evaluation: Evaluation): boolean {
	return evaluation.matchedRules.some(match => match.kind === "prefix_rule");
}

/** Justification text for a decision, preferring the specific rule that drove it. */
export function describeRuleReason(evaluation: Evaluation, decision: Decision): string {
	const parts: string[] = [];
	for (const match of evaluation.matchedRules) {
		if (match.decision !== decision) continue;
		if (match.kind === "prefix_rule") {
			const source = `${match.source.file}:${match.source.line}`;
			const label =
				match.justification !== undefined && match.justification.length > 0
					? match.justification
					: `prefix rule: ${match.pattern}`;
			parts.push(`${label} [${source}]`);
		} else if (match.justification !== undefined && match.justification.length > 0) {
			parts.push(match.justification);
		}
	}
	if (parts.length === 0) return "No execution-policy rule matched this command.";
	return [...new Set(parts)].join("; ");
}

/**
 * What the gate does with a verdict.
 *
 * `review` is the composition Codex uses for auto-review: a verdict that needs
 * approval is handed to the model reviewer *instead of* the user prompt, so the
 * reviewer stands in for the approval rather than sitting behind it. Reading the
 * reviewer as "only for commands no rule decided" would make it unreachable
 * whenever `unmatched` is set — the reviewer would never see a `prompt` verdict.
 */
export type GateStep = "run" | "block" | "review" | "ask" | "pass";

export function planGate(verdict: DeterministicVerdict, settings: PluginSettings): GateStep {
	// Forbidden is final: no rule, heuristic, or reviewer can lift it.
	if (verdict.decision === "forbidden") return "block";
	// Allowed needs no approval, so there is nothing to review.
	if (verdict.decision === "allow") return "run";
	// Who answers a `prompt` verdict is the Codex scope toggle, not a rule-level
	// choice: Codex gives each approval *category* (`GuardianScope::Shell`,
	// `FileChanges`, `Mcp`, …) a `GuardianReviewMode`, and an omitted category is
	// `Disabled` — the user answers. This plugin's only category is `Shell`, so
	// `judge` is that same toggle: on = `Synchronous`, off = `Disabled`.
	//
	// Codex offers nothing finer. A rule there cannot say "ask the user"; the
	// closest is `Granular { rules: false }`, which turns a rule's prompt into a
	// *block*. Deliberately not modeled here — a block is not a question, and
	// inventing a fourth verdict would put this plugin off Codex's vocabulary.
	if (settings.judge) return "review";
	// Without a reviewer a `prompt` verdict is the user's to answer; no verdict at
	// all means the harness's own approval gate is the only gate.
	return verdict.decision === "prompt" ? "ask" : "pass";
}

export function formatBlockReason(verdict: DeterministicVerdict): string {
	if (verdict.decision === "forbidden") {
		return `Blocked by execution policy.\n${verdict.reason ?? ""}`.trimEnd();
	}
	return "Blocked by execution policy.";
}

export interface PromptBody {
	title: string;
	body: string;
}

/**
 * Build the approval dialog copy for a `prompt` verdict, following Codex's
 * exec-approval layout: the title asks the question, then `Reason:` names the
 * deciding rule, then the command itself on a `$ ` line.
 */
export function formatPrompt(command: string, verdict: DeterministicVerdict): PromptBody {
	const lines: string[] = [];
	if (verdict.reason !== undefined && verdict.reason.length > 0) {
		lines.push(`Reason: ${verdict.reason}`, "");
	}
	lines.push(`$ ${command}`);
	return { title: "Would you like to run the following command?", body: lines.join("\n") };
}

/**
 * The prefix amending would record, or `undefined` when the amendment is
 * unsafe or would not actually approve the command.
 *
 * Codex refuses an amendment that does not make the whole command allowed —
 * approving `prog1` while a later segment of the same line still prompts would
 * record consent the user did not give. Prefixes that would approve an
 * unbounded command class (`git`, `bash -c`, `sudo`) are refused for the same
 * reason: the user read one command, not every command that starts that way.
 */
export function planAmendment(
	policy: Policy,
	evaluation: Evaluation,
	settings: PluginSettings,
	source: VerdictSource,
): string[] | undefined {
	const argv = amendmentPrefix(evaluation, source);
	if (argv === undefined || argv.length === 0) return undefined;
	// Codex drops the prefix option when the rendered prefix spans lines: the
	// approval label would be unreadable, and a multi-line "prefix" is not the
	// single command the user just read.
	if (argv.some(token => /[\n\r]/.test(token))) return undefined;
	if (
		BANNED_AMENDMENT_PREFIXES.some(
			banned => banned.length === argv.length && banned.every((token, index) => token === argv[index]),
		)
	) {
		return undefined;
	}
	const amended = policy.withPrefixRule(argv, "allow", "Approved by the user from the execution-policy prompt.");
	// The amendment must leave the whole line runnable. "Runnable" means no other
	// segment still prompts or blocks — not that every segment matches a rule:
	// `rm -rf build && echo done` is fine to remember, while
	// `rm -rf a && rm -rf b` is not, because the second half would still prompt.
	// Codex frames this as every parsed command becoming `Allow`; the only
	// difference here is that an unmatched command is reported as "no opinion"
	// rather than being coerced to `allow`.
	const heuristics = heuristicsFor(settings);
	const stillDecides = evaluation.segments.some(segment => {
		const decision = amended.check(segment.text, heuristics).decision;
		return decision === "prompt" || decision === "forbidden";
	});
	return stillDecides ? undefined : argv;
}

/**
 * The argv the user just read and is being asked to trust. For a dangerous
 * command that is the flagged segment; for an unmatched command it is the
 * first segment the policy did not already allow.
 */
function amendmentPrefix(evaluation: Evaluation, source: VerdictSource): string[] | undefined {
	if (source === "heuristics") {
		const prompting = evaluation.matchedRules.find(
			(match): match is Extract<RuleMatch, { kind: "heuristics" }> =>
				match.kind === "heuristics" && match.decision === "prompt",
		);
		if (prompting === undefined) return undefined;
		const flagged = evaluation.segments.find(segment => segment.text === prompting.command);
		if (flagged !== undefined) return flagged.argv;
		const argv = prompting.command.split(" ").filter(Boolean);
		return argv.length > 0 ? argv : undefined;
	}
	for (const segment of evaluation.segments) {
		if (!allowedByRule(evaluation, segment.text)) return segment.argv;
	}
	return undefined;
}

function allowedByRule(evaluation: Evaluation, text: string): boolean {
	return evaluation.matchedRules.some(
		match => match.kind === "prefix_rule" && match.decision === "allow" && match.command === text,
	);
}
