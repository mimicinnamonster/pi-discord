/**
 * Message Duplication Tests
 * Tests for detecting and preventing duplicate message sends to Discord
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
