/**
 * Child-process probe tests.
 *
 * The probe decides whether the stale-run watchdog may destroy a session, and an
 * earlier implementation always answered "a child is alive" because it could not
 * exclude the `ps` process it spawned itself — which silently disabled recovery
 * in production. The mirror-image failure is a zombie child, which also answers
 * "a child is alive" while doing no work. The parser is therefore tested
 * directly, including both of those rows, plus one real probe against a spawned
 * child.
 */

import { spawn, type ChildProcess } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { findChildPids, isProcessAlive, parseProcessTable, probeLiveChildProcesses } from "../src/child-process-probe.ts";

const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const child of spawned.splice(0)) child.kill("SIGKILL");
});

describe("parseProcessTable", () => {
	it("parses pid, ppid, state and command from ps output", () => {
		const rows = parseProcessTable("  120   1 Ss node\n  121 120 R+ ps\n");
		expect(rows).toEqual([
			{ pid: 120, ppid: 1, state: "Ss", command: "node" },
			{ pid: 121, ppid: 120, state: "R+", command: "ps" },
		]);
	});

	it("keeps commands that contain spaces", () => {
		const rows = parseProcessTable("  300   1 Ss /Applications/Some App Helper\n");
		expect(rows).toEqual([
			{ pid: 300, ppid: 1, state: "Ss", command: "/Applications/Some App Helper" },
		]);
	});

	it("skips malformed rows instead of throwing", () => {
		expect(parseProcessTable("\n  PID  PPID STAT COMMAND\nbroken\n  7   8 S sleep\n")).toEqual([
			{ pid: 7, ppid: 8, state: "S", command: "sleep" },
		]);
	});
});

describe("findChildPids", () => {
	const SELF = 1000;

	it("reports direct children only", () => {
		const rows = parseProcessTable(`1001 ${SELF} S node\n1002 1001 S sh\n999 ${SELF} R ps\n`);
		expect(findChildPids(rows, SELF)).toEqual([999, 1001]);
	});

	it("reports a running child", () => {
		const rows = parseProcessTable(`1001 ${SELF} S node\n1002 ${SELF} R+ node\n`);
		expect(findChildPids(rows, SELF)).toEqual([1001, 1002]);
	});

	it("ignores zombie children", () => {
		// A `Z` child has already exited, so counting it would make the watchdog
		// refuse recovery forever — the inverse of the wedge it exists to clear.
		const rows = parseProcessTable(`1001 ${SELF} Z node\n1002 ${SELF} Z+ node\n`);
		expect(findChildPids(rows, SELF)).toEqual([]);
	});

	it("still reports live children next to a zombie", () => {
		const rows = parseProcessTable(`1001 ${SELF} Z node\n1002 ${SELF} S node\n`);
		expect(findChildPids(rows, SELF)).toEqual([1002]);
	});

	it("excludes the probe's own ps row by pid", () => {
		// The 1a regression: `ps` is a direct child of the bot and lists itself, so
		// without this exclusion the probe is unconditionally true.
		const rows = parseProcessTable(`1001 ${SELF} R ps\n`);
		expect(findChildPids(rows, SELF, new Set([1001]))).toEqual([]);
	});

	it("excludes the probe's own ps row by command as well", () => {
		const rows = parseProcessTable(`1001 ${SELF} R ps\n1002 ${SELF} S node\n`);
		expect(findChildPids(rows, SELF, new Set(), new Set(["ps"]))).toEqual([1002]);
	});

	it("never reports the parent itself", () => {
		const rows = parseProcessTable(`${SELF} ${SELF} Ss node\n`);
		expect(findChildPids(rows, SELF)).toEqual([]);
	});
});

describe("probeLiveChildProcesses", () => {
	it("finds a real child and never reports its own ps helper", async () => {
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		spawned.push(child);
		await new Promise<void>((resolve) => child.once("spawn", () => resolve()));

		const first = await probeLiveChildProcesses();
		const second = await probeLiveChildProcesses();

		expect(first).toContain(child.pid);
		expect(second).toContain(child.pid);
		// A leaked `ps` row would show up as a brand-new pid on every probe.
		expect(second.filter((pid) => !first.includes(pid))).toEqual([]);
	});
});

describe("isProcessAlive", () => {
	it("reports this process as alive", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
	});

	it("reports an invalid pid as dead instead of throwing", () => {
		expect(isProcessAlive(0)).toBe(false);
		expect(isProcessAlive(-1)).toBe(false);
	});

	it("reports a child as alive while it runs and dead after it is reaped", async () => {
		const child = spawn("sleep", ["30"], { stdio: "ignore" });
		spawned.push(child);
		await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
		const pid = child.pid;
		expect(pid).toBeTypeOf("number");
		expect(isProcessAlive(pid as number)).toBe(true);

		const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		child.kill("SIGKILL");
		await exited;
		// A zombie still holds the pid, so spin briefly rather than asserting instantly.
		for (let attempt = 0; attempt < 50 && isProcessAlive(pid as number); attempt += 1) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		expect(isProcessAlive(pid as number)).toBe(false);
	});
});
