/**
 * Durable record of background completions already woken by the orphan watchdog.
 *
 * The wake is a prompt injected into a channel with no user message behind it,
 * so a restart in the wrong place would post the same completion twice. The
 * transcript alone cannot prevent that: the wake prompt is sent before the bot's
 * turn writes its first record, so a crash in that window leaves the transcript
 * looking untouched and the sweep would wake again.
 *
 * Keys are one per completion (`notify:<epochMs>` or `run:<runId>`), and entries
 * are pruned by age so the file cannot grow without bound.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";

export const ORPHAN_WAKES_FILE = "orphan-wakes.json";

/** How long a wake is remembered. Long enough to outlive any restart loop. */
export const ORPHAN_WAKE_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface OrphanWakeFile {
	version: 1;
	/** Idempotency key -> epoch ms the wake was sent. */
	wakes: Record<string, number>;
}

export interface OrphanWakeStore {
	has(key: string): boolean;
	mark(key: string, at?: number): void;
	size(): number;
}

export interface OrphanWakeStoreOptions {
	now?: () => number;
	log?: (message: string) => void;
	retentionMs?: number;
}

export function createOrphanWakeStore(
	filePath: string,
	options: OrphanWakeStoreOptions = {}
): OrphanWakeStore {
	const now = options.now ?? (() => Date.now());
	const log = options.log ?? ((message: string) => console.log(message));
	const retentionMs = options.retentionMs ?? ORPHAN_WAKE_RETENTION_MS;
	let wakes = load();

	function load(): Record<string, number> {
		try {
			if (!existsSync(filePath)) return {};
			const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as Partial<OrphanWakeFile>;
			const raw = parsed?.wakes;
			if (typeof raw !== "object" || raw === null) return {};
			const entries = Object.entries(raw).filter(
				(entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])
			);
			return Object.fromEntries(entries);
		} catch (error) {
			// A corrupt file must not stop the bot; worst case one completion is
			// re-announced once, which is far better than refusing to start.
			log(`[orphan-wakes] Failed to read ${filePath}: ${error}`);
			return {};
		}
	}

	function persist(): void {
		try {
			const payload: OrphanWakeFile = { version: 1, wakes };
			mkdirSync(dirname(filePath), { recursive: true });
			const tmpPath = `${filePath}.tmp`;
			writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
			renameSync(tmpPath, filePath);
		} catch (error) {
			log(`[orphan-wakes] Failed to write ${filePath}: ${error}`);
		}
	}

	function prune(at: number): void {
		const cutoff = at - retentionMs;
		let changed = false;
		for (const [key, sentAt] of Object.entries(wakes)) {
			if (sentAt < cutoff) {
				delete wakes[key];
				changed = true;
			}
		}
		if (changed) persist();
	}

	return {
		has(key: string): boolean {
			return key in wakes;
		},

		mark(key: string, at: number = now()): void {
			if (key in wakes) return;
			wakes[key] = at;
			persist();
			prune(at);
		},

		size(): number {
			return Object.keys(wakes).length;
		},
	};
}
