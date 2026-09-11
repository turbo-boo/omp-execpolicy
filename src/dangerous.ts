/**
 * Hardcoded dangerous-command heuristics.
 *
 * Codex pairs its rule engine with a small, deterministic detector that decides
 * the verdict for commands *no rule matched* (`is_dangerous_command.rs`). The
 * rule set is deliberately narrow: a forced `rm` (POSIX) or a destructive
 * cmdlet (Windows/PowerShell) is the only thing classified as dangerous on its
 * own; everything else falls through to the approval policy.
 *
 * The same wrapper unwrapping applies here — `sudo rm -rf /`, `env A=1 rm -rf
 * /`, and `trap 'rm -rf /' EXIT` all resolve to the forced `rm` — with a depth
 * cap that fails closed (`unresolved`) rather than silently allowing deep nesting.
 */

import { basenameOfProgram } from "./command.ts";

export type DangerousMatch = "forced_rm" | "other" | "unresolved";

const MAX_WRAPPER_DEPTH = 8;

const WINDOWS_DELETE_CMDLETS: Record<string, true> = {
	"remove-item": true,
	ri: true,
	rm: true,
	del: true,
	erase: true,
	rd: true,
	rmdir: true,
};

function executableNameLookupKey(raw: string): string | undefined {
	if (process.platform !== "win32") {
		const name = basenameOfProgram(raw);
		return name.length === 0 ? undefined : name;
	}
	let name = basenameOfProgram(raw.replaceAll("\\", "/"));
	if (/^[A-Za-z]:/.test(name)) name = name.slice(2);
	name = name.toLowerCase();
	for (const suffix of [".exe", ".cmd", ".bat", ".com"]) {
		if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
	}
	return name.length === 0 ? undefined : name;
}

function rmArgsIncludeForceOption(args: string[]): boolean {
	for (const arg of args) {
		if (arg === "--") return false;
		if (arg === "--force") return true;
		if (arg.startsWith("-") && !arg.startsWith("--") && arg.slice(1).includes("f")) return true;
	}
	return false;
}

function envProgramIndex(command: string[]): number {
	let index = 1;
	while (index < command.length) {
		const argument = command[index]!;
		if (argument === "--") return index + 1;
		const isAssignment = argument.includes("=") && !argument.startsWith("-") && argument.split("=", 1)[0] !== "";
		if (argument === "-i" || argument === "--ignore-environment" || isAssignment) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
}

function windowsDeleteMatch(command: string[]): boolean {
	const program = executableNameLookupKey(command[0] ?? "");
	if (program === undefined || WINDOWS_DELETE_CMDLETS[program] !== true) return false;
	const args = command.slice(1);
	const hasUrl = args.some(argument => /^https?:\/\//i.test(argument));
	const hasForce = args.some(argument => {
		const flag = argument.toLowerCase();
		return flag === "-force" || flag === "/force" || flag === "-f" || flag.startsWith("-recurse") || flag === "-r";
	});
	return hasUrl || hasForce;
}

function powershellWordsMatch(command: string[]): boolean {
	const program = executableNameLookupKey(command[0] ?? "");
	if (program !== "powershell" && program !== "pwsh") return false;
	const script = command.slice(1).join(" ").toLowerCase();
	return /\b(remove-item|ri|rm|del|erase|rd|rmdir)\b/.test(script) && /(-force|\/force|-recurse)/.test(script);
}

/**
 * Returns the dangerous-command rule matched by an already-tokenized command.
 * `unresolved` mirrors upstream's `Other`-on-depth-exceeded fail-closed result.
 */
export function dangerousCommandMatch(command: string[], depth = 0): DangerousMatch | undefined {
	if (depth > MAX_WRAPPER_DEPTH) return "unresolved";
	const program = command[0] === undefined ? undefined : executableNameLookupKey(command[0]);

	if (program === "rm" && rmArgsIncludeForceOption(command.slice(1))) return "forced_rm";
	if (program === "sudo") return dangerousCommandMatch(command.slice(1), depth + 1);
	if (program === "env") return dangerousCommandMatch(command.slice(envProgramIndex(command)), depth + 1);
	if (program === "trap") {
		let actionIndex = 1;
		if (command[actionIndex] === "--") actionIndex += 1;
		const action = command[actionIndex];
		if (action !== undefined && !action.startsWith("-")) {
			return dangerousCommandMatch(["sh", "-c", action], depth + 1);
		}
		return undefined;
	}
	if (process.platform === "win32") {
		if (windowsDeleteMatch(command)) return "other";
		if (powershellWordsMatch(command)) return "other";
	}
	return undefined;
}

export function describeDangerousMatch(match: DangerousMatch): string {
	if (match === "forced_rm") return "forced rm (rm -f / rm -rf)";
	if (match === "other") return "destructive delete command";
	return "command nesting exceeded the analysis depth cap";
}
