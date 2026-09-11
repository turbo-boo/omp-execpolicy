/**
 * Verdict vocabulary shared by every judging layer.
 *
 * Mirrors Codex's `codex_execpolicy::Decision` (`allow | prompt | forbidden`):
 * `DECISION_RANK` orders the values by severity so the strictest verdict across
 * a set of matches is a plain maximum.
 */
export type Decision = "allow" | "prompt" | "forbidden";

/** Severity rank: `allow` < `prompt` < `forbidden`. */
export const DECISION_RANK: Record<Decision, number> = { allow: 0, prompt: 1, forbidden: 2 };

/** The strictest decision in `decisions`, or `undefined` when the set is empty. */
export function strictestDecision(decisions: Iterable<Decision>): Decision | undefined {
	let strictest: Decision | undefined;
	for (const decision of decisions) {
		if (strictest === undefined || DECISION_RANK[decision] > DECISION_RANK[strictest]) strictest = decision;
	}
	return strictest;
}

export function isDecision(value: unknown): value is Decision {
	return value === "allow" || value === "prompt" || value === "forbidden";
}
