/**
 * Idempotency store for orphan-completion wakes.
 *
 * The wake is a prompt with no user message behind it, so waking twice posts the
 * same report twice. The store is what makes that impossible across restarts, and
 * these tests pin the two properties that matter: a key can only be recorded
 * once, and a corrupt file cannot stop the bot from starting.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createOrphanWakeStore, ORPHAN_WAKE_RETENTION_MS } from "../src/orphan-wake-store.ts";

function storePath(): string {
	return join(mkdtempSync(join(tmpdir(), "orphan-wakes-")), "orphan-wakes.json");
}

describe("orphan wake store", () => {
	it("remembers a key across instances (a restart cannot re-wake)", () => {
		const path = storePath();
		createOrphanWakeStore(path, { now: () => 1_000 }).mark("notify:123");

		const reopened = createOrphanWakeStore(path);
		expect(reopened.has("notify:123")).toBe(true);
		expect(reopened.has("notify:999")).toBe(false);
	});

	it("keeps the first timestamp when the same key is marked again", () => {
		const path = storePath();
		const store = createOrphanWakeStore(path, { now: () => 1_000 });
		store.mark("run:abc");
		const second = createOrphanWakeStore(path, { now: () => 5_000 });
		second.mark("run:abc");

		const raw = JSON.parse(readFileSync(path, "utf-8")) as { wakes: Record<string, number> };
		expect(raw.wakes["run:abc"]).toBe(1_000);
	});

	it("prunes entries past the retention window", () => {
		const path = storePath();
		const store = createOrphanWakeStore(path, { now: () => 1_000 });
		store.mark("old:1");
		store.mark("old:2", 1_000);

		const later = createOrphanWakeStore(path, { now: () => 1_000 + ORPHAN_WAKE_RETENTION_MS + 1 });
		later.mark("fresh:1");
		expect(later.has("old:1")).toBe(false);
		expect(later.has("fresh:1")).toBe(true);
	});

	it("starts empty instead of throwing on a corrupt file", () => {
		const path = storePath();
		writeFileSync(path, "{not json");
		const messages: string[] = [];
		const store = createOrphanWakeStore(path, { log: (message) => messages.push(message) });

		expect(store.size()).toBe(0);
		expect(messages.some((message) => message.includes("Failed to read"))).toBe(true);
	});

	it("writes atomically, leaving no temp file behind", () => {
		const path = storePath();
		createOrphanWakeStore(path, { now: () => 1_000 }).mark("notify:1");
		expect(() => readFileSync(`${path}.tmp`)).toThrow();
	});
});
