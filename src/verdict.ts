/**
 * Tolerant parsing of a judge response.
 *
 * Models sometimes wrap JSON in prose/fences, emit more than one object, or
 * leave a trailing comma. We repair syntax only where the intended structure
 * is unambiguous. Conflicting valid verdicts are rejected rather than guessed.
 */

export type JudgeOutcome = "allow" | "deny";
export type JudgeRiskLevel = "low" | "medium" | "high" | "critical";
export type JudgeUserAuthorization = "unknown" | "low" | "medium" | "high";
export type JudgeErrorKind = "provider" | "timeout" | "empty" | "structure" | "invalid_verdict";

export interface JudgeVerdict {
	outcome: JudgeOutcome;
	riskLevel: JudgeRiskLevel;
	userAuthorization: JudgeUserAuthorization;
	rationale: string;
}

export type JudgeResult =
	| { ok: true; verdict: JudgeVerdict }
	| { ok: false; kind: JudgeErrorKind; error: string };

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

function token(value: unknown): string | undefined {
	return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

/** Extract balanced JSON-object candidates without being confused by braces inside strings. */
function extractJsonObjects(raw: string): string[] {
	const out: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (start === -1) {
			if (ch === "{") {
				start = i;
				depth = 1;
				inString = false;
				escaped = false;
			}
			continue;
		}

		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth++;
			continue;
		}
		if (ch === "}") {
			depth--;
			if (depth === 0) {
				out.push(raw.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return out;
}

/** Remove commas immediately before } or ] only when the comma is outside a JSON string. */
function stripTrailingCommas(raw: string): string {
	let out = "";
	let inString = false;
	let escaped = false;

	for (let i = 0; i < raw.length; i++) {
		const ch = raw[i]!;
		if (inString) {
			out += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
			continue;
		}

		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}

		if (ch === ",") {
			let j = i + 1;
			while (j < raw.length && /\s/.test(raw[j]!)) j++;
			if (raw[j] === "}" || raw[j] === "]") continue;
		}
		out += ch;
	}
	return out;
}

function parseJsonObject(candidate: string): Record<string, unknown> | undefined {
	for (const text of [candidate, stripTrailingCommas(candidate)]) {
		try {
			const parsed = JSON.parse(text) as unknown;
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// Try the syntax-only trailing-comma repair next.
		}
	}
	return undefined;
}

function verdictFromRecord(record: Record<string, unknown>): JudgeResult {
	const outcomeToken = token(record.outcome ?? record.decision);
	if (outcomeToken !== "allow" && outcomeToken !== "deny") {
		return {
			ok: false,
			kind: "invalid_verdict",
			error: `judge returned an unrecognized outcome: ${JSON.stringify(record.outcome ?? record.decision)}`,
		};
	}

	const riskRaw = record.risk_level ?? record.riskLevel;
	const riskToken = token(riskRaw);
	if (riskRaw !== undefined && (riskToken === undefined || RISK_LEVELS[riskToken] === undefined)) {
		return {
			ok: false,
			kind: "invalid_verdict",
			error: `judge returned an unrecognized risk level: ${JSON.stringify(riskRaw)}`,
		};
	}

	const authorizationRaw = record.user_authorization ?? record.userAuthorization;
	const authorizationToken = token(authorizationRaw);
	if (
		authorizationRaw !== undefined &&
		(authorizationToken === undefined || AUTHORIZATIONS[authorizationToken] === undefined)
	) {
		return {
			ok: false,
			kind: "invalid_verdict",
			error: `judge returned an unrecognized user authorization: ${JSON.stringify(authorizationRaw)}`,
		};
	}

	const rationaleRaw = record.rationale ?? record.reason;
	return {
		ok: true,
		verdict: {
			outcome: outcomeToken,
			// Preserve the old fail-safe defaults when the model omits optional
			// classification fields entirely.
			riskLevel: (riskToken === undefined ? undefined : RISK_LEVELS[riskToken]) ?? (outcomeToken === "deny" ? "high" : "low"),
			userAuthorization:
				(authorizationToken === undefined ? undefined : AUTHORIZATIONS[authorizationToken]) ?? "unknown",
			rationale: typeof rationaleRaw === "string" ? rationaleRaw.trim() : "",
		},
	};
}

function verdictKey(verdict: JudgeVerdict): string {
	return JSON.stringify(verdict);
}

function wrappedVerdict(record: Record<string, unknown>): Record<string, unknown> | undefined {
	for (const key of ["verdict", "result", "review"]) {
		const nested = record[key];
		if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
			return nested as Record<string, unknown>;
		}
	}
	return undefined;
}

/** Extract the verdict from raw model output; never throws. */
export function parseVerdict(raw: string): JudgeResult {
	const candidates = extractJsonObjects(raw);
	if (candidates.length === 0) {
		return { ok: false, kind: "structure", error: "judge returned no complete JSON object" };
	}

	const valid = new Map<string, JudgeVerdict>();
	const errors: string[] = [];
	let parsedObjectCount = 0;

	for (const candidate of candidates) {
		const record = parseJsonObject(candidate);
		if (record === undefined) continue;
		parsedObjectCount++;
		let result = verdictFromRecord(record);
		if (!result.ok) {
			const nested = wrappedVerdict(record);
			if (nested !== undefined) result = verdictFromRecord(nested);
		}
		if (result.ok) valid.set(verdictKey(result.verdict), result.verdict);
		else errors.push(result.error);
	}

	if (valid.size === 1) {
		return { ok: true, verdict: valid.values().next().value! };
	}
	if (valid.size > 1) {
		return {
			ok: false,
			kind: "invalid_verdict",
			error: "judge returned multiple conflicting valid verdicts",
		};
	}
	if (parsedObjectCount === 0) {
		return {
			ok: false,
			kind: "structure",
			error: "judge returned JSON-like output, but no object could be parsed",
		};
	}
	return {
		ok: false,
		kind: "invalid_verdict",
		error: errors[0] ?? "judge returned no valid verdict object",
	};
}
