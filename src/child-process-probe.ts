/**
 * Live child-process probe for the stale-run watchdog.
 *
 * Sync subagent runs and process-tool commands are real children of the bot and
 * emit no session event while they run. Before the watchdog disposes a session
 * it asks this module whether any such child is still alive.
 *
 * The probe must never report itself: `ps` is spawned as a direct child of the
 * bot, so its own row satisfies "has a child of the bot". An earlier version
 * used execFile() and could not exclude that row, so it always answered "yes"
 * and made recovery unreachable.
 *
 * Zombie children are ignored for the same reason: a `Z`-state process has
 * already exited, so counting it would pin the watchdog at "a child is alive"
 * forever — the same unreachable-recovery failure from the other direction.
 */

import { spawn } from "child_process";
import { readFileSync } from "fs";

/** One row of `ps -eo pid=,ppid=,stat=,comm=`. */
export interface ProcessRow {
	pid: number;
	ppid: number;
	/** Process state: `S`, `R+`, `Ss`, `Z` for a zombie, … */
	state: string;
	command: string;
}

/**
 * Parse `ps -eo pid=,ppid=,stat=,comm=` output.
 *
 * Malformed rows (blank lines, a header on systems where `=` is ignored, rows
 * truncated by the OS) are skipped rather than aborting the parse: a partially
 * readable table is still better than refusing to recover.
 */
export function parseProcessTable(stdout: string): ProcessRow[] {
	const rows: ProcessRow[] = [];
	for (const line of stdout.split("\n")) {
		// `stat` is a single token; everything after it is the command, which may
		// itself contain spaces.
		const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
		if (!match) continue;
		rows.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			state: match[3],
			command: (match[4] ?? "").trim(),
		});
	}
	return rows;
}

/** A `Z`-state process has already exited; only its exit status is left. */
function isZombie(row: ProcessRow): boolean {
	return row.state.startsWith("Z");
}

/**
 * Live direct children of `parentPid`, minus the probe itself and minus zombies.
 *
 * `ignorePids` carries the pid of the spawned `ps`, `ignoreCommands` its command
 * name — two independent exclusions, because either alone would silently disable
 * the watchdog again if `ps` renamed or re-exec'd itself.
 *
 * Only direct children are reported. A grandchild whose parent already exited is
 * reparented to init and invisible here; that direction is harmless, since this
 * probe is a belt over the event/tool/subagent gate accounting.
 */
export function findChildPids(
	rows: ProcessRow[],
	parentPid: number,
	ignorePids: ReadonlySet<number> = new Set(),
	ignoreCommands: ReadonlySet<string> = new Set()
): number[] {
	const children: number[] = [];
	for (const row of rows) {
		if (row.ppid !== parentPid) continue;
		if (row.pid === parentPid) continue;
		if (isZombie(row)) continue;
		if (ignorePids.has(row.pid)) continue;
		if (ignoreCommands.has(row.command)) continue;
		children.push(row.pid);
	}
	return children.sort((a, b) => a - b);
}

/**
 * State field of a `/proc/<pid>/stat` line: `pid (comm) state ...`.
 *
 * `comm` is the executable name in parentheses and may itself contain spaces
 * and parentheses, so the split is on the *last* `)` rather than the first —
 * otherwise `(/usr/bin/my (odd) name)` would shift every later field.
 */
export function parseProcStatState(stat: string): string | undefined {
	const close = stat.lastIndexOf(")");
	if (close === -1) return undefined;
	const state = stat.slice(close + 1).trim().split(/\s+/)[0];
	return state ? state : undefined;
}

/**
 * Process state from `/proc`, or undefined where there is no procfs.
 *
 * Undefined means "this platform cannot tell us", which callers must not read as
 * "dead": macOS has no `/proc`, and a liveness probe that guessed there would
 * report every live run as finished.
 */
function readProcState(pid: number): string | undefined {
	try {
		return parseProcStatState(readFileSync(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Whether an arbitrary pid is held by a live process.
 *
 * `Signal 0` performs the permission and existence checks without delivering a
 * signal, so this needs no subprocess — the diagnostics that call it run inside
 * a recovery path and must stay cheap.
 *
 * A zombie (`Z`) is *not* live: its pid is still allocated, but the process it
 * names has already exited, and the only thing left is an unreaped exit status.
 * Reporting one as alive is what let a runner that exited without terminalising
 * its status file pin a channel indefinitely, so the state is consulted here.
 *
 * `true` therefore means **not known to be dead** — alive, or a pid whose state
 * could not be classified at all (no procfs, `hidepid`, an unreadable or
 * malformed line, a kill/proc race). Callers already rely on that weaker reading
 * (`subagent-run-store.ts`, `completion-orphans.ts`): a `true` whose state was
 * never classified is not proof of work, only the absence of proof of death.
 */
export function isProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	let exists: boolean;
	try {
		process.kill(pid, 0);
		exists = true;
	} catch (err) {
		// EPERM means the process exists but belongs to another user.
		exists = (err as NodeJS.ErrnoException).code === "EPERM";
	}
	if (!exists) return false;
	return readProcState(pid) !== "Z";
}

/**
 * Pids of this process's live children, excluding the probe's own `ps`.
 *
 * Resolves to an empty list when `ps` is unavailable or slow: the watchdog then
 * falls back to its event/tool/subagent gates, which is the safe direction (an
 * unrecoverable channel is the bug this probe exists to prevent).
 */
export function probeLiveChildProcesses(parentPid: number = process.pid): Promise<number[]> {
	return new Promise((resolve) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (pids: number[]) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve(pids);
		};

		// -eo pid=,ppid=,stat=,comm= is portable across Linux and macOS (bsd ps has no --ppid).
		const child = spawn("ps", ["-eo", "pid=,ppid=,stat=,comm="], { stdio: ["ignore", "pipe", "ignore"] });
		const chunks: Buffer[] = [];
		timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish([]);
		}, 2_000);
		if (typeof timer.unref === "function") timer.unref();

		child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
		child.on("error", () => finish([]));
		child.on("close", () => {
			const probePids = new Set<number>();
			if (typeof child.pid === "number") probePids.add(child.pid);
			const rows = parseProcessTable(Buffer.concat(chunks).toString("utf8"));
			finish(findChildPids(rows, parentPid, probePids, new Set(["ps"])));
		});
	});
}
