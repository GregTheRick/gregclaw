import type { Message } from "@mariozechner/pi-ai";
import { describe, it, expect, vi, afterEach } from "vitest";
import { createGemma4StreamFn } from "./gemma4-stream.js";

describe("createGemma4StreamFn - Terminal Conditions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("should terminate the loop immediately when 'done' event is received", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "thinking", content: "Thinking..." }) + "\n"),
        );
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "done", status: "complete" }) + "\n"),
        );
        // No controller.close() here! Simulating an idle connection that stays open.
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }),
    );

    const streamFn = createGemma4StreamFn("http://localhost:11434");
    const assistantStream = streamFn(
      { api: "ollama", provider: "ollama", id: "gemma4", contextWindow: 8192 } as any,
      { messages: [{ role: "user", content: "test" }] as Message[] } as any,
      {},
    );

    const eventPromise = (async () => {
      const events = [];
      for await (const event of assistantStream) {
        events.push(event);
      }
      return events;
    })();

    // This should complete despite the underlying ReadableStream still being "open"
    // because of our new 'break' statement.
    const events = await eventPromise;

    expect(events.map((e) => e.type)).toContain("done");
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("should respect the inactivity timeout if NO data is received", async () => {
    vi.useFakeTimers();

    // A stream that never sends anything
    const stream = new ReadableStream({
      start(_controller) {
        // Just hang
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }),
    );

    const streamFn = createGemma4StreamFn("http://localhost:11434");
    const assistantStream = streamFn(
      { api: "ollama", provider: "ollama", id: "gemma4", contextWindow: 8192 } as any,
      { messages: [{ role: "user", content: "test" }] as Message[] } as any,
      {},
    );

    const eventPromise = (async () => {
      const events = [];
      for await (const event of assistantStream) {
        events.push(event);
      }
      return events;
    })();

    // Advance time to trigger the 120s timeout
    await vi.advanceTimersByTimeAsync(130000);

    const events = await eventPromise;
    expect(events.map((e) => e.type)).toContain("error");
    const errorEvent = events.find((e) => e.type === "error") as any;
    expect(errorEvent.error.errorMessage).toContain("GTR_STREAM_STALL: No data received for 120s");
  });
});

describe("createGemma4StreamFn - Tool Call Parsing", () => {
  it("should filter out 'pid' and '__pid' from tool call arguments", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              type: "tool_call",
              tool_call: {
                name: "get_weather",
                args: [
                  { key: "location", val: '"Berlin"' },
                  { key: "__pid", val: '"1"' },
                ],
              },
            }) + "\n",
          ),
        );
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "done", status: "complete" }) + "\n"),
        );
        controller.close();
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
      }),
    );

    const streamFn = createGemma4StreamFn("http://localhost:11434");
    const assistantStream = streamFn(
      { api: "ollama", provider: "ollama", id: "gemma4", contextWindow: 8192 } as any,
      { messages: [{ role: "user", content: "test" }] as Message[] } as any,
      {},
    );

    const events = [];
    for await (const event of assistantStream) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done") as any;
    expect(doneEvent).toBeDefined();
    const toolCall = doneEvent.message.content.find((c: any) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
    expect(toolCall.arguments).toEqual({ location: "Berlin" });
    expect(toolCall.arguments.__pid).toBeUndefined();
  });
});
