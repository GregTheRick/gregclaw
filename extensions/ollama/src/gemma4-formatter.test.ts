import { describe, it, expect } from "vitest";
import {
  convertToGemma4Format,
  formatGemmaToolDeclarations,
  stringifyGemma,
} from "./gemma4-formatter.js";

describe("gemma4-formatter", () => {
  describe("stringifyGemma", () => {
    it("wraps strings in gemma delimiters", () => {
      expect(stringifyGemma("London")).toBe('<|"|>London<|"|>');
    });

    it("handles numbers and booleans", () => {
      expect(stringifyGemma(15)).toBe("15");
      expect(stringifyGemma(true)).toBe("true");
    });

    it("handles arrays", () => {
      expect(stringifyGemma(["a", "b"])).toBe('[<|"|>a<|"|>,<|"|>b<|"|>]');
    });

    it("handles objects without quoting keys", () => {
      expect(stringifyGemma({ location: "London", temp: 15 })).toBe(
        '{location:<|"|>London<|"|>,temp:15}',
      );
    });
  });

  describe("convertToGemma4Format", () => {
    it("formats a basic user-model turn", () => {
      const messages = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
      const result = convertToGemma4Format(messages, { system: "You are a bot" });
      expect(result).toBe(
        "<bos><|turn>system\nYou are a bot<turn|>\n<|turn>user\nHello<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
      );
    });

    it("trims system prompt", () => {
      const messages = [{ role: "user", content: "Hi" }];
      const result = convertToGemma4Format(messages, { system: "  Trim me  " });
      expect(result).toContain("<|turn>system\nTrim me<turn|>\n");
    });

    it("preserves leading whitespaces inside the system prompt but trims edges", () => {
      const messages = [{ role: "user", content: "Hi" }];
      // Note: Outer trim() will remove the leading spaces if they are at the very start of the system string
      const result = convertToGemma4Format(messages, { system: "\n  Indented system prompt\n" });
      expect(result).toContain("<|turn>system\nIndented system prompt<turn|>");
    });

    it("formats a model turn with thinking", () => {
      const messages = [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I should say hello" },
            { type: "text", text: "Hello there" },
          ],
        },
      ];
      // preserveAllThoughts=true because it is the last message
      const result = convertToGemma4Format(messages, { thinkActive: true });

      // Since assistant response is the last message without a tool call,
      // it should remain open if we expect the model to maybe stop? No, our logic says if it's the last message,
      // we only close it if hasToolCallsHere is false AND isLastMessage is false.
      // Wait, isLastMessage is true, so it does NOT close with <turn|>.
      expect(result).toContain("<|channel>thought\nI should say hello\n<channel|>Hello there");
    });

    it("preserves leading and trailing whitespaces in thinking content", () => {
      const messages = [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "  indented thought  " },
            { type: "text", text: "Ok" },
          ],
        },
      ];
      const result = convertToGemma4Format(messages, { thinkActive: true });
      expect(result).toContain("<|channel>thought\nindented thought\n<channel|>");
    });

    it("formats parallel multi tool calls with PID injection", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "get_weather",
              id: "call_abc1",
              arguments: { loc: "London" },
            },
            { type: "toolCall", name: "get_weather", id: "call_abc2", arguments: { loc: "Paris" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "call_abc1",
          toolName: "get_weather",
          content: JSON.stringify({ temp: 15 }),
        },
        {
          role: "toolResult",
          toolCallId: "call_abc2",
          toolName: "get_weather",
          content: JSON.stringify({ temp: 20 }),
        },
      ];

      const result = convertToGemma4Format(messages, { thinkActive: true });
      expect(result).toContain(
        '<|tool_call>call:get_weather{loc:<|"|>London<|"|>,_pid:<|"|>call_abc1<|"|>}<tool_call|>',
      );
      expect(result).toContain(
        '<|tool_call>call:get_weather{loc:<|"|>Paris<|"|>,_pid:<|"|>call_abc2<|"|>}<tool_call|>',
      );
      expect(result).toContain(
        '<|tool_response>response:get_weather{_pid:<|"|>call_abc1<|"|>,temp:15}<tool_response|>',
      );
      expect(result).toContain(
        '<|tool_response>response:get_weather{_pid:<|"|>call_abc2<|"|>,temp:20}<tool_response|>',
      );
    });

    it("formats tool calls and responses", () => {
      const messages = [
        {
          role: "user",
          content: "Weather in London?",
        },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I need to call a tool" },
            {
              type: "toolCall",
              id: "call_999",
              name: "get_weather",
              arguments: { location: "London" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_999",
          toolName: "get_weather",
          content: JSON.stringify({ temp: 15 }),
        },
      ];

      const result = convertToGemma4Format(messages, { thinkActive: true });

      // Should not contain <turn|> for the assistant/tool loop
      // Should contain the thoughts because it's part of a tool loop
      expect(result).toContain("<|turn>model\n");
      expect(result).toContain("<|channel>thought\nI need to call a tool\n<channel|>");
      expect(result).toContain(
        '<|tool_call>call:get_weather{location:<|"|>London<|"|>,_pid:<|"|>call_999<|"|>}<tool_call|>',
      );
      expect(result).toContain(
        '<|tool_response>response:get_weather{_pid:<|"|>call_999<|"|>,temp:15}<tool_response|>',
      );
      // should still be open for model generation
      expect(result.endsWith("<tool_response|>")).toBe(true);
    });

    it("strips thoughts from previous turns but preserves them in the current turn", () => {
      const messages = [
        { role: "user", content: "Turn 1" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Old thought" },
            { type: "text", text: "Old response" },
          ],
        },
        { role: "user", content: "Turn 2" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "New thought" },
            { type: "toolCall", id: "call_99", name: "func", arguments: {} },
          ],
        },
        { role: "toolResult", toolCallId: "call_99", toolName: "func", content: "Res" },
      ];

      const result = convertToGemma4Format(messages, { thinkActive: true });

      // Should not contain the old thought
      expect(result).not.toContain("Old thought");
      // Current turn reasoning is still technical
      expect(result).toContain("<|channel>thought\nNew thought\n<channel|>");
    });

    it("humanizes historical thoughts when keepThoughts is active", () => {
      const messages = [
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Thought 1" },
            { type: "text", text: "Answer 1" },
          ],
        },
        { role: "user", content: "Q2" },
      ];

      const result = convertToGemma4Format(messages, {
        thinkActive: true,
        preserveAllThoughts: true,
      });

      expect(result).toContain(
        "These are my thoughts:\nThought 1\n... I think I am done thinking.",
      );
      expect(result).not.toContain("<|channel>thought\nThought 1\n<channel|>");
    });

    it("humanizes reasoning embedded in historical text content", () => {
      const messages = [
        { role: "user", content: "Q1" },
        {
          role: "assistant",
          content: "Answer <|channel>thought\nEmbedded reasoning\n<channel|> Final",
        },
        { role: "user", content: "Q2" },
      ];

      const result = convertToGemma4Format(messages, {
        thinkActive: true,
        preserveAllThoughts: true,
      });

      expect(result).toContain(
        "Answer\nThese are my thoughts:\nEmbedded reasoning\n... I think I am done thinking.\nFinal",
      );
      expect(result).not.toContain("<|channel>thought");
    });

    it("reorders parallel tool responses to strictly match tool calls order", () => {
      const messages = [
        {
          role: "assistant",
          content: [
            { type: "toolCall", id: "call_alpha", name: "func_A", arguments: {} },
            { type: "toolCall", id: "call_beta", name: "func_B", arguments: {} },
            { type: "toolCall", id: "call_gamma", name: "func_C", arguments: {} },
          ],
        },
        // Pi-Agent resolves out of order and appends to context chronologically
        {
          role: "toolResult",
          toolCallId: "call_gamma",
          toolName: "func_C",
          content: JSON.stringify({ res: 3 }),
        },
        {
          role: "toolResult",
          toolCallId: "call_alpha",
          toolName: "func_A",
          content: JSON.stringify({ res: 1 }),
        },
        {
          role: "toolResult",
          toolCallId: "call_beta",
          toolName: "func_B",
          content: JSON.stringify({ res: 2 }),
        },
      ];

      const out = convertToGemma4Format(messages, { thinkActive: true });

      // Expected tool_response sequence should perfectly match Alpha, Beta, Gamma chronological output strings
      const expectedOutput =
        '<|tool_call>call:func_A{_pid:<|"|>call_alpha<|"|>}<tool_call|>' +
        '<|tool_call>call:func_B{_pid:<|"|>call_beta<|"|>}<tool_call|>' +
        '<|tool_call>call:func_C{_pid:<|"|>call_gamma<|"|>}<tool_call|>' +
        '<|tool_response>response:func_A{_pid:<|"|>call_alpha<|"|>,res:1}<tool_response|>' +
        '<|tool_response>response:func_B{_pid:<|"|>call_beta<|"|>,res:2}<tool_response|>' +
        '<|tool_response>response:func_C{_pid:<|"|>call_gamma<|"|>,res:3}<tool_response|>';

      expect(out.replace(/\s+/g, "")).toContain(expectedOutput);
    });

    it("does not close and reopen model turn when continuing from tool response", () => {
      const messages = [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "tool1", id: "t1", arguments: {} }],
        },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "tool1",
          content: "Result 1",
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", name: "tool2", id: "t2", arguments: {} }],
        },
      ];

      const result = convertToGemma4Format(messages, { thinkActive: true });

      // We expect ONE model turn opening and NO intermediate turn closings
      const matches = result.match(/<\|turn>model/g);
      expect(matches?.length).toBe(1);
      expect(result).not.toContain("<tool_response|><turn|>\n<|turn>model\n<|tool_call>");
    });

    it("keeps thoughts in the current turn even if thinkActive is false", () => {
      const messages = [
        { role: "user", content: "Do something" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "I am thinking" },
            { type: "toolCall", name: "tool1", id: "t1", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "tool1",
          content: "Result 1",
        },
      ];

      const result = convertToGemma4Format(messages, { thinkActive: false });

      expect(result).toContain("<|channel>thought\nI am thinking\n<channel|>");
    });
  });

  describe("Google Documentation Examples", () => {
    it("matches basic dialogue example", () => {
      const result = convertToGemma4Format([{ role: "user", content: "Hello." }], {
        system: "You are a helpful assistant.",
        thinkActive: false,
      });

      expect(result).toBe(
        "<bos><|turn>system\nYou are a helpful assistant.<turn|>\n<|turn>user\nHello.<turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
      );
    });

    it("matches reasoning and function calling example exactly", () => {
      const tools = [
        {
          name: "get_current_weather",
          description: "Gets the weather",
          parameters: {
            type: "object",
            properties: {
              location: {
                type: "string",
                description: "Where to get the weather",
              },
            },
            required: ["location"],
          },
        },
      ] as any;
      const messages = [
        { role: "user", content: "What's the temperature in London?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            {
              type: "toolCall",
              id: "call_abc1",
              name: "get_current_weather",
              arguments: { location: "London" },
            },
          ],
        },
        {
          role: "tool",
          toolCallId: "call_abc1",
          toolName: "get_current_weather",
          content: JSON.stringify({ temperature: 15, weather: "sunny" }),
        },
      ];

      const result = convertToGemma4Format(messages, {
        system: "You are a helpful assistant.",
        tools,
        thinkActive: true,
      });

      expect(result).toContain(
        `<|tool>declaration:get_current_weather{\ndescription:<|"|>Gets the weather<|"|>,\nparameters:{\nproperties:{\nlocation:{description:<|"|>Where to get the weather<|"|>,type:<|"|>STRING<|"|>}\n},\nrequired:[<|"|>location<|"|>],\ntype:<|"|>OBJECT<|"|>\n}\n}<tool|>`,
      );
      expect(result).toContain("<|turn>user\nWhat's the temperature in London?<turn|>");
      expect(result).toContain(
        '<|turn>model\n<|channel>thought\n...\n<channel|><|tool_call>call:get_current_weather{location:<|"|>London<|"|>,_pid:<|"|>call_abc1<|"|>}<tool_call|><|tool_response>response:get_current_weather{_pid:<|"|>call_abc1<|"|>,temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>',
      );
    });
    it("matches basic thinking example exactly", () => {
      const messages = [
        { role: "user", content: "What is the water formula?" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "..." },
            {
              type: "text",
              text: 'The most common interpretation of "the water formula" refers...',
            },
          ],
        },
      ];

      const result = convertToGemma4Format(messages, { system: "", thinkActive: true });
      // The formatter leaves the last assistant message open for pre-fill, so it lacks the trailing <turn|>\n.
      expect(result).toBe(
        '<bos><|turn>system\n<|think|><turn|>\n<|turn>user\nWhat is the water formula?<turn|>\n<|turn>model\n<|channel>thought\n...\n<channel|>The most common interpretation of "the water formula" refers...',
      );
    });

    it("matches multimodal dialogue example exactly", () => {
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image: " },
            { type: "image", image: "base64..." },
            { type: "text", text: "\n\nAnd translate these audio:\n\na. " },
            { type: "audio", audio: "base64..." },
            { type: "text", text: "\nb. " },
            { type: "audio", audio: "base64..." },
          ],
        },
      ];

      const result = convertToGemma4Format(messages);
      expect(result).toBe(
        "<bos><|turn>user\nDescribe this image: \n\n<|image|>\n\n\n\nAnd translate these audio:\n\na. \n\n<|audio|>\n\n\nb. \n\n<|audio|><turn|>\n<|turn>model\n<|channel>thought\n<channel|>",
      );
    });
  });

  describe("formatGemmaToolDeclarations", () => {
    it("uppercases type values", () => {
      const tools = [
        {
          name: "greet",
          description: "Say hello",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "The name" },
            },
            required: ["name"],
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      expect(out).toContain(`type:<|"|>STRING<|"|>`);
      expect(out).toContain(`type:<|"|>OBJECT<|"|>`);
      // no lowercase type should appear
      expect(out).not.toMatch(/type:<\|"\|>string/);
    });

    it("handles nested OBJECT properties (Google caveat example)", () => {
      const tools = [
        {
          name: "update_config",
          description: "Updates the configuration of the system.",
          parameters: {
            type: "object",
            properties: {
              config: {
                type: "object",
                description: "A Config object",
                properties: {
                  theme: { type: "string" },
                  font_size: { type: "number" },
                },
              },
            },
            required: ["config"],
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      // Outer param
      expect(out).toContain(`config:{description:<|"|>A Config object<|"|>`);
      // Nested properties inside config
      expect(out).toContain(`font_size:{type:<|"|>NUMBER<|"|>}`);
      expect(out).toContain(`theme:{type:<|"|>STRING<|"|>}`);
      // Outer object type
      expect(out).toContain(`config:{description:<|"|>A Config object<|"|>,properties:`);
    });

    it("handles STRING enum", () => {
      const tools = [
        {
          name: "set_mode",
          description: "Set mode",
          parameters: {
            type: "object",
            properties: {
              mode: {
                type: "string",
                description: "The mode",
                enum: ["fast", "slow"],
              },
            },
            required: ["mode"],
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      expect(out).toContain(`enum:[<|"|>fast<|"|>,<|"|>slow<|"|>]`);
    });

    it("handles nullable field", () => {
      const tools = [
        {
          name: "find",
          description: "Find",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", nullable: true },
            },
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      expect(out).toContain(`nullable:true`);
    });

    it("handles ARRAY with typed items", () => {
      const tools = [
        {
          name: "list_things",
          description: "List",
          parameters: {
            type: "object",
            properties: {
              ids: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      expect(out).toContain(`type:<|"|>ARRAY<|"|>`);
      expect(out).toContain(`items:{type:<|"|>STRING<|"|>}`);
    });

    it("emits newlines between top-level declaration fields", () => {
      const tools = [
        {
          name: "do_thing",
          description: "Does a thing",
          parameters: {
            type: "object",
            properties: { x: { type: "string" } },
          },
        },
      ] as any;
      const out = formatGemmaToolDeclarations(tools);
      // description and parameters should be on separate lines
      expect(out).toContain(`description:<|"|>Does a thing<|"|>,\nparameters:`);
    });
  });
});
