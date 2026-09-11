/**
 * Shell command decomposition.
 *
 * A policy that only ever sees the raw string cannot judge `bash -c 'git reset
 * --hard'`, `sudo rm -rf /`, or `a && b`. Codex solves this by parsing the
 * command into literal sub-commands before evaluating the policy; this module
 * is the same idea reduced to what a rule matcher needs:
 *
 *   - split top-level `&&`, `||`, `;`, `|`, and newlines (quote/paren aware)
 *   - shlex-tokenize each piece, lifting `> target` out of the argument vector
 *   - recurse into `sh -c '<script>'` bodies and unwrap launcher wrappers
 *     (`sudo`, `env`, `timeout`, …) so the judged program is the one that
 *     actually runs
 *
 * Nothing here evaluates substitutions: `$(...)`, backticks and `${...}` are
 * carried through as opaque text, exactly as Codex treats non-literal shell
 * input (a command no rule can match falls back to heuristics).
 */

export interface CommandSegment {
	/** Raw text of this piece of the command line. */
	text: string;
	/** Tokens the rule matcher sees: redirects removed, wrappers unwrapped. */
	argv: string[];
	/** Raised for nesting past the depth cap or an unterminated quote. */
	unresolved: boolean;
}

export interface CommandAnalysis {
	segments: CommandSegment[];
	/** Targets of `>` / `>>` anywhere in the command, in order. */
	writeTargets: string[];
}

const MAX_NESTING_DEPTH = 8;

const SHELL_PROGRAMS: Record<string, true> = {
	bash: true,
	sh: true,
	zsh: true,
	dash: true,
	ksh: true,
	ash: true,
	mksh: true,
	posh: true,
	yash: true,
	csh: true,
	tcsh: true,
};

interface WrapperSpec {
	/** Options that consume the *next* token; `-oVALUE` / `--opt=value` carry their own. */
	valueOptions: Record<string, true>;
	/** Leading non-option operands that belong to the wrapper (e.g. `timeout 5 cmd`). */
	positionals?: number;
}

/**
 * Launcher programs that run another command. A `null` spec means "the next
 * operand is the program" (busybox/toybox applets).
 */
const WRAPPERS: Record<string, WrapperSpec | null> = {
	sudo: {
		valueOptions: {
			"-u": true,
			"-g": true,
			"-p": true,
			"-C": true,
			"-h": true,
			"-r": true,
			"-t": true,
			"-U": true,
			"-P": true,
			"-R": true,
			"-T": true,
			"-D": true,
		},
	},
	doas: { valueOptions: { "-u": true, "-C": true } },
	env: {
		valueOptions: {
			"-u": true,
			"--unset": true,
			"-C": true,
			"--chdir": true,
			"-S": true,
			"--split-string": true,
		},
	},
	time: { valueOptions: { "-o": true, "--output": true, "-f": true, "--format": true } },
	nice: { valueOptions: { "-n": true, "--adjustment": true } },
	nohup: { valueOptions: {} },
	command: { valueOptions: {} },
	builtin: { valueOptions: {} },
	exec: { valueOptions: { "-a": true } },
	setsid: { valueOptions: {} },
	stdbuf: {
		valueOptions: {
			"-i": true,
			"-o": true,
			"-e": true,
			"--input": true,
			"--output": true,
			"--error": true,
		},
	},
	timeout: {
		valueOptions: { "-s": true, "--signal": true, "-k": true, "--kill-after": true },
		positionals: 1,
	},
	ionice: { valueOptions: { "-c": true, "-n": true, "-p": true, "-P": true, "-u": true } },
	chrt: {
		valueOptions: {
			"-p": true,
			"-T": true,
			"-P": true,
			"-a": true,
			"-m": true,
			"-r": true,
			"-b": true,
			"-f": true,
			"-d": true,
			"-o": true,
		},
	},
	taskset: { valueOptions: { "-c": true, "-p": true } },
	xargs: {
		valueOptions: {
			"-I": true,
			"-i": true,
			"-n": true,
			"-P": true,
			"-s": true,
			"-d": true,
			"-a": true,
			"-E": true,
			"-L": true,
			"-e": true,
		},
	},
	busybox: null,
	toybox: null,
};

const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_RE = /^(?:\d+)?(?:>>|>\||&>>|&>|<<<|<<|<>|<|>)$/;
const CLOSE_FD_RE = /^(?:\d+)?(?:>&|-<|&)-$/;
/**
 * `<<EOF` / `<<-EOF` / `<<'EOF'` — a heredoc operator, optionally with its
 * delimiter attached. Excludes `<<<` (a here-string carries no body) and `<<` as
 * a shift operator inside `(( ))`, which the depth tracker keeps out of reach.
 */
const HEREDOC_RE = /^(?:\d+)?<<(-?)([^<].*)?$/;
const SHELL_COMMAND_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;

export function basenameOfProgram(program: string): string {
	const slash = program.lastIndexOf("/");
	return slash === -1 ? program : program.slice(slash + 1);
}

export function isAbsoluteProgram(program: string): boolean {
	return program.startsWith("/") || /^[A-Za-z]:[\\/]/.test(program);
}

/**
 * Read a heredoc delimiter starting at `start` (the token right after `<<`),
 * returning its unquoted text. `<<-EOF` strips leading tabs from body lines,
 * and the delimiter may be backslash-escaped, single- or double-quoted; none of
 * that changes how the body is matched, only where it ends.
 */
function readHeredocDelimiter(source: string, start: number): { delimiter: string; tabStripped: boolean; end: number } | undefined {
	let index = start;
	let tabStripped = false;
	if (source[index] === "-") {
		tabStripped = true;
		index += 1;
	}
	let delimiter = "";
	let quote: "'" | '"' | undefined;
	while (index < source.length) {
		const char = source[index]!;
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else delimiter += char;
			index += 1;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") {
				index += 1;
				continue;
			}
			if (char === '"') quote = undefined;
			else delimiter += char;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			index += 1;
			continue;
		}
		if (char === "\\") {
			delimiter += source[index + 1] ?? "";
			index += 2;
			continue;
		}
		if (/[ \t\n;|&()<>]/.test(char)) break;
		delimiter += char;
		index += 1;
	}
	if (delimiter.length === 0) return undefined;
	return { delimiter, tabStripped, end: index };
}

/**
 * Split a command line on top-level separators, ignoring separators inside
 * quotes, `$(...)`, `${...}` and backticks.
 *
 * Heredoc bodies are consumed and discarded: they are stdin data, not commands,
 * so judging them would flag prose that merely mentions a command. Codex keeps
 * them attached to the command that reads them; dropping them here leaves the
 * argv a rule matches against unchanged, which is what actually matters.
 */
export function splitTopLevel(command: string): string[] {
	const pieces: string[] = [];
	let current = "";
	let quote: "'" | '"' | "`" | undefined;
	let depth = 0;
	let pendingHeredocs: { delimiter: string; tabStripped: boolean }[] = [];
	for (let index = 0; index < command.length; index++) {
		const char = command[index]!;
		if (quote === "'") {
			current += char;
			if (char === "'") quote = undefined;
			continue;
		}
		if (quote === '"' || quote === "`") {
			if (char === "\\" && quote === '"') {
				current += char + (command[index + 1] ?? "");
				index += 1;
				continue;
			}
			current += char;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}
		if (char === "\\") {
			current += char + (command[index + 1] ?? "");
			index += 1;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") depth += 1;
		else if (char === "(" && depth > 0) depth += 1;
		else if (char === ")" && depth > 0) depth -= 1;
		if (depth > 0) {
			current += char;
			continue;
		}
		// `<<` starts a heredoc (`<<<` is a here-string and has no body).
		if (char === "<" && command[index + 1] === "<" && command[index + 2] !== "<") {
			const parsed = readHeredocDelimiter(command, index + 2);
			if (parsed !== undefined) {
				pendingHeredocs.push({ delimiter: parsed.delimiter, tabStripped: parsed.tabStripped });
				current += command.slice(index, parsed.end);
				index = parsed.end - 1;
				continue;
			}
		}
		if (char === "\n") {
			pieces.push(current);
			current = "";
			// Skip each heredoc body up to and including its delimiter line.
			for (const heredoc of pendingHeredocs) {
				let cursor = index + 1;
				while (cursor <= command.length) {
					const lineEnd = command.indexOf("\n", cursor);
					const line = command.slice(cursor, lineEnd === -1 ? command.length : lineEnd);
					const candidate = heredoc.tabStripped ? line.replace(/^\t+/, "") : line;
					const atEnd = lineEnd === -1;
					cursor = atEnd ? command.length + 1 : lineEnd + 1;
					if (candidate.trim() === heredoc.delimiter) break;
					if (atEnd) break;
				}
				index = Math.min(cursor - 1, command.length);
			}
			pendingHeredocs = [];
			continue;
		}
		if (char === ";" || char === "|" || char === "&") {
			pieces.push(current);
			current = "";
			if (command[index + 1] === char) index += 1;
			continue;
		}
		current += char;
	}
	pieces.push(current);
	return pieces.map(piece => piece.trim()).filter(piece => piece.length > 0);
}

interface TokenizedPiece {
	argv: string[];
	writeTargets: string[];
	unterminatedQuote: boolean;
}

/** shlex-style tokenizer that lifts redirect operators and their targets out of `argv`. */
export function tokenizePiece(piece: string): TokenizedPiece {
	const tokens: string[] = [];
	let current = "";
	let hasCurrent = false;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < piece.length; index++) {
		const char = piece[index]!;
		if (escaped) {
			current += char;
			hasCurrent = true;
			escaped = false;
			continue;
		}
		if (quote === "'") {
			if (char === "'") quote = undefined;
			else current += char;
			hasCurrent = true;
			continue;
		}
		if (quote === '"') {
			if (char === "\\") escaped = true;
			else if (char === '"') quote = undefined;
			else current += char;
			hasCurrent = true;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			hasCurrent = true;
			continue;
		}
		if (char === " " || char === "\t") {
			if (hasCurrent) tokens.push(current);
			current = "";
			hasCurrent = false;
			continue;
		}
		current += char;
		hasCurrent = true;
	}
	if (hasCurrent) tokens.push(current);

	const argv: string[] = [];
	const writeTargets: string[] = [];
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (CLOSE_FD_RE.test(token)) continue;
		const heredoc = HEREDOC_RE.exec(token);
		if (heredoc !== null) {
			// The delimiter is either attached (`<<EOF`) or the next token.
			if (heredoc[2] === "") index += 1;
			continue;
		}
		if (REDIRECT_RE.test(token)) {
			const target = tokens[index + 1];
			if (target === undefined) continue;
			if (token.includes(">")) writeTargets.push(target);
			index += 1;
			continue;
		}
		argv.push(token);
	}
	return { argv, writeTargets, unterminatedQuote: quote !== undefined || escaped };
}

function stripWrapperArguments(argv: string[], spec: WrapperSpec): string[] {
	let index = 1;
	let remainingPositionals = spec.positionals ?? 0;
	while (index < argv.length) {
		const token = argv[index]!;
		if (token === "--") return argv.slice(index + 1);
		if (remainingPositionals > 0 && !token.startsWith("-")) {
			index += 1;
			remainingPositionals -= 1;
			continue;
		}
		if (ASSIGNMENT_RE.test(token)) {
			index += 1;
			continue;
		}
		if (!token.startsWith("-") || token === "-") break;
		if (token.includes("=")) {
			index += 1;
			continue;
		}
		index += spec.valueOptions[token] === true ? 2 : 1;
	}
	return argv.slice(index);
}

/**
 * Decompose a command line into the literal sub-commands a policy can judge.
 * Nested `sh -c` bodies are inlined and launcher wrappers are unwrapped; a
 * chain longer than {@link MAX_NESTING_DEPTH} yields an unresolvable segment,
 * mirroring Codex's "fail closed" depth cap — an unresolvable command is not
 * treated as dangerous, it is simply not matchable by rules.
 */
export function analyzeCommand(command: string): CommandAnalysis {
	const segments: CommandSegment[] = [];
	const writeTargets: string[] = [];
	const walk = (text: string, depth: number): void => {
		const tokenized = tokenizePiece(text);
		writeTargets.push(...tokenized.writeTargets);
		let unresolved = tokenized.unterminatedQuote || depth > MAX_NESTING_DEPTH;
		let argv = tokenized.argv;
		let unwrapped = 0;
		while (argv.length > 0) {
			while (argv.length > 0 && (argv[0] === "!" || ASSIGNMENT_RE.test(argv[0]!))) argv = argv.slice(1);
			if (argv.length === 0) break;
			if (unwrapped++ > MAX_NESTING_DEPTH) {
				unresolved = true;
				break;
			}
			const program = basenameOfProgram(argv[0]!);
			if (SHELL_PROGRAMS[program] === true) {
				let scriptIndex = -1;
				for (let index = 1; index < argv.length; index++) {
					const token = argv[index]!;
					if (SHELL_COMMAND_FLAG_RE.test(token)) {
						scriptIndex = index + 1;
						break;
					}
					if (!token.startsWith("-")) break;
				}
				const script = scriptIndex === -1 ? undefined : argv[scriptIndex];
				if (script !== undefined) {
					for (const piece of splitTopLevel(script)) {
						if (depth >= MAX_NESTING_DEPTH) segments.push({ text: piece, argv: [], unresolved: true });
						else walk(piece, depth + 1);
					}
					return;
				}
				break;
			}
			const wrapper = WRAPPERS[program];
			if (wrapper === undefined) break;
			// A `null` spec (busybox/toybox) means the next operand *is* the program.
			const inner = wrapper === null ? argv.slice(1) : stripWrapperArguments(argv, wrapper);
			if (inner.length === 0 || inner.length >= argv.length) break;
			argv = inner;
		}
		segments.push({ text, argv, unresolved });
	};
	for (const piece of splitTopLevel(command)) walk(piece, 0);
	return { segments, writeTargets };
}
