import type { Message } from "@mariozechner/pi-ai";
import { describe, it, expect } from "vitest";
import { convertToGTRFormat } from "./gemma4-gtr-formatter.js";

describe("convertToGTRFormat - Thinking Filter", () => {
  it("should remove thinking from a model turn followed by a user turn", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user said hello. I should reply." },
          { type: "text", text: "Hi there!" },
        ],
      },
      { role: "user", content: "How are you?" },
    ];

    const turns = convertToGTRFormat(messages);

    // Turns:
    // 0: System (might be empty/skipped if no system prompt/tools, but convertToGTRFormat returns empty array if no messages)
    // In this case, convertToGTRFormat skips system turn if no options provided.
    // 0: User ("Hello")
    // 1: Model ("Hi there!" - thinking should be GONE)
    // 2: User ("How are you?")

    const modelTurn = turns.find((t) => t.role === "model");
    expect(modelTurn).toBeDefined();
    expect(modelTurn?.components.find((c) => c.ctype === "thinking")).toBeUndefined();
    expect(modelTurn?.components.find((c) => c.ctype === "answer")).toBeDefined();
  });

  it("should NOT remove thinking from the last model turn (no user turn after)", () => {
    const messages: Message[] = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Thinking logic..." },
          { type: "text", text: "Hi!" },
        ],
      },
    ];

    const turns = convertToGTRFormat(messages);

    const modelTurn = turns.find((t) => t.role === "model");
    expect(modelTurn).toBeDefined();
    expect(modelTurn?.components.find((c) => c.ctype === "thinking")).toBeDefined();
    expect(modelTurn?.components.find((c) => c.ctype === "answer")).toBeDefined();
  });

  it("should remove thinking from multiple old model turns", () => {
    const messages: Message[] = [
      { role: "user", content: "A" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "T1" },
          { type: "text", text: "R1" },
        ],
      },
      { role: "user", content: "B" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "T2" },
          { type: "text", text: "R2" },
        ],
      },
      { role: "user", content: "C" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "T3" },
          { type: "text", text: "R3" },
        ],
      },
    ];

    const turns = convertToGTRFormat(messages);

    // Model 1 (followed by User B) -> no thinking
    expect(turns[1].role).toBe("model");
    expect(turns[1].components.find((c) => c.ctype === "thinking")).toBeUndefined();

    // Model 2 (followed by User C) -> no thinking
    expect(turns[3].role).toBe("model");
    expect(turns[3].components.find((c) => c.ctype === "thinking")).toBeUndefined();

    // Model 3 (last turn) -> HAS thinking
    expect(turns[5].role).toBe("model");
    expect(turns[5].components.find((c) => c.ctype === "thinking")).toBeDefined();
  });
});
