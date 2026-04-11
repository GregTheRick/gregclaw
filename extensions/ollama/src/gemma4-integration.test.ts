import { describe, it, expect } from "vitest";
import { convertToGemma4Format } from "./gemma4-formatter.js";
import { Gemma4Parser } from "./gemma4-parser.js";

describe("gemma4-integration", () => {
  it("formats prompt, parses response thinking, extracts tool call, and formats extension", () => {
    // 1. Initial Format
    const messages = [{ role: "user", content: "What is the capital of France?" }];
    const tools = [
      { name: "search", description: "Search", parameters: { query: "string" } },
    ] as any;

    const { prompt: initialPrompt } = convertToGemma4Format(messages, {
      system: "assistant",
      tools,
    });
    expect(initialPrompt).toContain("<|turn>system\nassistant<|tool>declaration:search{");
    expect(initialPrompt).toContain("<|turn>user\nWhat is the capital of France?");

    // 2. Parser intercepting Ollama response chunks in real time
    const parser = new Gemma4Parser();
    const e1 = parser.push("<|channe");
    const e2 = parser.push("l>thought\nThinking...<chann");
    const e3 = parser.push("el|><|tool_");
    const e4 = parser.push('call>call:search{query:<|"|>Paris<|"|>}<too');
    const e5 = parser.push("l_call|>");

    const allEvents = [...e1, ...e2, ...e3, ...e4, ...e5];

    // Extracted thinking and tool call successfully!
    expect(allEvents.find((e) => e.type === "thinking")?.content).toBe("\nThinking...");

    const toolCallEv = allEvents.find((e) => e.type === "tool_call");
    expect(toolCallEv).toBeDefined();
    expect(toolCallEv?.toolCall?.name).toBe("search");
    expect(toolCallEv?.toolCall?.arguments).toEqual({ query: "Paris" });

    // 3. User responds to tool
    messages.push({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "\nThinking..." },
        { type: "toolCall", name: "search", arguments: { query: "Paris" } },
      ],
    } as any);

    messages.push({
      role: "tool",
      toolName: "search",
      content: JSON.stringify({ result: "Paris is capital." }),
    } as any);

    // 4. Formatting second round (keeps thoughts!)
    const { prompt: loopPrompt } = convertToGemma4Format(messages, { system: "assistant", tools });

    // Ensure it's bundled in one long model turn
    // We check for keywords since meta-escaping adds invisible characters
    // We check for keywords since meta-escaping adds invisible characters
    expect(loopPrompt).toContain("<|channel>thought\n");
    expect(loopPrompt).toContain("Thinking...");
    expect(loopPrompt).toContain("\n<channel|>");
    expect(loopPrompt).toContain('<|tool_call>call:search{query:<|"|>Paris<|"|>}<tool_call|>');
    expect(loopPrompt).toContain(
      '<|tool_response>response:search{result:<|"|>Paris is capital.<|"|>}',
    );

    // And ensure it stays open for the language model to continue without <turn|>
    // It should contain the pre-closed thought channel as per requirement
    expect(loopPrompt).toContain("<tool_response|><|channel>thought\n<channel|>");
  });
});
