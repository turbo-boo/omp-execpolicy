/**
 * Tolerant parsing of a judge response.
 *
 * Models wrap JSON in prose, fences, and occasionally rename fields. A parse
 * failure is reported rather than coerced into a verdict: the caller decides
 * what an unreadable review means (by default, ask the user).
 */

export type JudgeOutcome = "allow" | "deny";
export type JudgeRiskLevel = "low" | "medium" | "high" | "critical";
export type JudgeUserAuthorization = "unknown" | "low" | "medium" | "high";

export interface JudgeVerdict {
	outcome: JudgeOutcome;
	riskLevel: JudgeRiskLevel;
	userAuthorization: JudgeUserAuthorization;
	rationale: string;
}

export type JudgeResult = { ok: true; verdict: JudgeVerdict } | { ok: false; error: string };

const RISK_LEVELS: Record<string, JudgeRiskLevel> = {
	low: "low",
	medium: "medium",
	high: "high",
	critical: "critical",
};

const AUTHORIZATIONS: Record<string, JudgeUserAuthorization> = {
	unknown: "unknown",
	low: "low",
	medium: "medium",
	high: "high",
};

/** Extract the verdict from raw model output; never throws. */
export function parseVerdict(raw: string): JudgeResult {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return { ok: false, error: "judge returned no JSON object" };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.slice(start, end + 1));
	} catch (error) {
		return {
			ok: false,
			error: `judge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (parsed === null || typeof parsed !== "object") {
		return { ok: false, error: "judge returned a non-object verdict" };
	}
	const record = parsed as Record<string, unknown>;
	const outcome = record.outcome ?? record.decision;
	if (outcome !== "allow" && outcome !== "deny") {
		return { ok: false, error: `judge returned an unrecognized outcome: ${JSON.stringify(outcome)}` };
	}
	const risk = typeof (record.risk_level ?? record.riskLevel) === "string" ? String(record.risk_level ?? record.riskLevel).toLowerCase() : "";
	const authorization =
		typeof (record.user_authorization ?? record.userAuthorization) === "string"
			? String(record.user_authorization ?? record.userAuthorization).toLowerCase()
			: "";
	const rationaleRaw = record.rationale ?? record.reason;
	return {
		ok: true,
		verdict: {
			outcome,
			// An unreadable risk level must not soften a denial: a `deny` without
			// a level is treated as high risk, matching the reviewer contract.
			riskLevel: RISK_LEVELS[risk] ?? (outcome === "deny" ? "high" : "low"),
			userAuthorization: AUTHORIZATIONS[authorization] ?? "unknown",
			rationale: typeof rationaleRaw === "string" ? rationaleRaw.trim() : "",
		},
	};
}
