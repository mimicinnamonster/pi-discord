import { describe, it, expect } from "vitest";
import { ChannelSendQueue, withTimeout, DEFAULT_MAX_PENDING_SENDS } from "../src/send-queue.ts";

/** A promise plus its settle functions, so tests control timing exactly. */
function deferred<T = void>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Lets every already-resolved promise callback run. */
async function flush() {
	for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe("ChannelSendQueue", () => {
	it("sends two concurrent enqueues in enqueue order", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];
		const first = deferred();
		const second = deferred();

		const firstSend = queue.enqueue("ch", async () => {
			await first.promise;
			order.push("first");
		}, { droppedResult: undefined });
		const secondSend = queue.enqueue("ch", async () => {
			await second.promise;
			order.push("second");
		}, { droppedResult: undefined });

		// The second send is queued behind the first and must not start.
		await flush();
		expect(order).toEqual([]);

		// Resolving the second first must not let it overtake.
		second.resolve();
		await flush();
		expect(order).toEqual([]);

		first.resolve();
		await Promise.all([firstSend, secondSend]);
		expect(order).toEqual(["first", "second"]);
	});

	it("keeps the chunks of one message atomic against the next message", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];
		const chunkGate = deferred();

		const longMessage = queue.enqueue("ch", async () => {
			order.push("a1");
			await chunkGate.promise;
			order.push("a2");
			order.push("a3");
		}, { droppedResult: undefined });
		const nextMessage = queue.enqueue("ch", async () => {
			order.push("b");
		}, { droppedResult: undefined });

		await flush();
		expect(order).toEqual(["a1"]);

		chunkGate.resolve();
		await Promise.all([longMessage, nextMessage]);
		expect(order).toEqual(["a1", "a2", "a3", "b"]);
	});

	it("lets a slow send delay but never reorder a later one", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];
		const slowUpload = deferred();

		const slow = queue.enqueue("ch", async () => {
			await slowUpload.promise;
			order.push("slow-upload");
		}, { droppedResult: undefined });
		const fast = queue.enqueue("ch", async () => {
			order.push("fast-line");
		}, { droppedResult: undefined });

		await flush();
		expect(order).toEqual([]);

		slowUpload.resolve();
		await Promise.all([slow, fast]);
		expect(order).toEqual(["slow-upload", "fast-line"]);
	});

	it("continues the queue after a failed send and propagates the error", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];

		const failure = queue.enqueue("ch", async () => {
			order.push("first");
			throw new Error("send failed");
		}, { droppedResult: undefined });
		const after = queue.enqueue("ch", async () => {
			order.push("second");
			return "ok";
		}, { droppedResult: "dropped" });

		await expect(failure).rejects.toThrow("send failed");
		await expect(after).resolves.toBe("ok");
		expect(order).toEqual(["first", "second"]);
	});

	it("keeps channels independent", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];
		const blocked = deferred();

		const blockedSend = queue.enqueue("slow-channel", async () => {
			await blocked.promise;
			order.push("slow");
		}, { droppedResult: undefined });
		await flush();
		expect(queue.pendingCount("slow-channel")).toBe(1);

		await queue.enqueue("other-channel", async () => {
			order.push("other");
		}, { droppedResult: undefined });
		expect(order).toEqual(["other"]);

		blocked.resolve();
		await blockedSend;
		expect(order).toEqual(["other", "slow"]);
	});

	it("drops new messages once the channel queue is full and logs it", async () => {
		const logs: string[] = [];
		const queue = new ChannelSendQueue((message) => logs.push(message), 2);
		const gate = deferred();

		const first = queue.enqueue("ch", async () => {
			await gate.promise;
		}, { droppedResult: undefined, label: "response" });
		const second = queue.enqueue("ch", async () => {}, { droppedResult: undefined, label: "tool" });
		const third = queue.enqueue<string[]>(
			"ch",
			async () => ["sent"],
			{ droppedResult: ["dropped"], label: "thinking" }
		);

		// The cap is measured before the item starts running, so the queued second
		// item fills the second slot and the third is refused.
		await expect(third).resolves.toEqual(["dropped"]);
		expect(queue.droppedCount("ch")).toBe(1);
		expect(logs.some((line) => line.includes("send queue full") && line.includes("thinking"))).toBe(true);

		gate.resolve();
		await Promise.all([first, second]);
		expect(queue.pendingCount("ch")).toBe(0);
	});

	it("counts pending messages while they are queued and settles at zero", async () => {
		const queue = new ChannelSendQueue();
		const gate = deferred();

		const send = queue.enqueue("ch", async () => {
			await gate.promise;
		}, { droppedResult: undefined });
		expect(queue.pendingCount("ch")).toBe(1);

		gate.resolve();
		await send;
		expect(queue.pendingCount("ch")).toBe(0);
	});

	it("drains pending sends and forgets the channel state", async () => {
		const queue = new ChannelSendQueue();
		const order: string[] = [];
		const gate = deferred();

		const send = queue.enqueue("ch", async () => {
			await gate.promise;
			order.push("delivered");
		}, { droppedResult: undefined });
		const release = queue.release("ch", 1_000);

		await flush();
		gate.resolve();
		await Promise.all([send, release]);

		expect(order).toEqual(["delivered"]);
		expect(queue.pendingCount("ch")).toBe(0);
	});

	it("drains a channel with no queue immediately", async () => {
		const queue = new ChannelSendQueue();
		await expect(queue.drain("never-used")).resolves.toBe(true);
		await expect(queue.release("never-used")).resolves.toBeUndefined();
		expect(queue.pendingCount("never-used")).toBe(0);
	});

	it("abandons an item that never settles so the channel keeps moving", async () => {
		const queue = new ChannelSendQueue(() => {}, DEFAULT_MAX_PENDING_SENDS, 20);
		const order: string[] = [];
		const stuck = deferred();

		const hung = queue.enqueue("ch", async () => {
			await stuck.promise;
			order.push("never");
		}, { droppedResult: undefined, label: "stuck" });
		const next = queue.enqueue("ch", async () => {
			order.push("next");
			return "ok";
		}, { droppedResult: "dropped" });

		await expect(hung).rejects.toThrow(/did not settle within 20ms/);
		await expect(next).resolves.toBe("ok");
		expect(order).toEqual(["next"]);
	});
});

describe("withTimeout", () => {
	it("resolves with the task value when it settles in time", async () => {
		await expect(withTimeout(Promise.resolve("value"), 50, "label")).resolves.toBe("value");
	});

	it("rejects when the task outlives the budget", async () => {
		await expect(withTimeout(new Promise(() => {}), 15, "label")).rejects.toThrow(/label did not settle within 15ms/);
	});

	it("passes through a disabled budget", async () => {
		await expect(withTimeout(Promise.resolve("value"), 0, "label")).resolves.toBe("value");
	});
});
