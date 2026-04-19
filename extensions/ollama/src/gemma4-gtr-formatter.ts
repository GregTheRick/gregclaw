import type { Message, Tool } from "@mariozechner/pi-ai";
import type {
  GTRChatComponent,
  GTRChatTurn,
  GTRRole,
  GTRTextData,
  GTRTool,
  GTRToolCallData,
} from "./gemma4-gtr-types.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./ollama-json.js";

interface GTRFormatterOptions {
  system?: string;
  tools?: Tool[];
  thinkEnabled?: boolean;
}

type ExtractedComponent = GTRChatComponent & { toolCallId?: string };

/**
 * Converts Pi-Agent messages and tools into the GTR (Gemma Token-level Robust)
 * structured API format.
 */
export function convertToGTRFormat(
  messages: Message[],
  options: GTRFormatterOptions = {},
): GTRChatTurn[] {
  const turns: GTRChatTurn[] = [];

  // 1. System Turn
  const systemComponents: GTRChatComponent[] = [];
  if (options.system) {
    systemComponents.push({
      ctype: "system_text",
      data: { text: options.system },
    });
  }

  if (options.tools && options.tools.length > 0) {
    const tools: GTRTool[] = options.tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: (t.parameters as Record<string, unknown>) || {
          type: "object",
          properties: {},
        },
      },
    }));

    systemComponents.push({
      ctype: "tool_schema",
      data: { tools },
    });
  }

  if (systemComponents.length > 0) {
    turns.push({
      role: "system",
      thinking_enabled: options.thinkEnabled ?? true,
      components: systemComponents,
    });
  }

  // 2. Conversation Turns with PID tracking and grouping
  const callIdToPid = new Map<string, string>();
  const callIdToName = new Map<string, string>();
  let nextPid = 1;

  for (const msg of messages) {
    const isToolResult = msg.role === "toolResult";
    const role: GTRRole =
      msg.role === "assistant" ? "model" : isToolResult ? "model" : (msg.role as GTRRole);
    let components = extractGTRComponents(msg);

    if (components.length === 0) {
      continue;
    }

    // Special Case: if it's a tool result message but extracted as an 'answer' (string content),
    // force it into a 'tool_response' component.
    if (isToolResult) {
      components = components.map((comp) => {
        if (comp.ctype === "answer") {
          const msgRecord = msg as unknown as Record<string, unknown>;
          const toolCallId =
            (typeof msgRecord.toolCallId === "string" ? msgRecord.toolCallId : undefined) ||
            (typeof msgRecord.id === "string" ? msgRecord.id : undefined);
          const name =
            (typeof msgRecord.name === "string" ? msgRecord.name : undefined) ||
            (toolCallId ? callIdToName.get(toolCallId) : undefined) ||
            "unknown";
          return {
            ctype: "tool_response",
            toolCallId,
            data: {
              name,
              args: [{ key: "result", val: (comp.data as GTRTextData).text }],
            },
          } as ExtractedComponent;
        }
        return comp;
      });
    }

    // Assign PIDs to tool calls and responses (INJECTED INTO ARGS)
    for (const comp of components) {
      if (comp.ctype === "tool_call" && comp.toolCallId) {
        const pid = String(nextPid++);
        callIdToPid.set(comp.toolCallId, pid);
        callIdToName.set(comp.toolCallId, (comp.data as GTRToolCallData).name);
        (comp.data as GTRToolCallData).args.push({ key: "pid", val: pid });
      } else if (comp.ctype === "tool_response" && comp.toolCallId) {
        const pid = callIdToPid.get(comp.toolCallId);
        if (pid) {
          (comp.data as GTRToolCallData).args.push({ key: "pid", val: pid });
        }
      }
    }

    // Merge tool_response into the preceding model turn if possible
    if (isToolResult) {
      const lastTurn = turns[turns.length - 1];
      if (lastTurn && lastTurn.role === "model") {
        lastTurn.components.push(...components.map((c) => ({ ctype: c.ctype, data: c.data })));
        continue;
      }
      // If no preceding model turn (rare), fall through to create a new model turn
      const turn: GTRChatTurn = {
        role: "model",
        components: components.map((c) => ({ ctype: c.ctype, data: c.data })),
      };
      turns.push(turn);
    } else {
      const turn: GTRChatTurn = {
        role,
        components: components.map((c) => ({ ctype: c.ctype, data: c.data })),
      };
      turns.push(turn);
    }
  }

  return cleanTurns(turns);
}

function extractGTRComponents(msg: Message): ExtractedComponent[] {
  const content = msg.content;
  if (typeof content === "string") {
    return [{ ctype: "answer", data: { text: content } }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const result: ExtractedComponent[] = [];

  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const p = part as unknown as Record<string, unknown>;

    if (p.type === "text") {
      const text = typeof p.text === "string" ? p.text : "";
      result.push({ ctype: "answer", data: { text } });
    } else if (p.type === "thinking") {
      const text = typeof p.thinking === "string" ? p.thinking : "";
      result.push({ ctype: "thinking", data: { text } });
    } else if (p.type === "toolCall" || p.type === "tool_use") {
      const args = parseJsonObjectPreservingUnsafeIntegers(p.arguments || p.input) ?? {};
      const name = typeof p.name === "string" ? p.name : "";
      const id = typeof p.id === "string" ? p.id : undefined;
      result.push({
        ctype: "tool_call",
        toolCallId: id,
        data: {
          name,
          args: Object.entries(args).map(([key, val]) => ({ key, val: String(val) })),
        },
      });
    } else if (p.type === "tool_result") {
      // Map tool_result to tool_response
      const rawResult = p.content || p.result;
      const resultObj =
        typeof rawResult === "string"
          ? { result: rawResult }
          : (rawResult as Record<string, unknown> | undefined);
      const name = typeof p.name === "string" ? p.name : "";
      const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : undefined;
      result.push({
        ctype: "tool_response",
        toolCallId,
        data: {
          name,
          args: Object.entries(resultObj || {}).map(([key, val]) => ({ key, val: String(val) })),
        },
      });
    } else if (p.type === "image") {
      const base64 = extractBase64(
        p.data || (p.image_url as Record<string, unknown> | undefined)?.url,
      );
      if (base64) {
        result.push({
          ctype: "image",
          data: { multimodal: base64 },
        });
      }
    } else if (p.type === "audio") {
      const base64 = extractBase64((p.audio_url as Record<string, unknown> | undefined)?.url);
      if (base64) {
        result.push({
          ctype: "audio",
          data: { multimodal: base64 },
        });
      }
    }
  }

  return result;
}

function extractBase64(url: unknown): string | undefined {
  if (typeof url !== "string") {
    return undefined;
  }
  if (url.startsWith("data:")) {
    const parts = url.split(",");
    return parts.length > 1 ? parts[1] : url;
  }
  return url;
}

/**
 * Ensures turns are consistent (e.g., non-empty, logical role transitions).
 */
function cleanTurns(turns: GTRChatTurn[]): GTRChatTurn[] {
  // Remove empty turns
  return turns.filter((t) => t.components.length > 0);
}
