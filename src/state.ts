/**
 * The snapshot every consumer judges from.
 *
 * Owned here rather than in the engine module so the `/execpolicy` command and
 * the tests can describe a state without importing the harness-bound loader.
 */

import type { PluginSettings } from "./settings.ts";
import type { ResolvedRuleFiles } from "./rule-files.ts";
import type { LoadedPolicy, Policy } from "./policy.ts";

export interface EngineState {
	settings: PluginSettings;
	resolved: ResolvedRuleFiles;
	loaded: LoadedPolicy;
	policy: Policy;
	/** Operator security policy for the judge, or `undefined` for the bundled default. */
	judgePolicy: string | undefined;
}

/** Loads (and caches) the current state for a working directory. */
export type LoadState = (cwd: string) => Promise<EngineState>;
