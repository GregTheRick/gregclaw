import type { Tool } from "@mariozechner/pi-ai";
import { parseJsonObjectPreservingUnsafeIntegers } from "./ollama-json.js";

// Extracts text content correctly from Pi-AI format, including multimodal placeholders
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<unknown>)
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const p = part as { type?: string; text?: string };
      if (p.type === "text") {
        return p.text || "";
      }
      if (p.type === "image") {
        return "<|image|>";
      }
      if (p.type === "audio") {
        return "<|audio|>";
      }
      return "";
    })
    .join("");
}

// Extracts thinking content
function extractThinkingContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return (content as Array<unknown>)
    .filter(
      (part) => part && typeof part === "object" && (part as { type?: string }).type === "thinking",
    )
    .map((part) => (part as { thinking?: string }).thinking as string)
    .join("");
}

// Extract tool calls
function extractToolCalls(
  content: unknown,
): Array<{ id?: string; name: string; arguments: Record<string, unknown> }> {
  if (!Array.isArray(content)) {
    return [];
  }
  const result: Array<{ id?: string; name: string; arguments: Record<string, unknown> }> = [];
  for (const part of content) {
    if (part && part.type === "toolCall") {
      result.push({
        id: part.id,
        name: part.name,
        arguments: parseJsonObjectPreservingUnsafeIntegers(part.arguments) ?? {},
      });
    } else if (part && part.type === "tool_use") {
      result.push({
        id: part.id,
        name: part.name,
        arguments: parseJsonObjectPreservingUnsafeIntegers(part.input) ?? {},
      });
    }
  }
  return result;
}

export function stringifyGemma(value: unknown): string {
  if (typeof value === "string") {
    return `<|"|>${value}<|"|>`;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stringifyGemma).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) => `${k}:${stringifyGemma(v)}`,
    );
    return `{${entries.join(",")}}`;
  }
  return `<|"|>${String(value as Parameters<typeof String>[0])}<|"|>`;
}

export function formatGemmaToolDeclarations(tools: Tool[]): string {
  if (!tools || tools.length === 0) {
    return "";
  }
  const declarations = tools.map((t) => {
    const schemaObj: Record<string, unknown> = {};
    if (t.description) {
      schemaObj.description = t.description;
    }
    if (t.parameters) {
      schemaObj.parameters = t.parameters;
    }
    const params = Object.keys(schemaObj).length > 0 ? stringifyGemma(schemaObj) : "{}";
    return `<|tool>declaration:${t.name}${params}<tool|>`;
  });
  return declarations.join("");
}

export function convertToGemma4Format(
  messages: Array<{ role: string; content: unknown }>,
  options?: {
    system?: string;
    tools?: Tool[];
    thinkActive?: boolean;
    preserveAllThoughts?: boolean;
  },
): string {
  let output = "<bos>";

  // 1. System Turn
  if (options?.system || (options?.tools && options.tools.length > 0) || options?.thinkActive) {
    output += "<|turn>system\n";
    if (options.thinkActive) {
      output += "<|think|>";
    }
    if (options.system) {
      output += options.system;
    }
    if (options.tools && options.tools.length > 0) {
      output += formatGemmaToolDeclarations(options.tools);
    }
    output += "<turn|>\n";
  }

  // 2. Loop through messages
  let inModelTurn = false;
  let currentTurnToolIds: string[] = [];

  // Identify the boundary for the current agent turn (everything after the last user message)
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const isLastMessage = i === messages.length - 1;

    if (msg.role === "user") {
      if (inModelTurn) {
        output += "<turn|>\n";
        inModelTurn = false;
      }
      const text = extractTextContent(msg.content);
      output += `<|turn>user\n${text}<turn|>\n`;
    } else if (msg.role === "assistant") {
      if (!inModelTurn) {
        output += "<|turn>model\n";
        inModelTurn = true;
      }

      const text = extractTextContent(msg.content);
      let thinking = extractThinkingContent(msg.content);
      const toolCalls = extractToolCalls(msg.content);

      const hasToolCallsHere = toolCalls.length > 0;
      if (hasToolCallsHere) {
        currentTurnToolIds = toolCalls.map((c) => c.id).filter(Boolean) as string[];
      }

      // Google docs say: "strip the model's generated thoughts from the previous turn... If a single model
      // turn involves function or tool calls, thoughts must NOT be removed between the function calls."
      // We consider the "current turn" to be any assistant messages that appear AFTER the very last user message.
      let keepThoughts = options?.preserveAllThoughts;
      if (!keepThoughts) {
        keepThoughts = i > lastUserIdx;
      }

      if (thinking && keepThoughts && options?.thinkActive) {
        output += `<|channel>thought\n${thinking}\n<channel|>`;
      } else if (!options?.thinkActive && !thinking) {
        output += `<|channel>thought\n<channel|>`;
      }

      if (text) {
        output += text;
      }

      for (const call of toolCalls) {
        const args = { ...call.arguments };
        if (call.id) {
          args["_pid"] = call.id;
        }
        output += `<|tool_call>call:${call.name}${stringifyGemma(args)}<tool_call|>`;
      }

      // If it's the last message, and it DOES NOT end with a tool call,
      // does it get closed?
      // Wait, if assistant provided text and NO tool calls, it's the end of its turn.
      // But maybe we just leave it open if it's the absolutely last message, so the model continues?
      // No, if the user history has an assistant complete response, we must close it,
      // UNLESS the model itself generates it! But we are just formatting the *prompt*.
      // If we are formatting the context history, past assistant turns should be closed.
      if (!hasToolCallsHere && !isLastMessage) {
        output += "<turn|>\n";
        inModelTurn = false;
      }
    } else if (msg.role === "tool" || msg.role === "toolResult") {
      if (!inModelTurn) {
        output += "<|turn>model\n";
        inModelTurn = true;
      }

      // Look ahead to collect all consecutive tool results
      const consecutiveToolResults = [];
      let j = i;
      while (
        j < messages.length &&
        (messages[j].role === "tool" || messages[j].role === "toolResult")
      ) {
        consecutiveToolResults.push(messages[j]);
        j++;
      }

      // Sort them to perfectly match the `<|tool_call>` generation order observed in the assistant block
      consecutiveToolResults.sort((a, b) => {
        const aMsg = a as { toolCallId?: string; id?: string };
        const bMsg = b as { toolCallId?: string; id?: string };
        const idA = aMsg.toolCallId || aMsg.id;
        const idB = bMsg.toolCallId || bMsg.id;
        const idxA = currentTurnToolIds.indexOf(idA || "");
        const idxB = currentTurnToolIds.indexOf(idB || "");
        if (idxA !== -1 && idxB !== -1) {
          return idxA - idxB;
        }
        if (idxA !== -1) {
          return -1;
        }
        if (idxB !== -1) {
          return 1;
        }
        return 0; // maintain original order for unknown IDs
      });

      for (const tMsg of consecutiveToolResults) {
        const tMsgRec = tMsg as {
          content?: unknown;
          toolName?: string;
          toolCallId?: string;
          id?: string;
        };
        const text = extractTextContent(tMsgRec.content);
        const toolName = tMsgRec.toolName || "unknown_tool";
        const toolCallId = tMsgRec.toolCallId || tMsgRec.id;
        let parsedResponse: unknown = text;
        try {
          parsedResponse = JSON.parse(text);
        } catch {
          // Leave as string if not JSONifiable
        }

        if (toolCallId) {
          if (
            typeof parsedResponse === "object" &&
            parsedResponse !== null &&
            !Array.isArray(parsedResponse)
          ) {
            parsedResponse = { _pid: toolCallId, ...(parsedResponse as Record<string, unknown>) };
          } else {
            parsedResponse = { _pid: toolCallId, response: parsedResponse };
          }
        }

        output += `<|tool_response>response:${toolName}${stringifyGemma(parsedResponse)}<tool_response|>`;
      }

      i = j - 1; // Advance main loop past the grouped tool results
    }
  }

  // If we end on a user message, we want to open the model turn for generation!
  if (!inModelTurn) {
    output += "<|turn>model\n";
    if (!options?.thinkActive) {
      output += "<|channel>thought\n<channel|>";
    }
  }

  return output;
}
