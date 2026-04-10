import { describe, it, expect } from "vitest";
import { Gemma4Parser } from "./gemma4-parser.js";

describe("gemma4-parser", () => {
  describe("unescapeGemmaParams", () => {
    it("converts Gemma param strings to objects", () => {
      const gemmaStr = '{location:<|"|>London<|"|>,temp:15}';
      const obj = Gemma4Parser.unescapeGemmaParams(gemmaStr);
      expect(obj).toEqual({ location: "London", temp: 15 });
    });

    it("handles colons inside strings within tool arguments", () => {
      const gemmaStr = '{code:<|"|>const x: number = 1;<|"|>,_pid:<|"|>call_123<|"|>}';
      const obj = Gemma4Parser.unescapeGemmaParams(gemmaStr);
      expect(obj).toEqual({ code: "const x: number = 1;", _pid: "call_123" });
    });
  });

  describe("Gemma4Parser.push (streaming)", () => {
    it("extracts text when no tokens are present", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("Hello world");
      expect(events).toEqual([{ type: "text", content: "Hello world" }]);
    });

    it("strips <bos> token at start", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("<bos>Hello world");
      expect(events).toEqual([{ type: "text", content: "Hello world" }]);
    });

    it("strips fragmented <bos> token at start", () => {
      const parser = new Gemma4Parser();
      const ev1 = parser.push("<b");
      const ev2 = parser.push("os>Hello world");
      expect(ev1).toEqual([]);
      expect(ev2).toEqual([{ type: "text", content: "Hello world" }]);
    });

    it("extracts thinking and text in one chunk", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("<|channel>thought\nhmm<channel|>\nyes");
      expect(events).toEqual([
        { type: "thinking", content: "\nhmm" },
        { type: "text", content: "\nyes" },
      ]);
    });

    it("handles chunk fragmentation effectively", () => {
      const parser = new Gemma4Parser();
      const evts1 = parser.push("Thinking");
      const evts2 = parser.push("...<|ch");
      const evts3 = parser.push("annel>thought\nprocess");
      const evts4 = parser.push("<channel|>");

      expect(evts1).toEqual([{ type: "text", content: "Thinking" }]);
      expect(evts2).toEqual([{ type: "text", content: "..." }]);
      expect(evts3).toEqual([{ type: "thinking", content: "\nprocess" }]);
      expect(evts4).toEqual([]);
    });

    it("parses full tool call properly", () => {
      const parser = new Gemma4Parser();
      const events = parser.push('<|tool_call>call:get_weather{loc:<|"|>UK<|"|>}<tool_call|>');
      expect(events).toEqual([
        {
          type: "tool_call",
          toolCall: { id: undefined, name: "get_weather", arguments: { loc: "UK" } },
        },
      ]);
    });

    it("parses tool call with _pid properly", () => {
      const parser = new Gemma4Parser();
      const events = parser.push(
        '<|tool_call>call:get_weather{loc:<|"|>UK<|"|>,_pid:<|"|>call_123<|"|>}<tool_call|>',
      );
      expect(events).toEqual([
        {
          type: "tool_call",
          toolCall: { id: "call_123", name: "get_weather", arguments: { loc: "UK" } },
        },
      ]);
    });

    it("parses fragmented tool call properly", () => {
      const parser = new Gemma4Parser();
      parser.push("<|tool_call>cal");
      parser.push("l:");
      parser.push("get_weath");
      parser.push("er{lo");
      parser.push('c:<|"|>UK');
      parser.push('<|"|>}');
      const events = parser.push("<tool_call|>");

      expect(events).toEqual([
        {
          type: "tool_call",
          toolCall: { id: undefined, name: "get_weather", arguments: { loc: "UK" } },
        },
      ]);
    });

    it("parses an empty thinking channel correctly", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("<|channel>thought\n<channel|>");

      expect(events).toEqual([{ type: "thinking", content: "\n" }]);
    });

    it("preserves leading and trailing whitespaces in text chunks", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("  leading and trailing  ");
      expect(events).toEqual([{ type: "text", content: "  leading and trailing  " }]);
    });

    it("preserves leading and trailing whitespaces in thinking blocks", () => {
      const parser = new Gemma4Parser();
      const events = parser.push("<|channel>thought  think  <channel|>");
      expect(events).toEqual([{ type: "thinking", content: "  think  " }]);
    });
  });
});
