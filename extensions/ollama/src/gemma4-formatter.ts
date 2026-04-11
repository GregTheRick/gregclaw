import type { Tool } from "@mariozechner/pi-ai";
import { metaEscape } from "./gemma4-utils.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./ollama-json.js";

// Extracts text content correctly from Pi-AI format, including multimodal placeholders
// Aligned with llama-gemma4.jinja (\n\n<|part|>\n\n spacing)
function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const textContent = (content as Array<unknown>)
    .map((part) => {
      if (!part || typeof part !== "object") {
        return "";
      }
      const p = part as { type?: string; text?: string };
      if (p.type === "text") {
        return p.text || "";
      }
      if (p.type === "image") {
        return "\n\n<|image|>\n\n";
      }
      if (p.type === "audio") {
        return "\n\n<|audio|>\n\n";
      }
      if (p.type === "video") {
        return "\n\n<|video|>\n\n";
      }
      return "";
    })
    .join("");
  return textContent;
}

// Port of strip_thinking Jinja macro with 'convert' extension
function processGemmaThinking(text: string, mode: "strip" | "convert"): string {
  let result = "";
  // Split by closing tag as in the Jinja template
  const parts = text.split("<channel|>");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const openIdx = part.indexOf("<|channel>");
    if (openIdx !== -1) {
      // Keep text before tag, but trim it to match wrapGemmaThought's newlines
      result += part.slice(0, openIdx).trim();
      if (mode === "convert") {
        let thought = part.slice(openIdx + "<|channel>".length).trim();
        // Remove the 'thought' prefix that follows <|channel> in Gemma 4
        if (thought.startsWith("thought")) {
          thought = thought.slice("thought".length).trim();
        }
        if (thought.length > 0) {
          result += wrapGemmaThought(thought);
        }
      }
    } else {
      // Text after the last closing tag or plain text
      result += part.trim();
    }
  }
  return result.trim();
}

function wrapGemmaThought(thought: string): string {
  if (!thought.trim()) {
    return "";
  }
  return `\nThese are my thoughts:\n${thought.trim()}\n... I think I am done thinking.\n`;
}

// Extracts thinking content
function extractThinkingContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  const thinkingContent = (content as Array<unknown>)
    .filter(
      (part) => part && typeof part === "object" && (part as { type?: string }).type === "thinking",
    )
    .map((part) => (part as { thinking?: string }).thinking as string)
    .join("\n")
    .trim();
  return thinkingContent;
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
    return `<|"|>${metaEscape(value)}<|"|>`;
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

// Standard JSON Schema keys that are handled explicitly and must not be treated as
// parameter names when iterating the properties map (mirrors format_parameters in
// llama-gemma4.jinja).
const GEMMA_SCHEMA_STANDARD_KEYS = new Set([
  "description",
  "type",
  "properties",
  "required",
  "nullable",
]);

/**
 * Port of the `format_parameters` Jinja macro from llama-gemma4.jinja.
 * Renders a JSON Schema `properties` map into the compact Gemma 4 format,
 * recursing into nested OBJECT / ARRAY types and hoisting description, nullable,
 * enum, and type as first-class fields.
 *
 * Types are uppercased to match the Gemma tokeniser expectation (STRING, OBJECT, …).
 */
function formatGemmaParameters(properties: Record<string, unknown>, _required: string[]): string {
  const parts: string[] = [];
  const sortedKeys = Object.keys(properties).toSorted();

  for (const key of sortedKeys) {
    if (GEMMA_SCHEMA_STANDARD_KEYS.has(key)) {
      continue;
    }

    const value = properties[key] as Record<string, unknown>;
    const fieldParts: string[] = [];

    if (typeof value["description"] === "string") {
      fieldParts.push(`description:<|"|>${metaEscape(value["description"])}<|"|>`);
    }

    if (value["nullable"]) {
      fieldParts.push(`nullable:true`);
    }

    const typeStr = (value["type"] as string | undefined)?.toUpperCase() ?? "";

    if (typeStr === "STRING") {
      if (value["enum"]) {
        fieldParts.push(`enum:${stringifyGemma(value["enum"])}`);
      }
    } else if (typeStr === "OBJECT") {
      const nestedProps = value["properties"];
      if (nestedProps && typeof nestedProps === "object" && !Array.isArray(nestedProps)) {
        const nestedStr = formatGemmaParameters(
          nestedProps as Record<string, unknown>,
          (value["required"] as string[] | undefined) ?? [],
        );
        fieldParts.push(`properties:{\n${nestedStr}\n}`);
      }
      if (Array.isArray(value["required"]) && (value["required"] as string[]).length > 0) {
        const reqItems = (value["required"] as string[]).map((r) => `<|"|>${r}<|"|>`).join(",");
        fieldParts.push(`required:[${reqItems}]`);
      }
    } else if (typeStr === "ARRAY") {
      const items = value["items"];
      if (items && typeof items === "object" && !Array.isArray(items)) {
        const itemsObj = items as Record<string, unknown>;
        const itemParts: string[] = [];
        for (const itemKey of Object.keys(itemsObj).toSorted()) {
          const itemValue = itemsObj[itemKey];
          if (itemValue === null || itemValue === undefined) {
            continue;
          }
          if (itemKey === "properties") {
            if (typeof itemValue === "object" && !Array.isArray(itemValue)) {
              const nestedStr = formatGemmaParameters(
                itemValue as Record<string, unknown>,
                (itemsObj["required"] as string[] | undefined) ?? [],
              );
              itemParts.push(`properties:{\n${nestedStr}\n}`);
            }
          } else if (itemKey === "required") {
            const reqItems = (itemValue as string[]).map((r) => `<|"|>${r}<|"|>`).join(",");
            itemParts.push(`required:[${reqItems}]`);
          } else if (itemKey === "type") {
            if (typeof itemValue === "string") {
              itemParts.push(`type:${stringifyGemma(itemValue.toUpperCase())}`);
            } else if (Array.isArray(itemValue)) {
              itemParts.push(
                `type:${stringifyGemma((itemValue as string[]).map((v) => v.toUpperCase()))}`,
              );
            }
          } else {
            itemParts.push(`${itemKey}:${stringifyGemma(itemValue)}`);
          }
        }
        fieldParts.push(`items:{${itemParts.join(",")}}`);
      }
    }

    if (typeStr) {
      fieldParts.push(`type:<|"|>${typeStr}<|"|>`);
    }

    parts.push(`${key}:{${fieldParts.join(",")}}`);
  }

  return parts.join(",\n");
}

/**
 * Port of the `format_function_declaration` Jinja macro from llama-gemma4.jinja.
 * Produces a single `declaration:name{...}` block for one tool.
 */
function formatGemmaFunctionDeclaration(tool: Tool): string {
  const declarationParts: string[] = [];

  if (tool.description) {
    declarationParts.push(`description:<|"|>${metaEscape(tool.description)}<|"|>`);
  }

  const params = tool.parameters as
    | {
        type?: string;
        properties?: Record<string, unknown>;
        required?: string[];
      }
    | undefined;

  if (params) {
    const paramParts: string[] = [];

    if (params.properties) {
      const propsStr = formatGemmaParameters(params.properties, params.required ?? []);
      paramParts.push(`properties:{\n${propsStr}\n}`);
    }

    if (Array.isArray(params.required) && params.required.length > 0) {
      const reqItems = params.required.map((r) => `<|"|>${r}<|"|>`).join(",");
      paramParts.push(`required:[${reqItems}]`);
    }

    if (params.type) {
      paramParts.push(`type:<|"|>${params.type.toUpperCase()}<|"|>`);
    }

    declarationParts.push(`parameters:{\n${paramParts.join(",\n")}\n}`);
  }

  return `declaration:${tool.name}{\n${declarationParts.join(",\n")}\n}`;
}

export function formatGemmaToolDeclarations(tools: Tool[]): string {
  if (!tools || tools.length === 0) {
    return "";
  }
  return tools.map((t) => `<|tool>${formatGemmaFunctionDeclaration(t)}<tool|>`).join("");
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
      output += metaEscape(options.system.trim()); // Aligned with Jinja: content | trim
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
      output += `<|turn>user\n${metaEscape(text.trim())}<turn|>\n`;
    } else if (msg.role === "assistant") {
      const toolCalls = extractToolCalls(msg.content);

      // Open model turn if not already in it
      if (!inModelTurn) {
        output += "<|turn>model\n";
        inModelTurn = true;
      }

      let text = extractTextContent(msg.content);
      let thinking = extractThinkingContent(msg.content);

      if (toolCalls.length > 0) {
        currentTurnToolIds = toolCalls.map((c) => c.id).filter(Boolean) as string[];
      }

      // History Handling: Humanize or Strip reasoning
      const isHistorical = i < lastUserIdx;
      const keepThoughts = options?.preserveAllThoughts || i > lastUserIdx;

      if (isHistorical) {
        if (keepThoughts) {
          // Humanize turn
          text = processGemmaThinking(text, "convert");
          if (thinking) {
            output += metaEscape(wrapGemmaThought(thinking));
          }
        } else {
          // Strip reasoning
          text = processGemmaThinking(text, "strip");
          thinking = ""; // Drop explicit thinking
        }
      } else {
        // Current turn or after last user message: keep technical tokens
        if (thinking) {
          output += `<|channel>thought\n${metaEscape(thinking)}<channel|>`;
        }
      }

      if (text) {
        output += metaEscape(text);
      }

      for (const call of toolCalls) {
        const args = { ...call.arguments };
        if (call.id) {
          args["_pid"] = call.id;
        }
        output += `<|tool_call>call:${call.name}${stringifyGemma(args)}<tool_call|>`;
      }

      if (toolCalls.length === 0 && !isLastMessage) {
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

      // Sort matching tool call order
      consecutiveToolResults.sort((a, b) => {
        const msgA = a as { toolCallId?: string; id?: string };
        const msgB = b as { toolCallId?: string; id?: string };
        const idA = msgA.toolCallId || msgA.id;
        const idB = msgB.toolCallId || msgB.id;
        const idxA = currentTurnToolIds.indexOf(idA || "");
        const idxB = currentTurnToolIds.indexOf(idB || "");
        return (idxA !== -1 ? idxA : 999) - (idxB !== -1 ? idxB : 999);
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
        } catch {}

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

      i = j - 1;
    }
  }

  // 3. Generation Prompt (End of Prompt)
  // Ensure unconditional thought-suppression if reasoning is not enabled, matching Jinja
  if (!inModelTurn) {
    output += "<|turn>model\n";
  }
  if (!options?.thinkActive) {
    output += "<|channel>thought\n<channel|>";
  }

  return output;
}
