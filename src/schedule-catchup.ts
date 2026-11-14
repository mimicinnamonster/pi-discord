import { Cron } from "croner";

/**
 * Catch-up decisions for scheduled cron jobs whose fire time was missed while
 * the bot was down (crash, /kill, deploy restart, laptop off).
 *
 * pi-schedule-prompt persists `nextRun` only *after* a successful fire
 * (scheduler.ts:252-259), so a job that has never fired has no `nextRun` at
 * all. Gating catch-up on `nextRun` therefore makes never-fired jobs
 * permanently un-catchable. The due slots are computed here from the cron
 * expression itself, anchored at `lastRun ?? createdAt`.
 */

/** Never race the extension's own on-time fire: slots count as due only after this. */
export const CATCHUP_GRACE_MS = 60_000;

/** Upper bound on how many past slots we enumerate per job. */
export const MAX_DUE_SLOTS = 50;

export interface ScheduledJobLike {
	id?: string;
	name?: string;
	enabled?: boolean;
	type?: string;
	schedule?: string;
	session?: string;
	description?: string;
	createdAt?: string;
	lastRun?: string;
	nextRun?: string;
}

export type CatchupAnchorSource = "lastRun" | "createdAt" | "none";

export interface CatchupAnchor {
	anchorMs: number | null;
	source: CatchupAnchorSource;
}

export interface CatchupDecision {
	action: "fire" | "none";
	reason: string;
	/** Most recent due slot; catch-up coalesces older missed slots into this one. */
	slot?: Date;
	/** How many slots were missed since the anchor (>= 1 when firing). */
	missedSlots?: number;
	anchor?: CatchupAnchor;
}

export interface DueSlotOptions {
	schedule: string;
	anchorMs: number;
	nowMs: number;
	graceMs?: number;
	maxSlots?: number;
	/** IANA zone for cron evaluation. Defaults to the process timezone, which is
	 * what pi-schedule-prompt's croner instance uses, so both agree. */
	timezone?: string;
}

function parseTimestamp(value: string | undefined): number | null {
	if (!value) return null;
	const ms = new Date(value).getTime();
	return Number.isNaN(ms) ? null : ms;
}

/**
 * Anchor for catch-up: the last successful fire, else when the job was created.
 * Returns `none` when neither is known — firing would be a guess.
 */
export function resolveCatchupAnchor(job: ScheduledJobLike): CatchupAnchor {
	const lastRun = parseTimestamp(job.lastRun);
	if (lastRun !== null) return { anchorMs: lastRun, source: "lastRun" };
	const createdAt = parseTimestamp(job.createdAt);
	if (createdAt !== null) return { anchorMs: createdAt, source: "createdAt" };
	return { anchorMs: null, source: "none" };
}

/**
 * Slots of `schedule` that fall strictly after `anchorMs` and at or before
 * `nowMs - graceMs`, oldest first.
 */
export function computeDueSlots(options: DueSlotOptions): Date[] {
	const { schedule, anchorMs, nowMs, graceMs = CATCHUP_GRACE_MS, maxSlots = MAX_DUE_SLOTS, timezone } = options;
	const cutoff = nowMs - graceMs;
	if (cutoff <= anchorMs) return [];
	let cron: Cron;
	try {
		cron = new Cron(schedule, timezone ? { timezone, paused: true } : { paused: true });
	} catch {
		return [];
	}
	try {
		// previousRuns returns most recent first and never goes past `cutoff`.
		const previous = cron.previousRuns(maxSlots, new Date(cutoff));
		return previous
			.filter((slot) => slot.getTime() > anchorMs)
			.sort((a, b) => a.getTime() - b.getTime());
	} catch {
		return [];
	}
}

/**
 * Decide whether a job should be caught up now.
 *
 * Coalescing: when several slots were missed (bot down for days), only the most
 * recent one fires. Firing every missed slot would dump a burst of stale
 * prompts into the channel; `lastRun` is advanced to the coalesced slot so the
 * same slot can never fire twice.
 */
export function decideCatchup(job: ScheduledJobLike, options: { nowMs: number; graceMs?: number; timezone?: string } ): CatchupDecision {
	const anchor = resolveCatchupAnchor(job);
	if (!job.enabled) return { action: "none", reason: "disabled", anchor };
	if (job.type !== "cron") return { action: "none", reason: "not-cron", anchor };
	if (!job.schedule) return { action: "none", reason: "no-schedule", anchor };
	if (anchor.anchorMs === null) return { action: "none", reason: "no-anchor", anchor };

	const dueSlots = computeDueSlots({
		schedule: job.schedule,
		anchorMs: anchor.anchorMs,
		nowMs: options.nowMs,
		graceMs: options.graceMs,
		timezone: options.timezone,
	});
	if (dueSlots.length === 0) return { action: "none", reason: "not-due", anchor };

	return {
		action: "fire",
		reason: "due",
		slot: dueSlots[dueSlots.length - 1],
		missedSlots: dueSlots.length,
		anchor,
	};
}

/** True when the job is routed to this channel (persisted description format). */
export function jobBelongsToChannel(job: ScheduledJobLike, channelId: string): boolean {
	return job.description?.startsWith(`channel:${channelId}`) === true;
}

/**
 * True when the stored binding differs from the live session id, i.e. a write
 * is required. Equal ids must never be rewritten: the pi-schedule-prompt
 * scheduler arms the cron against the id it loaded, and re-writing the store
 * after that point silently orphans the job (scheduler.ts:61, :205-211).
 */
export function jobNeedsRebind(job: ScheduledJobLike, channelId: string, liveSessionId: string): boolean {
	return jobBelongsToChannel(job, channelId) && job.session !== liveSessionId;
}
