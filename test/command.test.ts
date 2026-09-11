import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { analyzeCommand, splitTopLevel, tokenizePiece } from "../src/command.ts";

describe("splitTopLevel", () => {
	it("splits separators outside quotes", () => {
		assert.deepEqual(splitTopLevel("a && b || c ; d | e"), ["a", "b", "c", "d", "e"]);
		assert.deepEqual(splitTopLevel("echo 'a && b' && ls"), ["echo 'a && b'", "ls"]);
		assert.deepEqual(splitTopLevel('echo "a | b"'), ['echo "a | b"']);
		assert.deepEqual(splitTopLevel("echo $(a && b)"), ["echo $(a && b)"]);
		assert.deepEqual(splitTopLevel("echo `a && b`"), ["echo `a && b`"]);
	});

	it("keeps redirects attached to their segment", () => {
		assert.deepEqual(splitTopLevel("ls > out.txt && cat out.txt"), ["ls > out.txt", "cat out.txt"]);
	});
});

describe("tokenizePiece", () => {
	it("lifts redirect targets out of argv", () => {
		const result = tokenizePiece("ls -la > out.txt 2>> err.txt");
		assert.deepEqual(result.argv, ["ls", "-la"]);
		assert.deepEqual(result.writeTargets, ["out.txt", "err.txt"]);
	});

	it("honours quoting and escapes", () => {
		assert.deepEqual(tokenizePiece(`cat "a b" 'c d' e\\ f`).argv, ["cat", "a b", "c d", "e f"]);
	});

	it("reports an unterminated quote", () => {
		assert.equal(tokenizePiece("cat 'oops").unterminatedQuote, true);
	});
});

describe("analyzeCommand", () => {
	it("decomposes compound commands into segments", () => {
		const analysis = analyzeCommand("cd /repo && git status && rm -rf build");
		assert.deepEqual(
			analysis.segments.map(segment => segment.argv[0]),
			["cd", "git", "rm"],
		);
	});

	it("inlines nested shell -c bodies", () => {
		const analysis = analyzeCommand("bash -c 'git status && rm -rf /tmp/x'");
		assert.deepEqual(
			analysis.segments.map(segment => segment.argv.join(" ")),
			["git status", "rm -rf /tmp/x"],
		);
	});

	it("unwraps launcher wrappers", () => {
		assert.deepEqual(analyzeCommand("sudo -u root rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
		assert.deepEqual(analyzeCommand("env FOO=1 rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
		assert.deepEqual(analyzeCommand("timeout 5 rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
		assert.deepEqual(analyzeCommand("timeout -s KILL 5 rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
		assert.deepEqual(analyzeCommand("busybox rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
	});

	it("drops leading env assignments instead of treating them as the program", () => {
		assert.deepEqual(analyzeCommand("FOO=1 rm -rf /tmp/x").segments[0]!.argv, ["rm", "-rf", "/tmp/x"]);
	});

	it("fails closed past the analysis depth cap", () => {
		const chained = `${"sudo ".repeat(12)}rm -rf /tmp/x`;
		const analysis = analyzeCommand(chained);
		assert.ok(analysis.segments.some(segment => segment.unresolved));
	});

	it("drops heredoc bodies instead of judging them as commands", () => {
		const analysis = analyzeCommand("cat <<EOF\nrm -rf /\nEOF");
		assert.deepEqual(analysis.segments.map(segment => segment.argv), [["cat"]]);
	});

	it("keeps the delimiter out of argv and honours quoting", () => {
		assert.deepEqual(analyzeCommand("python - <<'PY'\nprint(1)\nPY").segments[0]!.argv, ["python", "-"]);
		assert.deepEqual(analyzeCommand(String.raw`bash <<-\'EOF\'` + "\n\trm -rf /x\n\tEOF").segments[0]!.argv, ["bash"]);
	});

	it("still splits separators written after the heredoc operator", () => {
		const analysis = analyzeCommand("cat <<EOF && ls\nbody\nEOF");
		assert.deepEqual(analysis.segments.map(segment => segment.argv), [["cat"], ["ls"]]);
	});

	it("treats a here-string as an argument, since it has no body", () => {
		assert.deepEqual(analyzeCommand("grep x <<< 'a b'").segments[0]!.argv, ["grep", "x"]);
	});

	it("collects write targets across segments", () => {
		const analysis = analyzeCommand("echo hi > a.txt && rm -rf build");
		assert.deepEqual(analysis.writeTargets, ["a.txt"]);
	});
});
