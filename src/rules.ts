/**
 * Parser for Codex's execution-policy rule syntax.
 *
 * The upstream language is Starlark (evaluated by `codex-execpolicy`). Only the
 * declarative subset that judges commands is implemented here:
 *
 *   prefix_rule(pattern=["git", ["status", "log"]], decision="prompt",
 *               justification="read-only git", match=[...], not_match=[...])
 *   host_executable(name="git", paths=["/usr/bin/git"])
 *
 * Parsing is deliberately non-fatal, mirroring Codex's "Error parsing rules;
 * custom rules not applied" behavior: a bad rule file yields diagnostics and
 * contributes whatever rules parsed cleanly before the error.
 */

import { basenameOfProgram, isAbsoluteProgram, tokenizePiece } from "./command.ts";
import { isDecision, type Decision } from "./decision.ts";

export interface Diagnostic {
	file: string;
	line: number;
	severity: "error" | "warning";
	message: string;
}

export type PatternToken = { kind: "single"; value: string } | { kind: "alts"; values: string[] };

export interface PrefixRuleSpec {
	pattern: PatternToken[];
	decision: Decision;
	justification?: string;
	/** Example invocations that must match this rule; validated at compile time. */
	match: string[][];
	notMatch: string[][];
	file: string;
	line: number;
}

export interface HostExecutableSpec {
	name: string;
	paths?: string[];
	file: string;
	line: number;
}

export interface ParsedRuleFile {
	file: string;
	rules: PrefixRuleSpec[];
	hostExecutables: HostExecutableSpec[];
	diagnostics: Diagnostic[];
}

interface Token {
	kind: "ident" | "string" | "number" | "punct";
	value: string;
	line: number;
}

type Value =
	| { kind: "string"; value: string }
	| { kind: "number"; value: string }
	| { kind: "ident"; value: string }
	| { kind: "list"; items: Value[] };

function lex(source: string, file: string, diagnostics: Diagnostic[]): Token[] {
	const tokens: Token[] = [];
	let line = 1;
	for (let index = 0; index < source.length; index++) {
		const char = source[index]!;
		if (char === "\n") {
			line += 1;
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") continue;
		if (char === "#") {
			while (index < source.length && source[index] !== "\n") index += 1;
			continue;
		}
		if (char === "(" || char === ")" || char === "[" || char === "]" || char === "," || char === "=") {
			tokens.push({ kind: "punct", value: char, line });
			continue;
		}
		if (char === '"' || char === "'") {
			const quote = char;
			let value = "";
			let closed = false;
			index += 1;
			for (; index < source.length; index++) {
				const inner = source[index]!;
				if (inner === "\\") {
					const escaped = source[index + 1];
					if (escaped === undefined) break;
					value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
					index += 1;
					continue;
				}
				if (inner === quote) {
					closed = true;
					break;
				}
				if (inner === "\n") line += 1;
				value += inner;
			}
			if (!closed) {
				diagnostics.push({ file, line, severity: "error", message: "unterminated string literal" });
			}
			tokens.push({ kind: "string", value, line });
			continue;
		}
		if (/[0-9]/.test(char)) {
			let value = "";
			while (index < source.length && /[0-9.]/.test(source[index]!)) {
				value += source[index];
				index += 1;
			}
			index -= 1;
			tokens.push({ kind: "number", value, line });
			continue;
		}
		if (/[A-Za-z_]/.test(char)) {
			let value = "";
			while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) {
				value += source[index];
				index += 1;
			}
			index -= 1;
			tokens.push({ kind: "ident", value, line });
			continue;
		}
		diagnostics.push({ file, line, severity: "error", message: `unexpected character ${JSON.stringify(char)}` });
	}
	return tokens;
}

interface ParsedCall {
	name: string;
	line: number;
	args: { key: string; value: Value; line: number }[];
}

function parseCalls(tokens: Token[], file: string, diagnostics: Diagnostic[]): ParsedCall[] {
	const calls: ParsedCall[] = [];
	let index = 0;
	const error = (line: number, message: string): void => {
		diagnostics.push({ file, line, severity: "error", message });
	};
	while (index < tokens.length) {
		const head = tokens[index]!;
		if (head.kind !== "ident" || tokens[index + 1]?.value !== "(") {
			error(head.line, `expected a directive call, found ${JSON.stringify(head.value)}`);
			// Recover at the next call-looking token so one typo cannot swallow the file.
			while (index < tokens.length && !(tokens[index]!.kind === "ident" && tokens[index + 1]?.value === "(")) index += 1;
			continue;
		}
		index += 2;
		const args: ParsedCall["args"] = [];
		const seen = new Set<string>();
		while (index < tokens.length && tokens[index]!.value !== ")") {
			const key = tokens[index]!;
			if (key.kind !== "ident" || tokens[index + 1]?.value !== "=") {
				error(key.line, `expected "name = value" in ${head.value}(...)`);
				index += 1;
				continue;
			}
			index += 2;
			const parsed = parseValue(tokens, index, file, diagnostics);
			index = parsed.next;
			if (seen.has(key.value)) error(key.line, `duplicate argument ${JSON.stringify(key.value)}`);
			seen.add(key.value);
			args.push({ key: key.value, value: parsed.value, line: key.line });
			if (tokens[index]?.value === ",") index += 1;
		}
		if (tokens[index]?.value === ")") index += 1;
		calls.push({ name: head.value, line: head.line, args });
	}
	return calls;
}

function parseValue(
	tokens: Token[],
	start: number,
	file: string,
	diagnostics: Diagnostic[],
): { value: Value; next: number } {
	const token = tokens[start];
	if (token === undefined) {
		diagnostics.push({ file, line: 0, severity: "error", message: "missing value" });
		return { value: { kind: "ident", value: "" }, next: start };
	}
	if (token.kind === "string" || token.kind === "number" || token.kind === "ident") {
		return { value: { kind: token.kind, value: token.value }, next: start + 1 };
	}
	if (token.value === "[") {
		const items: Value[] = [];
		let index = start + 1;
		while (index < tokens.length && tokens[index]!.value !== "]") {
			if (tokens[index]!.value === ",") {
				index += 1;
				continue;
			}
			const parsed = parseValue(tokens, index, file, diagnostics);
			items.push(parsed.value);
			index = parsed.next;
		}
		return { value: { kind: "list", items }, next: index + 1 };
	}
	diagnostics.push({ file, line: token.line, severity: "error", message: `unexpected token ${JSON.stringify(token.value)}` });
	return { value: { kind: "ident", value: token.value }, next: start + 1 };
}

function asString(value: Value): string | undefined {
	return value.kind === "string" || value.kind === "ident" || value.kind === "number" ? value.value : undefined;
}

/** Tokenize a `match` / `not_match` example: a string is split like a shell word list. */
function exampleToArgv(value: Value): string[] | undefined {
	if (value.kind === "string") return tokenizePiece(value.value).argv;
	if (value.kind === "list") {
		const argv: string[] = [];
		for (const item of value.items) {
			const token = asString(item);
			if (token === undefined) return undefined;
			argv.push(token);
		}
		return argv;
	}
	return undefined;
}

function patternToken(value: Value): PatternToken | undefined {
	if (value.kind === "string" || value.kind === "ident" || value.kind === "number") {
		return { kind: "single", value: value.value };
	}
	if (value.kind === "list") {
		const values: string[] = [];
		for (const item of value.items) {
			const token = asString(item);
			if (token === undefined) return undefined;
			values.push(token);
		}
		return values.length === 0 ? undefined : { kind: "alts", values };
	}
	return undefined;
}

const PREFIX_RULE_KEYS: Record<string, true> = {
	pattern: true,
	decision: true,
	justification: true,
	match: true,
	not_match: true,
};

const HOST_EXECUTABLE_KEYS: Record<string, true> = { name: true, paths: true };

/** Parse one rule file. Diagnostics are collected, never thrown. */
export function parseRuleFile(source: string, file: string): ParsedRuleFile {
	const diagnostics: Diagnostic[] = [];
	const result: ParsedRuleFile = { file, rules: [], hostExecutables: [], diagnostics };
	for (const call of parseCalls(lex(source, file, diagnostics), file, diagnostics)) {
		const known = call.name === "prefix_rule" ? PREFIX_RULE_KEYS : call.name === "host_executable" ? HOST_EXECUTABLE_KEYS : undefined;
		if (known === undefined) {
			diagnostics.push({ file, line: call.line, severity: "error", message: `unknown directive ${call.name}()` });
			continue;
		}
		for (const arg of call.args) {
			if (known[arg.key] !== true) {
				diagnostics.push({ file, line: arg.line, severity: "error", message: `unknown argument ${arg.key} for ${call.name}()` });
			}
		}
		const args = new Map(call.args.map(arg => [arg.key, arg]));
		const error = (message: string, line = call.line): void => {
			diagnostics.push({ file, line, severity: "error", message });
		};

		if (call.name === "host_executable") {
			const name = args.get("name");
			const resolvedName = name === undefined ? undefined : asString(name.value);
			if (resolvedName === undefined || resolvedName.length === 0) {
				error("host_executable() requires a string name");
				continue;
			}
			if (resolvedName.includes("/")) {
				error(`host_executable() name must be a bare executable name (got ${JSON.stringify(resolvedName)})`);
				continue;
			}
			const pathsArg = args.get("paths");
			if (pathsArg === undefined) {
				error("host_executable() requires paths (an empty list disables basename fallback)");
				continue;
			}
			if (pathsArg.value.kind !== "list") {
				error("host_executable() paths must be a list of absolute paths");
				continue;
			}
			const paths: string[] = [];
			let badPath = false;
			for (const item of pathsArg.value.items) {
				const resolved = asString(item);
				if (resolved === undefined) {
					error("host_executable() paths entries must be strings");
					badPath = true;
					continue;
				}
				if (!isAbsoluteProgram(resolved) || basenameOfProgram(resolved) !== resolvedName) {
					error(`host_executable() path ${JSON.stringify(resolved)} must be absolute with basename ${JSON.stringify(resolvedName)}`);
					badPath = true;
					continue;
				}
				if (!paths.includes(resolved)) paths.push(resolved);
			}
			if (badPath) continue;
			result.hostExecutables.push({ name: resolvedName, paths, file, line: call.line });
			continue;
		}

		const patternArg = args.get("pattern");
		if (patternArg === undefined || patternArg.value.kind !== "list" || patternArg.value.items.length === 0) {
			error("prefix_rule() requires a non-empty pattern list");
			continue;
		}
		const pattern: PatternToken[] = [];
		let badPattern = false;
		for (const item of patternArg.value.items) {
			const token = patternToken(item);
			if (token === undefined) {
				error("pattern entries must be strings or non-empty lists of strings");
				badPattern = true;
				break;
			}
			pattern.push(token);
		}
		if (badPattern) continue;

		const decisionArg = args.get("decision");
		let decision: Decision = "allow";
		if (decisionArg !== undefined) {
			const raw = asString(decisionArg.value);
			if (raw === undefined || !isDecision(raw)) {
				error('decision must be "allow", "prompt", or "forbidden"');
				continue;
			}
			decision = raw;
		}

		const justificationArg = args.get("justification");
		const justification = justificationArg === undefined ? undefined : asString(justificationArg.value);
		if (justificationArg !== undefined && justification === undefined) {
			error("justification must be a string");
		}

		const examples = (key: "match" | "not_match"): string[][] | undefined => {
			const arg = args.get(key);
			if (arg === undefined) return [];
			if (arg.value.kind !== "list") {
				error(`${key} must be a list of invocations`);
				return undefined;
			}
			const collected: string[][] = [];
			for (const item of arg.value.items) {
				const argv = exampleToArgv(item);
				if (argv === undefined) {
					error(`${key} entries must be strings or lists of strings`);
					return undefined;
				}
				collected.push(argv);
			}
			return collected;
		};
		const match = examples("match");
		const notMatch = examples("not_match");
		if (match === undefined || notMatch === undefined) continue;

		result.rules.push({ pattern, decision, justification, match, notMatch, file, line: call.line });
	}
	return result;
}

/** Render a `prefix_rule(...)` line, e.g. for a "don't ask again" amendment. */
function renderPrefixRule(pattern: PatternToken[], decision: Decision, justification?: string): string {
	const rendered = pattern
		.map(token => (token.kind === "single" ? JSON.stringify(token.value) : `[${token.values.map(value => JSON.stringify(value)).join(", ")}]`))
		.join(", ");
	const parts = [`pattern=[${rendered}]`, `decision=${JSON.stringify(decision)}`];
	if (justification !== undefined && justification.length > 0) parts.push(`justification=${JSON.stringify(justification)}`);
	return `prefix_rule(${parts.join(", ")})`;
}

/** Render an `allow` amendment for an approved command prefix. */
export function renderAllowAmendment(argv: string[], justification: string): string {
	return renderPrefixRule(
		argv.map(value => ({ kind: "single", value })),
		"allow",
		justification,
	);
}

export function renderPattern(pattern: PatternToken[]): string {
	return pattern
		.map(token => (token.kind === "single" ? token.value : `[${token.values.join("|")}]`))
		.join(" ");
}
