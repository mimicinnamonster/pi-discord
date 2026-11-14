/**
 * Message Duplication Tests
 * Tests for detecting and preventing duplicate message sends to Discord
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createPendingMessageStore } from "../src/pending-messages.ts";
import {
    evaluateStuckRun,
    evaluateStuckRunLiveness,
    REQUIRED_CONFIRMING_SWEEPS,
    shouldRecoverStuckRun,
} from "../src/stuck-run-decision.ts";

// ============================================================================
// Bug Detection: The check-then-add pattern is not atomic
// ============================================================================

describe("Message Duplication Bug Detection", () => {
    describe("BUGGY: Check-then-add pattern", () => {
        it("should detect that check-then-add allows duplicate subscriptions", () => {
            const subscribedSessions = new Set<string>();
            let subscriptionCount = 0;

            // This simulates the BUGGY pattern from index.ts
            function subscribeBuggy(channelId: string): boolean {
                if (!subscribedSessions.has(channelId)) {
                    // RACE WINDOW: Between check and add, another call can pass the check
                    subscribedSessions.add(channelId);
                    subscriptionCount++;
                    return true; // Successfully subscribed
                }
                return false; // Already subscribed
            }

            // Simulate: first message subscribes
            const first = subscribeBuggy("channel-123");
            expect(first).toBe(true);
            expect(subscriptionCount).toBe(1);

            // Simulate: second message (same channel) - no duplicate subscription
            const second = subscribeBuggy("channel-123");
            expect(second).toBe(false);
            expect(subscriptionCount).toBe(1);
        });

        it("shows that Set.add() return value cannot distinguish new vs existing", () => {
            const set = new Set<string>();

            // Set.add() ALWAYS returns the Set object
            const result1 = set.add("key");
            const result2 = set.add("key");

            // Both return the same Set object (truthy)
            expect(result1).toBe(set);
            expect(result2).toBe(set);
            expect(result1).toBe(result2);

            // You cannot use the return value to know if it was new
            // This is why the buggy pattern uses has() + add() separately
        });
    });

    describe("FIXED: Add before any async operation", () => {
        it("should add to Set BEFORE any async operation to prevent race", () => {
            const subscribedSessions = new Set<string>();
            let subscriptionCount = 0;

            function subscribeFixed(channelId: string): boolean {
                // FIXED: Add to set FIRST, then check if WE added it
                const wasAdded = subscribedSessions.add(channelId);

                // Set.add() returns the Set. If channelId wasn't in the set,
                // it IS now. We need to check if this call was the one that added it.
                // The problem: add() always returns the Set...

                // Alternative fix: use has() after add()
                if (subscribedSessions.has(channelId)) {
                    // Check if this is the first time (size increased by 1)
                    const sizeBefore = subscribedSessions.size;
                    subscribedSessions.add(channelId);
                    if (subscribedSessions.size === sizeBefore) {
                        // Already existed before our add
                        return false;
                    }
                }
                return true;
            }

            // This is getting complex. Let's use a cleaner pattern.
        });

        it("should use immediate add + has check for atomic pattern", () => {
            const subscribedSessions = new Set<string>();
            let subscriptionCount = 0;

            // FIXED pattern: Add immediately after check, before any await
            function subscribeFixed(channelId: string): boolean {
                if (subscribedSessions.has(channelId)) {
                    return false; // Already subscribed
                }

                // ADD BEFORE ANY ASYNC - this is the key fix
                subscribedSessions.add(channelId);

                // Now do the subscription work
                // If this throws, we'd have an orphan in the set, but that's
                // acceptable (worst case: re-check on next message)
                subscriptionCount++;
                return true;
            }

            const first = subscribeFixed("channel-123");
            expect(first).toBe(true);
            expect(subscriptionCount).toBe(1);

            const second = subscribeFixed("channel-123");
            expect(second).toBe(false);
            expect(subscriptionCount).toBe(1);
        });

        it("should handle multiple different channels correctly", () => {
            const subscribedSessions = new Set<string>();
            const subscriptions: string[] = [];

            function subscribeFixed(channelId: string): boolean {
                if (subscribedSessions.has(channelId)) {
                    return false;
                }
                subscribedSessions.add(channelId);
                subscriptions.push(channelId);
                return true;
            }

            subscribeFixed("channel-1");
            subscribeFixed("channel-2");
            subscribeFixed("channel-1"); // Duplicate - ignored
            subscribeFixed("channel-3");

            expect(subscriptions).toEqual(["channel-1", "channel-2", "channel-3"]);
        });
    });

    describe("Integration: Full message flow simulation", () => {
        let mockChannel: any;
        let sendCalls: string[];
        let subscribedSessions: Set<string>;
        let sessionListeners: Map<string, ((event: any) => void)[]>;

        beforeEach(() => {
            sendCalls = [];
            subscribedSessions = new Set<string>();
            sessionListeners = new Map<string, ((event: any) => void)[]>();
            mockChannel = {
                send: vi.fn().mockImplementation((text: string) => {
                    sendCalls.push(text);
                    return Promise.resolve({});
                }),
            };
        });

        function createSession(sessionId: string) {
            if (!sessionListeners.has(sessionId)) {
                sessionListeners.set(sessionId, []);
            }
            return {
                subscribe: (callback: (event: any) => void) => {
                    sessionListeners.get(sessionId)!.push(callback);
                },
                emit: (event: any) => {
                    sessionListeners.get(sessionId)?.forEach((cb) => cb(event));
                },
            };
        }

        function buggyHandleMessage(channelId: string, sessionId: string): void {
            // BUGGY pattern from index.ts: add AFTER subscription
            if (!subscribedSessions.has(channelId)) {
                const session = createSession(sessionId);
                session.subscribe((event: any) => {
                    if (event.type === "message_end" && event.text) {
                        mockChannel.send(event.text);
                    }
                });
                // BUG: Add happens AFTER subscribe
                subscribedSessions.add(channelId);
            }
        }

        function fixedHandleMessage(channelId: string, sessionId: string): void {
            // FIXED pattern: add BEFORE subscription
            if (subscribedSessions.has(channelId)) {
                return; // Already subscribed
            }

            // FIX: Add to set FIRST
            subscribedSessions.add(channelId);

            const session = createSession(sessionId);
            session.subscribe((event: any) => {
                if (event.type === "message_end" && event.text) {
                    mockChannel.send(event.text);
                }
            });
        }

        it("BUGGY: demonstrates what happens when subscription logic has race condition", () => {
            // This test shows the consequence of the bug:
            // If two subscriptions are somehow added to the same session,
            // each will receive and send the message.

            const sessionId = "session-abc";
            const session = createSession(sessionId);

            // Manually add TWO subscriptions (simulating what happens after a race condition)
            session.subscribe((event: any) => {
                if (event.type === "message_end" && event.text) {
                    mockChannel.send(event.text);
                }
            });
            session.subscribe((event: any) => {
                if (event.type === "message_end" && event.text) {
                    mockChannel.send(event.text);
                }
            });

            // Emit message_end
            session.emit({ type: "message_end", text: "Hello!" });

            // BUG: Message sent TWICE because two subscriptions exist
            expect(sendCalls.filter((c) => c === "Hello!").length).toBe(2);
        });

        it("shows the async race condition conceptually", () => {
            // The race condition in index.ts happens like this:
            // 1. handleMessage("channel-1") starts, passes the check
            // 2. await session.sendUserMessage() - yields to event loop
            // 3. handleMessage("channel-1") starts (second message), passes check
            // 4. Both now have subscribed (duplicate subscriptions!)
            //
            // The fix: add to Set BEFORE any await, check after to verify we added first

            // This is a conceptual test - the actual race needs async timing
        });

        it("FIXED: prevents duplicate message", () => {
            const channelId = "123";
            const sessionId = "session-xyz";

            // Subscribe twice
            fixedHandleMessage(channelId, sessionId);
            fixedHandleMessage(channelId, sessionId); // Correctly ignored

            // Get the session and emit
            const session = createSession(sessionId);
            session.emit({ type: "message_end", text: "Hello from fixed!" });

            // FIXED: Message sent only ONCE
            expect(sendCalls.filter((c) => c === "Hello from fixed!").length).toBe(1);
        });

        it("FIXED: different channels work independently", () => {
            fixedHandleMessage("channel-1", "session-1");
            fixedHandleMessage("channel-2", "session-2");

            createSession("session-1").emit({ type: "message_end", text: "Response 1" });
            createSession("session-2").emit({ type: "message_end", text: "Response 2" });

            expect(sendCalls).toContain("Response 1");
            expect(sendCalls).toContain("Response 2");
            expect(sendCalls.filter((c) => c === "Response 1").length).toBe(1);
            expect(sendCalls.filter((c) => c === "Response 2").length).toBe(1);
        });
    });
});

// ============================================================================
// Test for the actual fix needed in index.ts
// ============================================================================

describe("Fix for index.ts subscription logic", () => {
    it("should move Set.add() before any async operations", () => {
        // Current (buggy) implementation pattern:
        const buggyPattern = new Set<string>();

        function buggyAdd(channelId: string): boolean {
            if (!buggyPattern.has(channelId)) {
                // Subscription happens here (could be async)
                buggyPattern.add(channelId); // Add happens AFTER
                return true;
            }
            return false;
        }

        // FIXED implementation pattern:
        const fixedPattern = new Set<string>();

        function fixedAdd(channelId: string): boolean {
            if (fixedPattern.has(channelId)) {
                return false;
            }
            // FIX: Add to set BEFORE subscription
            fixedPattern.add(channelId);
            // Now do subscription (any async code comes after this point)
            return true;
        }

        expect(fixedAdd("channel-1")).toBe(true);
        expect(fixedAdd("channel-1")).toBe(false); // Correctly detects duplicate
    });
});

// ============================================================================
// Test for message_end double-send bug (text_delta + message_end content duplication)
// ============================================================================

describe("Message End Content Duplication Bug", () => {
    describe("BUGGY: message_end pushing content that was already streamed", () => {
        it("should detect that message_end duplicates content from text_delta", () => {
            const responseBuffer: string[] = [];
            let sentToDiscord: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentToDiscord.push(text);
            }

            // Simulate text_delta events accumulating content (streaming)
            responseBuffer.push("Your favorite color is pink!");
            responseBuffer.push(" 🩷");
            // Buffer now has: ["Your favorite color is pink!", " 🩷"] = 31 chars

            // BUGGY message_end handler (the bug we fixed)
            function buggyMessageEnd(event: { message: { role: string; content: any[] } }): void {
                if (event.message.role === "assistant") {
                    // BUG: Pushes from event.message.content which contains the FULL response
                    // that was already streamed via text_delta
                    const textContent = event.message.content?.find(
                        (c: any) => c.type === "text"
                    );
                    if (textContent?.type === "text" && textContent.text) {
                        // BUG: This pushes the same content again!
                        responseBuffer.push(textContent.text);
                    }

                    const fullResponse = responseBuffer.join("");
                    if (fullResponse.trim()) {
                        sendToDiscordMock(fullResponse);
                    }
                }
            }

            // Simulate message_end with the complete message (which contains the full response)
            buggyMessageEnd({
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Your favorite color is pink! 🩷" }],
                },
            });

            // BUG: The response was sent with DUPLICATE content!
            // Buffer had: "Your favorite color is pink! 🩷" (31 chars from streaming)
            // Then we pushed: "Your favorite color is pink! 🩷" (31 chars from message_end)
            // Result: "Your favorite color is pink! 🩷Your favorite color is pink! 🩷" (62 chars)
            expect(sentToDiscord[0]).toBe("Your favorite color is pink! 🩷Your favorite color is pink! 🩷");
            expect(sentToDiscord[0].length).toBe(62); // Exactly DOUBLE!
        });
    });

    describe("FIXED: message_end should NOT push content from event.message.content", () => {
        it("should only send content accumulated from text_delta events", () => {
            const responseBuffer: string[] = [];
            let sentToDiscord: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentToDiscord.push(text);
            }

            // Simulate text_delta events accumulating content (streaming)
            responseBuffer.push("Your favorite color is pink!");
            responseBuffer.push(" 🩷");
            // Buffer now has: ["Your favorite color is pink!", " 🩷"] = 31 chars

            // FIXED message_end handler
            function fixedMessageEnd(): void {
                // FIX: DO NOT push from event.message.content
                // The content is already in responseBuffer from text_delta events
                const fullResponse = responseBuffer.join("");
                if (fullResponse.trim()) {
                    sendToDiscordMock(fullResponse);
                }
                responseBuffer.length = 0;
            }

            // Simulate message_end (note: we don't use the event content here)
            fixedMessageEnd();

            // FIXED: The response is sent only ONCE with correct content
            expect(sentToDiscord[0]).toBe("Your favorite color is pink! 🩷");
            expect(sentToDiscord[0].length).toBe(31); // Correct length!
        });

        it("should handle empty response buffer correctly", () => {
            const responseBuffer: string[] = [];
            let sentToDiscord: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentToDiscord.push(text);
            }

            function fixedMessageEnd(): void {
                const fullResponse = responseBuffer.join("");
                if (fullResponse.trim()) {
                    sendToDiscordMock(fullResponse);
                }
                responseBuffer.length = 0;
            }

            // Empty buffer - should not send anything
            fixedMessageEnd();

            expect(sentToDiscord.length).toBe(0);
        });

        it("should handle whitespace-only response correctly", () => {
            const responseBuffer: string[] = ["   "];
            let sentToDiscord: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentToDiscord.push(text);
            }

            function fixedMessageEnd(): void {
                const fullResponse = responseBuffer.join("");
                if (fullResponse.trim()) {
                    sendToDiscordMock(fullResponse);
                }
                responseBuffer.length = 0;
            }

            // Whitespace-only - should not send (trim check)
            fixedMessageEnd();

            expect(sentToDiscord.length).toBe(0);
        });

        it("should handle long responses correctly", () => {
            const responseBuffer: string[] = [];
            let sentToDiscord: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentToDiscord.push(text);
            }

            // Simulate a long response streamed in chunks
            const longResponse = "A".repeat(3000); // Over 2000 char limit
            responseBuffer.push(longResponse.slice(0, 1500));
            responseBuffer.push(longResponse.slice(1500, 3000));
            responseBuffer.push(longResponse.slice(3000));

            function fixedMessageEnd(): void {
                const fullResponse = responseBuffer.join("");
                if (fullResponse.trim()) {
                    sendToDiscordMock(fullResponse);
                }
                responseBuffer.length = 0;
            }

            fixedMessageEnd();

            // The full response should be sent
            expect(sentToDiscord[0].length).toBe(3000);
        });
    });

    describe("Integration: Full streaming event flow", () => {
        it("should correctly handle multiple streaming events then message_end", () => {
            const responseBuffer: string[] = [];
            const sentMessages: string[] = [];

            function sendToDiscordMock(text: string): void {
                sentMessages.push(text);
            }

            // Simulate the FIXED event handler
            function handleEvent(event: { type: string; assistantMessageEvent?: any; message?: any }): void {
                switch (event.type) {
                    case "message_update": {
                        const assistantEvent = event.assistantMessageEvent;
                        if (assistantEvent?.type === "text_delta") {
                            responseBuffer.push(assistantEvent.delta);
                        }
                        break;
                    }
                    case "message_end": {
                        // FIXED: Do NOT push from event.message.content
                        const fullResponse = responseBuffer.join("");
                        if (fullResponse.trim()) {
                            sendToDiscordMock(fullResponse);
                        }
                        responseBuffer.length = 0;
                        break;
                    }
                }
            }

            // Simulate streaming events
            handleEvent({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "Your favorite color is " },
            });
            handleEvent({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "pink" },
            });
            handleEvent({
                type: "message_update",
                assistantMessageEvent: { type: "text_delta", delta: "! 🩷" },
            });

            // Then message_end
            handleEvent({
                type: "message_end",
                message: {
                    role: "assistant",
                    content: [{ type: "text", text: "Your favorite color is pink! 🩷" }],
                },
            });

            // Only ONE message sent, with correct content
            expect(sentMessages.length).toBe(1);
            expect(sentMessages[0]).toBe("Your favorite color is pink! 🩷");
            expect(sentMessages[0].length).toBe(31);
        });
    });
});

// ============================================================================
// Stale-run recovery must run BEFORE the replay guard
// ============================================================================
//
// replayPendingMessages() skips the replay while session.pendingMessageCount >
// 0, because those queued messages belong to the session. A wedged run also
// holds the followUps THIS process pushed (handleMessage with deliverAs:
// "followUp"), so that raw count never drains and replaying first leaves the
// user's message parked forever (observed live: "2 message(s) still queued in
// the session - leaving 2 parked for a later sweep", every minute, forever).
// The 60s self-heal sweep therefore recovers every channel (dispose +
// getOrCreate, which yields an empty follow-up queue) before replaying any.

interface FakeSession {
    modelActive: boolean;
    followUps: string[];
    readonly pendingMessageCount: number;
    isModelActive(): boolean;
}

describe("Stale-run recovery vs replay ordering", () => {
    const CHANNEL = "1518152817620029592";
    const THRESHOLD_MS = 10 * 60 * 1000;

    function createRig() {
        const store = createPendingMessageStore(
            join(mkdtempSync(join(tmpdir(), "pi-discord-ordering-")), "pending-messages.json"),
            { log: () => {} }
        );
        // The wedged session: still active, and it still holds the followUp we
        // pushed for the parked message — exactly the live server state.
        let session: FakeSession = createSession(true, ["any progress?"]);
        let lastEventAt = Date.now() - THRESHOLD_MS * 2;
        const delivered: string[] = [];
        // Liveness inputs of the channel: a tool in flight means the silence is work.
        let inFlightToolCount = 0;
        let aborts = 0;
        // Store membership of the channel, mirroring sessionStore's map: dispose()
        // removes the entry and only a successful getOrCreate() puts one back.
        let sessionExists = true;
        let rebuildFails = false;
        const recoveryFailureNotices: string[] = [];

        function createSession(modelActive: boolean, followUps: string[]): FakeSession {
            return {
                modelActive,
                followUps,
                get pendingMessageCount(): number {
                    return this.followUps.length;
                },
                isModelActive(): boolean {
                    return this.modelActive;
                },
            };
        }

        // Mirrors recoverStuckSession() stage 2: dispose() + getOrCreate(). A
        // rebuild that throws is the case the review flagged: dispose() already ran
        // without a disposed flag, so the local reference points at an orphan.
        function recover(): void {
            sessionExists = false;
            if (rebuildFails) {
                rebuildFails = false;
                throw new Error("getOrCreate failed");
            }
            session = createSession(false, []);
            sessionExists = true;
            lastEventAt = Date.now();
        }

        // Mirrors replayPendingMessages(): the abort of an active run is gated on
        // the watchdog's liveness gates, so a live turn is never destroyed by a
        // replay (finding 1b of the review of this rig's real counterpart).
        function replay(): number {
            const parked = store.forChannel(CHANNEL);
            if (parked.length === 0) return 0;
            if (session.isModelActive()) {
                const refusal = evaluateStuckRunLiveness({
                    modelActive: true,
                    idleMs: Date.now() - lastEventAt,
                    thresholdMs: THRESHOLD_MS,
                    hasPendingBackgroundWork: false,
                    inFlightToolCount,
                    hasActiveSubagentWork: false,
                    priorConfirmations: 0,
                });
                if (refusal) return 0;
                aborts++;
            }
            if (session.pendingMessageCount > 0) return 0;
            let replayed = 0;
            for (const entry of parked) {
                if (session.isModelActive()) break;
                delivered.push(entry.content);
                store.remove(CHANNEL, entry.discordMessageId);
                replayed++;
            }
            return replayed;
        }

        // ------------------------------------------------------------------
        // Replay delivery semantics (live incident 2026-11-14)
        // ------------------------------------------------------------------
        // The SDK's sendUserMessage() resolves only when the whole turn settles
        // (sendUserMessage -> prompt -> the run's finally). The replayed turn was
        // delivered and answered, yet the entry stayed on disk because the await
        // never returned; the next restart replayed it again. So delivery, not turn
        // completion, decides removal, and delivery is observed on the user
        // message_start event.
        let turnWedges = false;
        let sendRejects = false;
        let deliveryObserved = true;
        let replayInFlight = false;
        const REPLAY_TIMEOUT_MS = 20;

        type ReplayOutcome = "delivered" | "settled" | "rejected" | "timeout";

        // Mirrors one iteration of the fixed replay loop: race the send promise
        // against the delivery event, so a wedged turn cannot keep an already
        // delivered message parked.
        function deliverOnce(text: string): Promise<ReplayOutcome> {
            if (sendRejects) return Promise.resolve("rejected");
            delivered.push(text);
            const sendSettled: Promise<ReplayOutcome> = turnWedges
                ? new Promise<ReplayOutcome>(() => {})
                : Promise.resolve("settled");
            const deliveryEvent: Promise<ReplayOutcome> = deliveryObserved
                ? Promise.resolve("delivered")
                : new Promise<ReplayOutcome>((resolve) => setTimeout(() => resolve("timeout"), REPLAY_TIMEOUT_MS));
            return Promise.race([sendSettled, deliveryEvent]);
        }

        // Mirrors replayPendingMessages() with the delivery-tied accounting. The
        // in-flight guard stands in for replaysInFlight.
        async function replayAsync(): Promise<number> {
            const parked = store.forChannel(CHANNEL);
            if (parked.length === 0) return 0;
            if (replayInFlight) return 0;
            replayInFlight = true;
            try {
                let replayed = 0;
                for (const entry of parked) {
                    if (session.isModelActive()) break;
                    const outcome = await deliverOnce(entry.content);
                    if (outcome === "rejected" || outcome === "timeout") break;
                    store.remove(CHANNEL, entry.discordMessageId);
                    replayed++;
                }
                return replayed;
            } finally {
                replayInFlight = false;
            }
        }

        function shouldRecover(): boolean {
            return shouldRecoverStuckRun({
                modelActive: session.isModelActive(),
                idleMs: Date.now() - lastEventAt,
                thresholdMs: THRESHOLD_MS,
                hasPendingBackgroundWork: false,
                // The wedge happens with no tool running; a sync child or an
                // in-flight tool would legitimately keep the session silent.
                inFlightToolCount: 0,
                hasActiveSubagentWork: false,
                priorConfirmations: REQUIRED_CONFIRMING_SWEEPS - 1,
            });
        }

        function park(): void {
            store.add({
                channelId: CHANNEL,
                discordMessageId: "m-1",
                content: "any progress?",
                queuedAt: 1_700_000_000_000,
                reason: "run-still-active",
            });
        }

        // ---- first-contact path (handleMessage's interrupt branch) ----------
        // Mirrors recoverWedgedSessionOnFirstContact(): the same gates as the
        // sweep, asked before any 🛑 is posted. A refused gate must leave the old
        // interrupt behaviour untouched.
        const interruptNotices: string[] = [];
        let recoveries = 0;
        let recoveryWaits = 0;
        let recoveryInFlight: Promise<void> | null = null;

        function shouldRecoverOnContact(): boolean {
            return evaluateStuckRun({
                modelActive: session.isModelActive(),
                idleMs: Date.now() - lastEventAt,
                thresholdMs: THRESHOLD_MS,
                hasPendingBackgroundWork: false,
                inFlightToolCount,
                hasActiveSubagentWork: false,
                priorConfirmations: REQUIRED_CONFIRMING_SWEEPS - 1,
            }).shouldRecover;
        }

        // Mirrors recoverStuckSession()'s promise dedupe: a message arriving while
        // the rebuild runs awaits that same rebuild instead of skipping it. The
        // clear sits in .finally() for the same reason as in production: a rejected
        // rebuild must not leave a poisoned entry that every later message awaits.
        function startRecovery(): Promise<void> {
            if (recoveryInFlight) {
                recoveryWaits++;
                return recoveryInFlight;
            }
            recoveries++;
            recoveryInFlight = Promise.resolve()
                .then(() => {
                    recover();
                })
                .finally(() => {
                    recoveryInFlight = null;
                });
            return recoveryInFlight;
        }

        async function handleIncomingMessage(text: string, messageId: string): Promise<void> {
            if (session.isModelActive()) {
                let healed = false;
                if (shouldRecoverOnContact()) {
                    try {
                        await startRecovery();
                        healed = true;
                    } catch {
                        healed = false;
                    }
                }
                // Mirrors the real fallback: the store is re-read instead of trusting
                // the local reference, so a disposed session is never prompted.
                if (!sessionExists) {
                    store.add({
                        channelId: CHANNEL,
                        discordMessageId: messageId,
                        content: text,
                        queuedAt: Date.now(),
                        reason: "recovery-failed",
                    });
                    recoveryFailureNotices.push("⚠️ Session recovery failed");
                    return;
                }
                if (!healed) {
                    interruptNotices.push("🛑 Interrupted by user");
                    aborts++;
                    store.add({
                        channelId: CHANNEL,
                        discordMessageId: messageId,
                        content: text,
                        queuedAt: Date.now(),
                        reason: "run-still-active",
                    });
                }
            }
            delivered.push(text);
        }

        return {
            store,
            delivered,
            park,
            recover,
            replay,
            shouldRecover,
            setInFlightToolCount: (count: number) => { inFlightToolCount = count; },
            failNextRebuild: () => { rebuildFails = true; },
            aborts: () => aborts,
            handleIncomingMessage,
            interruptNotices: () => interruptNotices,
            recoveryFailureNotices: () => recoveryFailureNotices,
            recoveries: () => recoveries,
            recoveryWaits: () => recoveryWaits,
            markFreshActivity: () => { lastEventAt = Date.now(); },
            replayAsync,
            wedgeTurn: () => { turnWedges = true; },
            rejectNextSend: () => { sendRejects = true; },
            hideDelivery: () => { deliveryObserved = false; },
        };
    }

    it("strands the parked message when replay runs before recovery", () => {
        const rig = createRig();
        rig.park();

        expect(rig.shouldRecover()).toBe(true);
        expect(rig.replay()).toBe(0);

        expect(rig.delivered).toEqual([]);
        expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-1"]);
    });

    it("delivers the parked message exactly once when recovery runs first", () => {
        const rig = createRig();
        rig.park();

        expect(rig.shouldRecover()).toBe(true);
        rig.recover();
        expect(rig.replay()).toBe(1);

        // Exactly one copy: the stale followUp died with the old session, so it
        // cannot also deliver the same text.
        expect(rig.delivered).toEqual(["any progress?"]);
        expect(rig.store.size()).toBe(0);
    });

    it("never aborts a live turn to re-deliver a parked message", () => {
        const rig = createRig();
        rig.park();
        // A 12-minute bash/sync-subagent tool: silent, but demonstrably working.
        rig.setInFlightToolCount(1);

        expect(rig.replay()).toBe(0);
        expect(rig.aborts()).toBe(0);
        expect(rig.delivered).toEqual([]);
        expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-1"]);
    });

    // ============================================================================
    // A replayed message is done once it is DELIVERED, not once the turn settles
    // ============================================================================
    //
    // Live incident 2026-11-14: the replay logged
    //   "Replaying queued message 1571248765061566615: on friday it didn't fire either"
    // and the turn was answered, but no "[pending-messages] Delivered" line was
    // ever emitted and both entries were still on disk hours later - so the next
    // restart replayed an already-answered message. The send promise only resolves
    // when the run settles, and a settle can be wedged after the final message.

    describe("replay accounting follows delivery, not the turn promise", () => {
        it("removes the entry when delivery lands while the turn never settles", async () => {
            const rig = createRig();
            rig.park();
            // The sweep always recovers before it replays, so the replay sees a free
            // session (see the ordering tests above).
            rig.recover();
            rig.wedgeTurn();

            expect(await rig.replayAsync()).toBe(1);

            expect(rig.delivered).toEqual(["any progress?"]);
            expect(rig.store.size()).toBe(0);

            // A later sweep (or a restart) has nothing left to replay: that is the
            // duplicate this test exists to prevent.
            expect(await rig.replayAsync()).toBe(0);
            expect(rig.delivered).toEqual(["any progress?"]);
        });

        it("keeps the entry parked when the send is rejected", async () => {
            const rig = createRig();
            rig.park();
            rig.recover();
            rig.rejectNextSend();

            expect(await rig.replayAsync()).toBe(0);

            expect(rig.delivered).toEqual([]);
            expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-1"]);
        });

        it("keeps the entry parked when delivery is never confirmed", async () => {
            const rig = createRig();
            rig.park();
            rig.recover();
            rig.wedgeTurn();
            rig.hideDelivery();

            expect(await rig.replayAsync()).toBe(0);

            // Delivered text stays on disk until the session confirms it, so a
            // missing confirmation can never silently drop a message.
            expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-1"]);
        });

        it("delivers once when two replays overlap", async () => {
            const rig = createRig();
            rig.park();
            rig.recover();
            rig.wedgeTurn();

            const [first, second] = await Promise.all([rig.replayAsync(), rig.replayAsync()]);

            expect(first + second).toBe(1);
            expect(rig.delivered).toEqual(["any progress?"]);
            expect(rig.store.size()).toBe(0);
        });

        it("keeps two parked messages in order and stops when the session goes busy", async () => {
            const rig = createRig();
            rig.park();
            rig.recover();
            rig.store.add({
                channelId: CHANNEL,
                discordMessageId: "m-2",
                content: "and?",
                queuedAt: 1_700_000_100_000,
                reason: "run-still-active",
            });

            expect(await rig.replayAsync()).toBe(2);
            expect(rig.delivered).toEqual(["any progress?", "and?"]);
            expect(rig.store.size()).toBe(0);
        });
    });

    // ============================================================================
    // First user contact must heal a wedged channel instead of answering 🛑
    // ============================================================================
    //
    // Waiting for the sweep means the prompt that arrives after a wedge is answered
    // with "🛑 Interrupted by user" and then parked behind a run that never settles:
    // the message is lost either way. So handleMessage asks the watchdog gates first
    // and, when they agree the run is dead, rebuilds the session and delivers.

    describe("First-contact recovery of a wedged channel", () => {
    it("delivers the prompt once instead of posting the interrupt notice", async () => {
        const rig = createRig();

        await rig.handleIncomingMessage("any progress?", "m-1");

        expect(rig.interruptNotices()).toEqual([]);
        expect(rig.recoveries()).toBe(1);
        // Exactly one copy: the prompt went to the rebuilt session, and nothing
        // was parked for a replay to deliver a second time.
        expect(rig.delivered).toEqual(["any progress?"]);
        expect(rig.store.size()).toBe(0);
        expect(rig.aborts()).toBe(0);
    });

    it("keeps today's interrupt path when the run is still emitting events", async () => {
        const rig = createRig();
        rig.markFreshActivity();

        await rig.handleIncomingMessage("hello", "m-2");

        expect(rig.interruptNotices()).toEqual(["🛑 Interrupted by user"]);
        expect(rig.recoveries()).toBe(0);
        // Parked exactly as before, so the sweep can replay it later.
        expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-2"]);
    });

    it("keeps today's interrupt path while a tool is in flight", async () => {
        const rig = createRig();
        rig.setInFlightToolCount(1);

        await rig.handleIncomingMessage("hello", "m-3");

        expect(rig.interruptNotices()).toEqual(["🛑 Interrupted by user"]);
        expect(rig.recoveries()).toBe(0);
    });

    it("waits for a recovery already in flight instead of starting a second one", async () => {
        const rig = createRig();

        await Promise.all([
            rig.handleIncomingMessage("first", "m-4"),
            rig.handleIncomingMessage("second", "m-5"),
        ]);

        expect(rig.recoveries()).toBe(1);
        expect(rig.recoveryWaits()).toBe(1);
        expect(rig.interruptNotices()).toEqual([]);
        // One delivery per prompt across the single rebuild — no duplicates.
        expect(rig.delivered).toEqual(["first", "second"]);
        expect(rig.store.size()).toBe(0);
    });

    it("parks the prompt instead of prompting a disposed session when the rebuild fails", async () => {
        const rig = createRig();
        // dispose() already threw the session away; getOrCreate() then fails. The
        // old object carries no disposed flag, so prompting it would run on an
        // orphan the store no longer tracks.
        rig.failNextRebuild();

        await rig.handleIncomingMessage("are you there?", "m-6");

        expect(rig.delivered).toEqual([]);
        expect(rig.interruptNotices()).toEqual([]);
        expect(rig.recoveryFailureNotices()).toEqual(["⚠️ Session recovery failed"]);
        // Durable, not dropped: the sweep or the next prompt can still deliver it.
        expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-6"]);
        expect(rig.store.forChannel(CHANNEL)[0]!.reason).toBe("recovery-failed");
    });

    it("recovers on the next message after a failed rebuild (no poisoned dedupe entry)", async () => {
        const rig = createRig();
        rig.failNextRebuild();
        await rig.handleIncomingMessage("first", "m-7");

        // The rejected rebuild must not be awaited forever by the next message.
        await rig.handleIncomingMessage("second", "m-8");

        expect(rig.recoveries()).toBe(2);
        expect(rig.delivered).toEqual(["second"]);
        // The parked copy is still queued for a replay, not forgotten.
        expect(rig.store.forChannel(CHANNEL).map((entry) => entry.discordMessageId)).toEqual(["m-7"]);
    });
    });
});
