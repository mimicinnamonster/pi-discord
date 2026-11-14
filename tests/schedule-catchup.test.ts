import { describe, expect, it } from "vitest";
import {
	CATCHUP_GRACE_MS,
	computeDueSlots,
	decideCatchup,
	jobBelongsToChannel,
	jobNeedsRebind,
	resolveCatchupAnchor,
	type ScheduledJobLike,
} from "../src/schedule-catchup.ts";

const AMSTERDAM = "Europe/Amsterdam";

function job(overrides: Partial<ScheduledJobLike> = {}): ScheduledJobLike {
	return {
		id: "job-1",
		name: "daily-mail-calendar-commute",
		schedule: "0 0 7 * * 1-5",
		enabled: true,
		type: "cron",
		description: "channel:1492621695352045762 - auto",
		createdAt: "2026-11-12T22:54:19Z",
		...overrides,
	};
}

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

describe("catch-up anchor", () => {
	it("prefers lastRun over createdAt", () => {
		const anchor = resolveCatchupAnchor(job({ lastRun: "2026-11-13T06:00:00Z" }));
		expect(anchor.source).toBe("lastRun");
		expect(iso(anchor.anchorMs!)).toBe("2026-11-13T06:00:00.000Z");
	});

	it("falls back to createdAt for a job that has never fired", () => {
		const anchor = resolveCatchupAnchor(job());
		expect(anchor.source).toBe("createdAt");
		expect(iso(anchor.anchorMs!)).toBe("2026-11-12T22:54:19.000Z");
	});

	it("reports none when neither timestamp is usable", () => {
		const anchor = resolveCatchupAnchor(job({ createdAt: undefined, lastRun: undefined }));
		expect(anchor.source).toBe("none");
		expect(anchor.anchorMs).toBeNull();
	});

	it("ignores an unparseable timestamp", () => {
		expect(resolveCatchupAnchor(job({ lastRun: "not-a-date" })).source).toBe("createdAt");
	});
});

describe("due slots", () => {
	it("computes weekday 07:00 Amsterdam slots after the anchor", () => {
		// 2026-11-13 was a Friday; 07:00 Amsterdam == 06:00Z in winter time.
		const slots = computeDueSlots({
			schedule: "0 0 7 * * 1-5",
			anchorMs: Date.parse("2026-11-12T22:54:19Z"),
			nowMs: Date.parse("2026-11-14T12:00:00Z"),
			timezone: AMSTERDAM,
		});
		expect(slots.map((slot) => slot.toISOString())).toEqual(["2026-11-13T06:00:00.000Z"]);
	});

	it("skips weekends", () => {
		const slots = computeDueSlots({
			schedule: "0 0 7 * * 1-5",
			anchorMs: Date.parse("2026-11-13T06:00:00Z"), // Friday's slot already done
			nowMs: Date.parse("2026-11-16T04:00:00Z"), // Monday 05:00Z, before 06:00Z
			timezone: AMSTERDAM,
		});
		expect(slots).toEqual([]);
	});

	it("is empty while the only slot is inside the grace window", () => {
		const slotMs = Date.parse("2026-11-13T06:00:00Z");
		const slots = computeDueSlots({
			schedule: "0 0 7 * * 1-5",
			anchorMs: Date.parse("2026-11-12T22:54:19Z"),
			nowMs: slotMs + CATCHUP_GRACE_MS - 1,
			timezone: AMSTERDAM,
		});
		expect(slots).toEqual([]);
	});

	it("returns slots oldest first and respects the cap", () => {
		const slots = computeDueSlots({
			schedule: "0 0 * * *",
			anchorMs: Date.parse("2026-11-01T00:00:00Z"),
			nowMs: Date.parse("2026-11-14T12:00:00Z"),
			timezone: AMSTERDAM,
			maxSlots: 5,
		});
		expect(slots).toHaveLength(5);
		const times = slots.map((slot) => slot.getTime());
		expect([...times].sort((a, b) => a - b)).toEqual(times);
	});

	it("returns nothing for an invalid cron expression", () => {
		expect(
			computeDueSlots({ schedule: "not a cron", anchorMs: 0, nowMs: Date.now(), timezone: AMSTERDAM }),
		).toEqual([]);
	});

	it("keeps 07:00 local across the DST boundary", () => {
		// 2026-03-29 is the EU spring-forward day: 07:00 Amsterdam is 05:00Z after
		// the switch, 06:00Z before it. Croner must resolve local time, not UTC.
		const slots = computeDueSlots({
			schedule: "0 0 7 * * *",
			anchorMs: Date.parse("2026-03-28T12:00:00Z"),
			nowMs: Date.parse("2026-03-30T12:00:00Z"),
			timezone: AMSTERDAM,
		});
		expect(slots.map((slot) => slot.toISOString())).toEqual([
			"2026-03-29T05:00:00.000Z",
			"2026-03-30T05:00:00.000Z",
		]);
	});
});

describe("catch-up decision", () => {
	const nowMs = Date.parse("2026-11-14T12:00:00Z");

	it("fires a never-fired job from createdAt, with no nextRun present", () => {
		const decision = decideCatchup(job(), { nowMs, timezone: AMSTERDAM });
		expect(decision.action).toBe("fire");
		expect(decision.slot?.toISOString()).toBe("2026-11-13T06:00:00.000Z");
		expect(decision.missedSlots).toBe(1);
	});

	it("coalesces several missed slots into the most recent one", () => {
		const decision = decideCatchup(job({ createdAt: "2026-11-09T22:00:00Z" }), {
			nowMs,
			timezone: AMSTERDAM,
		});
		expect(decision.action).toBe("fire");
		expect(decision.missedSlots).toBeGreaterThan(1);
		expect(decision.slot?.toISOString()).toBe("2026-11-13T06:00:00.000Z");
	});

	it("does not fire again once lastRun covers the slot", () => {
		const decision = decideCatchup(job({ lastRun: "2026-11-13T06:00:00Z", nextRun: "2026-11-16T06:00:00Z" }), {
			nowMs,
			timezone: AMSTERDAM,
		});
		expect(decision.action).toBe("none");
		expect(decision.reason).toBe("not-due");
	});

	it("does not fire on a second sweep after the first fire advanced lastRun", () => {
		const first = decideCatchup(job(), { nowMs, timezone: AMSTERDAM });
		expect(first.action).toBe("fire");
		const second = decideCatchup(job({ lastRun: first.slot!.toISOString() }), {
			nowMs: nowMs + 60_000,
			timezone: AMSTERDAM,
		});
		expect(second.action).toBe("none");
	});

	it("stays quiet for disabled jobs, once jobs, and jobs without a schedule", () => {
		expect(decideCatchup(job({ enabled: false }), { nowMs, timezone: AMSTERDAM }).reason).toBe("disabled");
		expect(decideCatchup(job({ type: "once" }), { nowMs, timezone: AMSTERDAM }).reason).toBe("not-cron");
		expect(decideCatchup(job({ schedule: undefined }), { nowMs, timezone: AMSTERDAM }).reason).toBe("no-schedule");
	});

	it("refuses to guess when there is no anchor at all", () => {
		expect(
			decideCatchup(job({ createdAt: undefined, lastRun: undefined }), { nowMs, timezone: AMSTERDAM }).reason,
		).toBe("no-anchor");
	});
});

describe("job binding", () => {
	it("matches only jobs routed to the channel", () => {
		expect(jobBelongsToChannel(job(), "1492621695352045762")).toBe(true);
		expect(jobBelongsToChannel(job(), "999")).toBe(false);
		expect(jobBelongsToChannel(job({ description: undefined }), "1492621695352045762")).toBe(false);
	});

	it("needs a rebind only when the stored id differs from the live id", () => {
		expect(jobNeedsRebind(job({ session: "old-id" }), "1492621695352045762", "live-id")).toBe(true);
		expect(jobNeedsRebind(job({ session: "live-id" }), "1492621695352045762", "live-id")).toBe(false);
		expect(jobNeedsRebind(job({ session: undefined }), "1492621695352045762", "live-id")).toBe(true);
	});

	it("never rebinds a job that belongs to another channel", () => {
		expect(jobNeedsRebind(job({ session: "other" }), "999", "live-id")).toBe(false);
	});
});
