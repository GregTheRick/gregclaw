import type { Message, Tool } from "@mariozechner/pi-ai";
import type { GTRChatComponent, GTRChatTurn, GTRRole, GTRTool } from "./gemma4-gtr-types.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./ollama-json.js";

interface GTRFormatterOptions {
  system?: string;
  tools?: Tool[];
  thinkEnabled?: boolean;
}

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
      ctype: "systemtext",
      data: { text: options.system },
    });
  }

  if (options.tools && options.tools.length > 0) {
    const tools: GTRTool[] = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      args: Object.entries(
        ((t.parameters as Record<string, unknown> | undefined)?.properties as Record<
          string,
          unknown
        >) || {},
      ).map(([name, prop]) => {
        const p = prop as Record<string, unknown>;
        return {
          name,
          arg_type: (p.type as string)?.toUpperCase() || "STRING",
          description: (p.description as string) || "",
        };
      }),
    }));

    systemComponents.push({
      ctype: "toolschema",
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

  // 2. Conversation Turns
  for (const msg of messages) {
    const role: GTRRole = msg.role === "assistant" ? "model" : (msg.role as GTRRole);
    const components = extractGTRComponents(msg);

    if (components.length > 0) {
      turns.push({
        role,
        components,
      });
    }
  }

  return cleanTurns(turns);
}

function extractGTRComponents(msg: Message): GTRChatComponent[] {
  const content = msg.content;
  if (typeof content === "string") {
    return [{ ctype: "answer", data: { text: content } }];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const result: GTRChatComponent[] = [];

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
      result.push({
        ctype: "toolcall",
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
      result.push({
        ctype: "toolresponse",
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
