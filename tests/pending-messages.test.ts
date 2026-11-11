import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { createPendingMessageStore, type PendingMessage } from "../src/pending-messages.ts";

function tempStorePath(): string {
	return join(mkdtempSync(join(tmpdir(), "pi-discord-pending-")), "pending-messages.json");
}

function message(overrides: Partial<PendingMessage> = {}): PendingMessage {
	return {
		channelId: "1518152817620029592",
		discordMessageId: "m-1",
		content: "status?",
		queuedAt: 1_700_000_000_000,
		reason: "background-drain",
		...overrides,
	};
}

describe("pending message store", () => {
	it("persists a parked message before it is handed to the SDK", () => {
		const path = tempStorePath();
		const store = createPendingMessageStore(path, { log: () => {} });
		store.add(message());

		const onDisk = JSON.parse(readFileSync(path, "utf-8"));
		expect(onDisk.version).toBe(1);
		expect(onDisk.messages).toHaveLength(1);
		expect(onDisk.messages[0].content).toBe("status?");
	});

	it("survives a restart: a new store on the same file sees parked messages", () => {
		const path = tempStorePath();
		createPendingMessageStore(path, { log: () => {} }).add(message());

		const reloaded = createPendingMessageStore(path, { log: () => {} });
		expect(reloaded.size()).toBe(1);
		expect(reloaded.forChannel("1518152817620029592")[0].discordMessageId).toBe("m-1");
	});

	it("keeps messages parked until they are removed after delivery", () => {
		const path = tempStorePath();
		const store = createPendingMessageStore(path, { log: () => {} });
		store.add(message({ discordMessageId: "m-1", content: "hello?" }));
		store.add(message({ discordMessageId: "m-2", content: "status?" }));

		expect(store.remove("1518152817620029592", "m-1")).toBe(true);
		expect(store.forChannel("1518152817620029592").map((entry) => entry.discordMessageId)).toEqual(["m-2"]);

		// Removal is durable, so a restart does not re-deliver an answered message.
		const reloaded = createPendingMessageStore(path, { log: () => {} });
		expect(reloaded.forChannel("1518152817620029592").map((entry) => entry.discordMessageId)).toEqual(["m-2"]);
	});

	it("ignores removal of an unknown message", () => {
		const store = createPendingMessageStore(tempStorePath(), { log: () => {} });
		expect(store.remove("1518152817620029592", "never-parked")).toBe(false);
	});

	it("de-duplicates a repeated park of the same Discord message", () => {
		const store = createPendingMessageStore(tempStorePath(), { log: () => {} });
		store.add(message({ content: "first" }));
		store.add(message({ content: "second" }));
		expect(store.size()).toBe(1);
		expect(store.all()[0].content).toBe("second");
	});

	it("keeps channels separate", () => {
		const store = createPendingMessageStore(tempStorePath(), { log: () => {} });
		store.add(message({ channelId: "chan-a", discordMessageId: "a-1" }));
		store.add(message({ channelId: "chan-b", discordMessageId: "b-1" }));
		expect(store.forChannel("chan-a")).toHaveLength(1);
		expect(store.all()).toHaveLength(2);
	});

	it("starts empty instead of throwing when the file is corrupt", () => {
		const path = tempStorePath();
		writeFileSync(path, "{ not json");
		const logs: string[] = [];
		const store = createPendingMessageStore(path, { log: (line) => logs.push(line) });
		expect(store.size()).toBe(0);
		expect(logs.some((line) => line.includes("Failed to read"))).toBe(true);
	});

	it("drops malformed entries but keeps valid ones", () => {
		const path = tempStorePath();
		writeFileSync(
			path,
			JSON.stringify({ version: 1, messages: [{ channelId: "c", discordMessageId: "d", content: "ok" }, { nope: true }] })
		);
		const store = createPendingMessageStore(path, { log: () => {} });
		expect(store.size()).toBe(1);
		expect(store.all()[0].content).toBe("ok");
	});
});
