/**
 * Rule-file discovery and amendment.
 *
 * Rule files are read from the same config-directory layout omp searches for
 * its own resources — `<config dir>/rules/*.rules` — so an existing Codex
 * `~/.codex/rules/*.rules` works with no setup, and a project-local
 * `.omp/rules/*.rules` is picked up from the working directory.
 *
 * The `.rules` extension deliberately differs from the `.md`/`.mdc` files omp
 * loads into the system prompt: the two live side by side in the same directory
 * without either reading the other.
 *
 * Directory resolution is done here with node builtins rather than through the
 * harness's config helper, because a plugin cannot import the harness's
 * `.../config` subpath at runtime. That also keeps this module dependency-free
 * and unit-testable.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginSettings } from "./settings.ts";

export interface RuleFile {
	path: string;
	content: string;
}

export interface ResolvedRuleFiles {
	/** Rule files in low→high precedence order (later files add rules). */
	files: RuleFile[];
	/** Directories that were searched, for diagnostics. */
	searchedDirs: string[];
}

/** Config-dir names omp scans, highest priority first — mirrors its own list. */
const CONFIG_DIR_NAMES: readonly { dir: string; user: boolean }[] = [
	{ dir: ".omp", user: true },
	{ dir: ".claude", user: true },
	{ dir: ".codex", user: true },
	{ dir: ".gemini", user: true },
];

/**
 * Rule directories for `cwd`, lowest precedence first.
 *
 * User-level directories come before project-level ones, and the project
 * `.omp` directory wins overall, so a repo can tighten (or relax) what the
 * user-level rules say. `agentDir` is the harness's own agent directory
 * (`getAgentDir()`), which already honors `PI_CODING_AGENT_DIR` and profiles.
 */
export function resolveRuleDirs(cwd: string, agentDir: string): string[] {
	const home = os.homedir();
	const dirs: string[] = [];
	const projectDir = (name: string): string => path.resolve(cwd, name, "rules");
	const userDir = (name: string): string => (name === ".omp" ? path.join(agentDir, "rules") : path.join(home, name, "rules"));
	// Lowest precedence first: project dirs (reverse priority), then user dirs
	// (reverse priority), so `.omp` is applied last within each level.
	for (const { dir } of [...CONFIG_DIR_NAMES].reverse()) dirs.push(projectDir(dir));
	for (const { dir } of [...CONFIG_DIR_NAMES].reverse()) dirs.push(userDir(dir));
	return [...new Set(dirs)];
}

/** Collect every rule file: discovered directories first, then explicit extras. */
export function loadRuleFiles(settings: PluginSettings, dirs: string[], cwd: string): ResolvedRuleFiles {
	const searchedDirs = dirs.filter(dir => fs.existsSync(dir));
	const paths: string[] = [];
	for (const dir of searchedDirs) {
		let entries: string[];
		try {
			entries = fs.readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries.sort()) {
			if (entry.endsWith(".rules")) paths.push(path.join(dir, entry));
		}
	}
	// Explicitly configured files are the highest-precedence input: they are the
	// operator's own override, not a discovered default.
	for (const extra of settings.extraRuleFiles) {
		const resolved = path.isAbsolute(extra) ? extra : path.resolve(cwd, extra);
		if (!paths.includes(resolved)) paths.push(resolved);
	}
	const files: RuleFile[] = [];
	for (const file of paths) {
		try {
			files.push({ path: file, content: fs.readFileSync(file, "utf8") });
		} catch {
			// A file that disappears between listing and reading is skipped; a
			// missing explicitly-configured file shows up in `/execpolicy files`.
		}
	}
	return { files, searchedDirs };
}

/** Append a rule line to the amendment file, creating it (and its directory) if needed. */
export function appendRule(file: string, line: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	let existing = "";
	try {
		existing = fs.readFileSync(file, "utf8");
	} catch {
		existing = "";
	}
	const normalized = line.trim();
	if (existing.split("\n").some(entry => entry.trim() === normalized)) return;
	const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	fs.appendFileSync(file, `${separator}${normalized}\n`);
}
