/**
 * Compiled execution policy: the rule index plus the evaluation Codex's
 * `codex-execpolicy check` performs.
 *
 * Matching order mirrors upstream: exact first-token rules win; only when no
 * rule matches does basename fallback run for an absolute program path; only
 * when that also finds nothing does a heuristics fallback apply. The returned
 * decision is the strictest verdict across every match, and every segment of a
 * compound command is evaluated before aggregation.
 */

import {
	analyzeCommand,
	basenameOfProgram,
	isAbsoluteProgram,
	type CommandAnalysis,
	type CommandSegment,
} from "./command.ts";
import { DECISION_RANK, strictestDecision, type Decision } from "./decision.ts";
import {
	parseRuleFile,
	renderPattern,
	type Diagnostic,
	type HostExecutableSpec,
	type ParsedRuleFile,
	type PatternToken,
	type PrefixRuleSpec,
} from "./rules.ts";

export interface PrefixRuleMatch {
	kind: "prefix_rule";
	/** The pattern that matched, rendered as `git reset [--hard|--soft]`. */
	pattern: string;
	/** The exact command tokens the pattern consumed. */
	matchedPrefix: string[];
	decision: Decision;
	/** Absolute program path, set only when basename fallback matched it. */
	resolvedProgram?: string;
	justification?: string;
	/** Command text this match came from. */
	command: string;
	source: { file: string; line: number };
}

export interface HeuristicsRuleMatch {
	kind: "heuristics";
	command: string;
	decision: Decision;
	justification?: string;
}

export type RuleMatch = PrefixRuleMatch | HeuristicsRuleMatch;

export interface Evaluation {
	/** Strictest decision across all matches, or `undefined` when nothing matched. */
	decision?: Decision;
	matchedRules: RuleMatch[];
	/** Every literal segment the command was decomposed into, with the argv judged. */
	segments: CommandSegment[];
	writeTargets: string[];
}

export interface LoadedPolicy {
	policy: Policy;
	diagnostics: Diagnostic[];
	files: string[];
	/** Rules contributed by each file, keyed by path. */
	counts: Record<string, number>;
}

/** Fallback verdict for a segment no rule matched; `undefined` = no opinion. */
export type HeuristicsFallback = (
	argv: string[],
	command: string,
) => { decision: Decision; justification?: string } | undefined;

function patternMatches(pattern: PatternToken[], argv: string[]): string[] | undefined {
	if (argv.length < pattern.length) return undefined;
	for (let index = 0; index < pattern.length; index++) {
		const token = pattern[index]!;
		const value = argv[index]!;
		if (token.kind === "single") {
			if (token.value !== value) return undefined;
		} else if (!token.values.includes(value)) return undefined;
	}
	return argv.slice(0, pattern.length);
}

export class Policy {
	readonly #rulesByProgram: Map<string, PrefixRuleSpec[]>;
	readonly #hostExecutables: Map<string, string[]>;

	private constructor(rulesByProgram: Map<string, PrefixRuleSpec[]>, hostExecutables: Map<string, string[]>) {
		this.#rulesByProgram = rulesByProgram;
		this.#hostExecutables = hostExecutables;
	}

	static empty(): Policy {
		return new Policy(new Map(), new Map());
	}

	static fromRuleFiles(files: ParsedRuleFile[]): Policy {
		const rulesByProgram = new Map<string, PrefixRuleSpec[]>();
		const hostExecutables = new Map<string, string[]>();
		for (const file of files) {
			for (const rule of file.rules) {
				const [first, ...rest] = rule.pattern;
				if (first === undefined) continue;
				// `prefix_rule(pattern=[["git", "jj"], ...])` registers one rule per
				// first-token alternative, exactly like upstream's pattern split.
				const heads = first.kind === "single" ? [first.value] : first.values;
				for (const head of heads) {
					const variant: PrefixRuleSpec =
						first.kind === "single"
							? rule
							: { ...rule, pattern: [{ kind: "single", value: head }, ...rest] };
					const list = rulesByProgram.get(head);
					if (list === undefined) rulesByProgram.set(head, [variant]);
					else list.push(variant);
				}
			}
			for (const entry of file.hostExecutables) {
				hostExecutables.set(entry.name, entry.paths ?? []);
			}
		}
		return new Policy(rulesByProgram, hostExecutables);
	}

	/** Merge `overlay` on top of this policy; later rules are appended, never replace. */
	mergeOverlay(overlay: ParsedRuleFile[]): Policy {
		const merged = Policy.fromRuleFiles(overlay);
		const rulesByProgram = new Map(this.#rulesByProgram);
		for (const [program, rules] of merged.#rulesByProgram) {
			const existing = rulesByProgram.get(program);
			rulesByProgram.set(program, existing === undefined ? [...rules] : [...existing, ...rules]);
		}
		const hostExecutables = new Map(this.#hostExecutables);
		for (const [name, paths] of merged.#hostExecutables) {
			if (paths.length > 0) hostExecutables.set(name, paths);
		}
		return new Policy(rulesByProgram, hostExecutables);
	}

	get ruleCount(): number {
		let count = 0;
		for (const rules of this.#rulesByProgram.values()) count += rules.length;
		return count;
	}

	/** Every rule currently registered, in registration order. */
	rules(): PrefixRuleSpec[] {
		const all: PrefixRuleSpec[] = [];
		for (const rules of this.#rulesByProgram.values()) all.push(...rules);
		return all;
	}

	hostExecutable(name: string): string[] | undefined {
		return this.#hostExecutables.get(name);
	}

	/**
	 * Return a copy with an `allow` prefix rule for `argv` appended — the
	 * "don't ask again for commands that start with …" amendment.
	 */
	withPrefixRule(argv: string[], decision: Decision, justification?: string): Policy {
		if (argv.length === 0) return this;
		const rule: PrefixRuleSpec = {
			pattern: argv.map(value => ({ kind: "single", value })),
			decision,
			match: [],
			notMatch: [],
			file: "<amendment>",
			line: 0,
		};
		if (justification !== undefined) rule.justification = justification;
		const rulesByProgram = new Map(this.#rulesByProgram);
		const existing = rulesByProgram.get(argv[0]!);
		rulesByProgram.set(argv[0]!, existing === undefined ? [rule] : [...existing, rule]);
		return new Policy(rulesByProgram, new Map(this.#hostExecutables));
	}

	#matchExact(argv: string[], command: string): RuleMatch[] {
		const rules = this.#rulesByProgram.get(argv[0]!);
		if (rules === undefined || rules.length === 0) return [];
		const matches: RuleMatch[] = [];
		for (const rule of rules) {
			const matchedPrefix = patternMatches(rule.pattern, argv);
			if (matchedPrefix === undefined) continue;
			const match: PrefixRuleMatch = {
				kind: "prefix_rule",
				pattern: renderPattern(rule.pattern),
				matchedPrefix,
				decision: rule.decision,
				command,
				source: { file: rule.file, line: rule.line },
			};
			if (rule.justification !== undefined) match.justification = rule.justification;
			matches.push(match);
		}
		return matches;
	}

	#matchHostExecutable(argv: string[], command: string): RuleMatch[] {
		const program = argv[0]!;
		if (!isAbsoluteProgram(program)) return [];
		const basename = basenameOfProgram(program);
		const rules = this.#rulesByProgram.get(basename);
		if (rules === undefined || rules.length === 0) return [];
		const allowed = this.#hostExecutables.get(basename);
		if (allowed !== undefined && !allowed.includes(program)) return [];
		const rewritten = [basename, ...argv.slice(1)];
		const matches: RuleMatch[] = [];
		for (const rule of rules) {
			const matchedPrefix = patternMatches(rule.pattern, rewritten);
			if (matchedPrefix === undefined) continue;
			const match: PrefixRuleMatch = {
				kind: "prefix_rule",
				pattern: renderPattern(rule.pattern),
				matchedPrefix,
				decision: rule.decision,
				resolvedProgram: program,
				command,
				source: { file: rule.file, line: rule.line },
			};
			if (rule.justification !== undefined) match.justification = rule.justification;
			matches.push(match);
		}
		return matches;
	}

	#matchesFor(argv: string[], command: string, heuristics: HeuristicsFallback | undefined): RuleMatch[] {
		if (argv.length === 0) return [];
		const exact = this.#matchExact(argv, command);
		if (exact.length > 0) return exact;
		const resolved = this.#matchHostExecutable(argv, command);
		if (resolved.length > 0) return resolved;
		if (heuristics === undefined) return [];
		const fallback = heuristics(argv, command);
		if (fallback === undefined) return [];
		const match: HeuristicsRuleMatch = {
			kind: "heuristics",
			command,
			decision: fallback.decision,
		};
		if (fallback.justification !== undefined) match.justification = fallback.justification;
		return [match];
	}

	/**
	 * Judge one command line. Every literal segment is evaluated; the returned
	 * decision is the strictest verdict and unmatched segments contribute
	 * nothing beyond appearing in `segments`.
	 */
	check(command: string, heuristics?: HeuristicsFallback): Evaluation {
		const analysis: CommandAnalysis = analyzeCommand(command);
		const matchedRules: RuleMatch[] = [];
		for (const segment of analysis.segments) {
			if (segment.unresolved) continue;
			matchedRules.push(...this.#matchesFor(segment.argv, segment.text, heuristics));
		}
		const decision = strictestDecision(matchedRules.map(match => match.decision));
		const evaluation: Evaluation = { matchedRules, segments: analysis.segments, writeTargets: analysis.writeTargets };
		if (decision !== undefined) evaluation.decision = decision;
		return evaluation;
	}
}

export interface PolicyLoadOptions {
	/** Rule files in low→high precedence order; later files add rules. */
	files: { path: string; content: string }[];
	/** Managed overlay parsed from `requirements.toml`-style prefix rules. */
	overlay?: { path: string; content: string }[];
}

export function buildPolicy(options: PolicyLoadOptions): LoadedPolicy {
	const diagnostics: Diagnostic[] = [];
	const parsed: ParsedRuleFile[] = [];
	for (const file of options.files) {
		const result = parseRuleFile(file.content, file.path);
		diagnostics.push(...result.diagnostics);
		parsed.push(result);
	}
	let policy = Policy.fromRuleFiles(parsed);
	if (options.overlay !== undefined) {
		const overlayFiles: ParsedRuleFile[] = [];
		for (const file of options.overlay) {
			const result = parseRuleFile(file.content, file.path);
			diagnostics.push(...result.diagnostics);
			overlayFiles.push(result);
		}
		policy = policy.mergeOverlay(overlayFiles);
	}
	validateExamples(parsed, diagnostics);
	const counts: Record<string, number> = {};
	for (const file of parsed) counts[file.file] = file.rules.length;
	return { policy, diagnostics, files: options.files.map(file => file.path), counts };
}

/**
 * Validate `match` / `not_match` examples the way upstream does at load time:
 * each example is checked against the rules *that declaration* produced, in
 * isolation from every other rule in the policy.
 *
 * Validating against the whole policy would report rules in unrelated files as
 * satisfying someone else's example, and — because one declaration expands into
 * one rule per first-token alternative — validating per expanded rule would
 * require a declaration's `npm install` example to also match its own `pnpm`
 * variant. Upstream validates the expanded set as a unit, so this does too.
 */
function validateExamples(declarations: ParsedRuleFile[], diagnostics: Diagnostic[]): void {
	for (const file of declarations) {
		for (const declared of file.rules) {
			if (declared.match.length === 0 && declared.notMatch.length === 0) continue;
			const own = Policy.fromRuleFiles([{ ...file, rules: [declared] }]);
			const matchesOwn = (example: string[]): boolean =>
				own.check(example.join(" ")).matchedRules.some(match => match.kind === "prefix_rule");
			for (const example of declared.match) {
				if (matchesOwn(example)) continue;
				diagnostics.push({
					file: declared.file,
					line: declared.line,
					severity: "error",
					message: `match example ${JSON.stringify(example.join(" "))} does not match ${renderPattern(declared.pattern)}`,
				});
			}
			for (const example of declared.notMatch) {
				if (!matchesOwn(example)) continue;
				diagnostics.push({
					file: declared.file,
					line: declared.line,
					severity: "error",
					message: `not_match example ${JSON.stringify(example.join(" "))} matches ${renderPattern(declared.pattern)}`,
				});
			}
		}
	}
}

/** Serialize an `Evaluation` to the JSON shape `codex execpolicy check` prints. */
export function evaluationToJson(evaluation: Evaluation): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		matchedRules: evaluation.matchedRules.map(match =>
			match.kind === "prefix_rule"
				? {
						prefixRuleMatch: {
							matchedPrefix: match.matchedPrefix,
							decision: match.decision,
							...(match.resolvedProgram === undefined ? {} : { resolvedProgram: match.resolvedProgram }),
							...(match.justification === undefined ? {} : { justification: match.justification }),
						},
					}
				: { heuristicsRuleMatch: { command: match.command.split(" "), decision: match.decision } },
		),
	};
	if (evaluation.decision !== undefined) payload.decision = evaluation.decision;
	return payload;
}

export { DECISION_RANK };
export type { Diagnostic, HostExecutableSpec, PrefixRuleSpec, PatternToken };
