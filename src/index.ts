/**
 * omp-execpolicy — Codex-style shell command judgment for oh-my-pi.
 *
 * A `tool_call` handler judges every `bash` call through the same layers Codex
 * uses, in the same order:
 *
 *   rules (allow | prompt | forbidden)
 *     └─ dangerous-command heuristics for unmatched commands
 *          └─ the configured unmatched verdict
 *               └─ the model judge ("command assessment")
 *
 * A `forbidden` verdict blocks the call; a `prompt` verdict asks the user, with
 * Codex's approval options including "don't ask again" rule amendments.
 *
 * Recommended companion setting — with `tools.approval.bash: "allow"` omp's own
 * bash gate stops prompting and this plugin becomes the sole judge of shell
 * commands, exactly as execpolicy is the sole gate in Codex. Without it the
 * plugin can only add restrictions, never lift omp's own approval requirement.
 */

import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@oh-my-pi/pi-coding-agent";
import { appendRule } from "./rule-files.ts";
import {
	evaluateDeterministic,
	formatBlockReason,
	formatPrompt,
	planAmendment,
	planGate,
	type DeterministicVerdict,
} from "./gate.ts";
import { judgeCommand } from "./judge.ts";
import type { Evaluation } from "./policy.ts";
import { renderAllowAmendment } from "./rules.ts";
import { Engine } from "./store.ts";
import type { EngineState } from "./state.ts";
import { renderTranscript } from "./transcript.ts";
import { registerExecpolicyCommand } from "./slash-command.ts";

/** Must match `name` in package.json so plugin settings resolve. */
const PLUGIN_NAME = "omp-execpolicy";

// Option labels follow Codex's exec-approval dialog, including the initial
// cursor on "Yes, proceed" (`approval_overlay.rs` `exec_options`). The final
// label names the agent rather than Codex, since this plugin runs in omp.
const APPROVE_ONCE = "Yes, proceed";
const AMEND_PREFIX = "Yes, and don't ask again for commands that start with";
const SESSION_LABEL = "Yes, and don't ask again for this command in this session";
const DECLINE = "No, continue without running it";
const CANCEL = "No, and tell the agent what to do differently";

const AMEND_JUSTIFICATION = "Approved by the user from the execution-policy prompt.";

export default function execPolicyExtension(pi: ExtensionAPI): void {
	// `pi.pi` is the already-loaded harness namespace, so `getAgentDir` is a
	// property read rather than an import the plugin would have to resolve.
	const engine = new Engine({ pluginName: PLUGIN_NAME, agentDir: pi.pi.getAgentDir() });
	/** Commands the user approved for this session ("don't ask again" without a rule). */
	const sessionApprovals = new Set<string>();

	registerExecpolicyCommand(pi, cwd => engine.state(cwd));

	pi.on("session_start", () => {
		sessionApprovals.clear();
		engine.invalidate();
	});

	pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | undefined> => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		if (command.trim().length === 0) return;

		let state: EngineState;
		try {
			state = await engine.state(ctx.cwd);
		} catch (error) {
			pi.logger.warn("execpolicy: failed to load rules", {
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!state.settings.enabled) return;

		const { evaluation, verdict } = evaluateDeterministic(state.policy, command, state.settings);
		switch (planGate(verdict, state.settings)) {
			case "block":
				ctx.ui.notify(`execpolicy: blocked — ${firstLine(verdict.reason)}`, "warning");
				return { block: true, reason: formatBlockReason(verdict) };
			case "run":
			case "pass":
				// "pass" leaves an undecided command to the harness's own gate.
				return;
			case "ask":
				return await requestApproval(pi, ctx, command, state, evaluation, verdict, engine, sessionApprovals);
			case "review":
				return await reviewCommand(pi, ctx, command, state, evaluation, verdict, engine, sessionApprovals);
		}
	});
}

function firstLine(text: string | undefined): string {
	if (text === undefined || text.length === 0) return "command denied by execution policy";
	const line = text.split("\n")[0]!;
	return line.length <= 160 ? line : `${line.slice(0, 157)}…`;
}

/** Codex's "prompt" verdict: ask the user, offering rule and session allowances. */
async function requestApproval(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	state: EngineState,
	evaluation: Evaluation,
	verdict: DeterministicVerdict,
	engine: Engine,
	sessionApprovals: Set<string>,
): Promise<ToolCallEventResult | undefined> {
	const settings = state.settings;
	if (sessionApprovals.has(command)) return;
	if (settings.ask === "never") {
		// Codex rejects a `prompt` verdict outright when the policy forbids
		// prompting; there is no second channel that could grant consent.
		return {
			block: true,
			reason: `Blocked by execution policy (prompting is disabled).\n${verdict.reason ?? ""}`.trimEnd(),
		};
	}
	if (!ctx.hasUI) {
		return {
			block: true,
			reason:
				`Blocked by execution policy: this command requires approval, but no interactive UI is available.\n` +
				`${verdict.reason ?? ""}\n` +
				`Add an allow rule, or approve it from an interactive session.`,
		};
	}
	const amendment = settings.amendRules ? planAmendment(state.policy, evaluation, settings, verdict.source) : undefined;
	const prompt = formatPrompt(command, verdict);
	const labels = [APPROVE_ONCE];
	if (amendment !== undefined) labels.push(`${AMEND_PREFIX} \`${amendment.join(" ")}\``);
	labels.push(SESSION_LABEL, DECLINE, CANCEL);
	// `initialIndex: 0` matches Codex, where the cursor starts on "Yes, proceed".
	const choice = await ctx.ui.select(
		prompt.title,
		labels.map(label => ({ label })),
		{ initialIndex: 0, helpText: prompt.body },
	);
	if (choice === APPROVE_ONCE) return;
	if (choice === SESSION_LABEL) {
		sessionApprovals.add(command);
		return;
	}
	if (choice !== undefined && choice.startsWith(AMEND_PREFIX)) {
		if (amendment === undefined) return;
		try {
			appendRule(settings.amendFile, renderAllowAmendment(amendment, AMEND_JUSTIFICATION));
			engine.invalidate();
			ctx.ui.notify(`execpolicy: allow rule appended to ${settings.amendFile}`, "info");
		} catch (error) {
			return {
				block: true,
				reason:
					`execpolicy: this command needed approval and the allow rule could not be written: ` +
					`${error instanceof Error ? error.message : String(error)}`,
			};
		}
		return;
	}
	pi.logger.debug("execpolicy: command denied by user", { command, cancelled: choice === CANCEL });
	// Codex separates these: "decline" tells the agent to continue without the
	// command, "cancel" tells it to find a different approach. Esc (undefined)
	// is treated as a decline.
	const reason =
		choice === CANCEL
			? `The user cancelled this command and wants a different approach.\nDo not retry it; ask the user what to do differently.\n${verdict.reason ?? ""}`.trimEnd()
			: `The user declined this command.\n${verdict.reason ?? ""}`.trimEnd();
	return { block: true, reason };
}

/**
 * Hand a verdict that needs approval to the model reviewer.
 *
 * The reviewer stands in for the user prompt (Codex's auto-review), so an
 * `allow` runs the command without a dialog and a `deny` blocks it with the
 * rationale. A reviewer that cannot answer falls back to the user.
 */
async function reviewCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	state: EngineState,
	evaluation: Evaluation,
	verdict: DeterministicVerdict,
	engine: Engine,
	sessionApprovals: Set<string>,
): Promise<ToolCallEventResult | undefined> {
	const settings = state.settings;
	if (sessionApprovals.has(command)) return;
	const model = ctx.models.resolve(settings.judgeModel);
	if (model === undefined) {
		pi.logger.warn("execpolicy: judge enabled but no model resolved", { spec: settings.judgeModel });
		return judgeFallback(
			pi,
			ctx,
			command,
			state,
			evaluation,
			verdict,
			engine,
			sessionApprovals,
			"no judge model is available",
		);
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const apiKey = ctx.modelRegistry.resolver(model, sessionId);
	const result = await judgeCommand(
		{
			command,
			cwd: ctx.cwd,
			transcript: renderTranscript(ctx.sessionManager.getEntries()),
			...(state.judgePolicy === undefined ? {} : { policy: state.judgePolicy }),
			signal: AbortSignal.timeout(settings.judgeTimeoutMs),
		},
		{ model, apiKey, sessionId, retries: settings.judgeRetries },
	);
	if (!result.ok) {
		pi.logger.warn("execpolicy: judge unavailable", { kind: result.kind, error: result.error });
		return judgeFallback(pi, ctx, command, state, evaluation, verdict, engine, sessionApprovals, result.error);
	}
	const review = result.verdict;
	if (review.outcome === "allow") {
		// Codex hides guardian-approved executions from history rather than
		// announcing them; a debug line is enough here too.
		pi.logger.debug("execpolicy: review allowed command", {
			command,
			riskLevel: review.riskLevel,
			userAuthorization: review.userAuthorization,
		});
		return;
	}
	ctx.ui.notify(`execpolicy: review denied (${review.riskLevel} risk)`, "warning");
	return {
		block: true,
		reason: [
			"Blocked by execution-policy review.",
			`Risk: ${review.riskLevel}; user authorization: ${review.userAuthorization}.`,
			review.rationale.length > 0 ? `Reason: ${review.rationale}` : "",
			"If this command is genuinely intended, ask the user to confirm it explicitly.",
		]
			.filter(line => line.length > 0)
			.join("\n"),
	};
}

/**
 * The reviewer could not produce a verdict.
 *
 * `allow` runs the command; otherwise the user is asked, and with no UI to ask
 * through the command is refused rather than let through unreviewed. Codex is
 * stricter still and denies outright on an unreadable review, so refusing here
 * is the same posture with a chance to ask first.
 */
async function judgeFallback(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	command: string,
	state: EngineState,
	evaluation: Evaluation,
	verdict: DeterministicVerdict,
	engine: Engine,
	sessionApprovals: Set<string>,
	error: string,
): Promise<ToolCallEventResult | undefined> {
	if (state.settings.judgeOnError === "allow") return;
	if (state.settings.ask === "never" || !ctx.hasUI) {
		return {
			block: true,
			reason: `Blocked by execution policy: this command could not be reviewed (${error}) and no interactive approval is available.`,
		};
	}
	return await requestApproval(pi, ctx, command, state, evaluation, {
		decision: "prompt",
		source: "judge",
		reason: `Automatic review was unavailable (${error}).`,
		blocking: [],
	}, engine, sessionApprovals);
}
