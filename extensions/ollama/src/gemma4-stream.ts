import { randomUUID } from "node:crypto";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@mariozechner/pi-ai";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { convertToGTRFormat } from "./gemma4-gtr-formatter.js";
import type { GTRChatRequest, GTRChatResponseEvent } from "./gemma4-gtr-types.js";
import { parseJsonPreservingUnsafeIntegers } from "./ollama-json.js";
import { OLLAMA_GTRCHAT_URL_PATH, OLLAMA_NATIVE_BASE_URL } from "./stream.js";

const log = createSubsystemLogger("ollama-gemma4-stream");

export async function* decodeGenerateNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<
  GTRChatResponseEvent & { prompt_eval_count?: number; eval_count?: number; error?: string }
> {
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line) {
        continue;
      }
      try {
        yield parseJsonPreservingUnsafeIntegers(line) as GTRChatResponseEvent & {
          prompt_eval_count?: number;
          eval_count?: number;
          error?: string;
        };
      } catch {
        log.warn(`Skipping malformed NDJSON line: ${line.slice(0, 120)}`);
      }
    }
  }

  if (buffer) {
    try {
      yield parseJsonPreservingUnsafeIntegers(buffer) as GTRChatResponseEvent & {
        prompt_eval_count?: number;
        eval_count?: number;
        error?: string;
      };
    } catch {}
  }
}

export function createGemma4StreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const generateUrl = `${normalizedBase || OLLAMA_NATIVE_BASE_URL}${OLLAMA_GTRCHAT_URL_PATH}`;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const messages = context.messages ? [...context.messages] : [];

        // Convert context to GTR structured turns instead of raw prompt
        const turns = convertToGTRFormat(messages, {
          system: context.systemPrompt,
          tools: context.tools,
          thinkEnabled:
            (model as unknown as { extraParams?: { thinking?: boolean } }).extraParams?.thinking ??
            true,
        });

        const ollamaOptions: Record<string, unknown> = {
          num_ctx: model.contextWindow ?? 8192,
        };
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }

        const body: GTRChatRequest = {
          model: model.id,
          turns,
          stream: true,
          stream_mode: "structured",
          options: ollamaOptions,
        };

        log.info(`Sending GTRChat request to ${generateUrl} (${turns.length} turns)`);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...defaultHeaders,
          ...options?.headers,
        };
        if (
          options?.apiKey &&
          (!headers.Authorization || !isNonSecretApiKeyMarker(options.apiKey))
        ) {
          headers.Authorization = `Bearer ${options.apiKey}`;
        }

        const response = await fetch(generateUrl, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: options?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text().catch(() => "unknown error");
          log.error(`GTRChat error ${response.status}: ${errorText}`);
          if (process.env.OPENCLAW_GEMMA4_LOG_FILE) {
            try {
              const logPath = process.env.OPENCLAW_GEMMA4_LOG_FILE;
              const logContent =
                `\n[${new Date().toISOString()}] ERROR ${response.status}\n` +
                `URL: ${generateUrl}\n` +
                `REQUEST: ${JSON.stringify(body, null, 2)}\n` +
                `RESPONSE: ${errorText}\n`;
              const fs = await import("node:fs");
              fs.appendFileSync(logPath, logContent);
            } catch (e) {
              log.warn(`Failed to write Gemma 4 error log: ${String(e)}`);
            }
          }
          throw new Error(`${response.status} ${errorText}`);
        }
        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();

        let haltEncountered = false;
        let assistantContent: (TextContent | ThinkingContent | ToolCall)[] = [];

        const modelInfo = { api: model.api, provider: "ollama", id: model.id };

        stream.push({
          type: "start",
          partial: {
            role: "assistant",
            content: [],
            stopReason: "stop",
            usage: {
              input: 0,
              output: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          } as unknown as AssistantMessage,
        });

        let promptEvalCount = 0;
        let evalCount = 0;

        for await (const chunk of decodeGenerateNdjsonStream(reader)) {
          if (typeof chunk.prompt_eval_count === "number") {
            promptEvalCount = chunk.prompt_eval_count;
          }
          if (typeof chunk.eval_count === "number") {
            evalCount = chunk.eval_count;
          }

          if (chunk.error) {
            throw new Error(chunk.error);
          }

          if (chunk.type === "text" && chunk.content) {
            let lastPart = assistantContent[assistantContent.length - 1];
            if (lastPart?.type === "text") {
              lastPart.text += chunk.content;
            } else {
              assistantContent.push({ type: "text", text: chunk.content });
              lastPart = assistantContent[assistantContent.length - 1];
            }

            stream.push({
              type: "text_delta",
              contentIndex: assistantContent.length - 1,
              delta: chunk.content,
              partial: {
                role: "assistant",
                content: [...assistantContent],
                stopReason: "stop",
              } as unknown as AssistantMessage,
            });
          } else if (chunk.type === "thinking" && chunk.content) {
            let lastPart = assistantContent[assistantContent.length - 1];
            if (lastPart?.type === "thinking") {
              lastPart.thinking += chunk.content;
            } else {
              assistantContent.push({ type: "thinking", thinking: chunk.content });
              lastPart = assistantContent[assistantContent.length - 1];
            }

            stream.push({
              type: "thinking_delta",
              contentIndex: assistantContent.length - 1,
              delta: chunk.content,
              partial: {
                role: "assistant",
                content: [...assistantContent],
                stopReason: "stop",
              } as unknown as AssistantMessage,
            });
          } else if (chunk.type === "tool_call" && chunk.tool_call) {
            const parsedArgs = (chunk.tool_call.args || []).reduce(
              (acc: Record<string, unknown>, pair) => {
                try {
                  acc[pair.key] = JSON.parse(pair.val);
                } catch {
                  acc[pair.key] = pair.val;
                }
                return acc;
              },
              {},
            );

            assistantContent.push({
              type: "toolCall",
              id: `ollama_call_${randomUUID()}`,
              name: chunk.tool_call.name,
              arguments: parsedArgs,
            });
            stream.push({
              type: "toolcall_start",
              contentIndex: assistantContent.length - 1,
              partial: {
                role: "assistant",
                content: [...assistantContent],
                stopReason: "toolUse",
              } as unknown as AssistantMessage,
            });
          } else if (chunk.type === "done") {
            if (chunk.status === "call_wait") {
              haltEncountered = true;
            }
          }
        }

        const stopReason = haltEncountered ? "toolUse" : "stop";

        const partialResp = {
          role: "assistant",
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          content: assistantContent,
          stopReason,
          usage: {
            input: promptEvalCount,
            output: evalCount,
            totalTokens: promptEvalCount + evalCount,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        } as unknown as AssistantMessage;

        stream.push({
          type: "done",
          reason: stopReason,
          message: partialResp,
        });

        if (process.env.OPENCLAW_GEMMA4_LOG_FILE) {
          try {
            const logPath = process.env.OPENCLAW_GEMMA4_LOG_FILE;
            const logContent =
              `\n[${new Date().toISOString()}] SUCCESS\n` +
              `URL: ${generateUrl}\n` +
              `REQUEST: ${JSON.stringify(body, null, 2)}\n` +
              `RESPONSE: ${JSON.stringify(assistantContent, null, 2)}\n`;
            const fs = await import("node:fs");
            fs.appendFileSync(logPath, logContent);
          } catch (e) {
            log.warn(`Failed to write Gemma 4 success log: ${String(e)}`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }

        const errorMessage = formatErrorMessage(err);
        log.error(`Gemma 4 stream error: ${errorMessage}`);

        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            api: model.api,
            provider: "ollama",
            model: model.id,
            content: [],
            error: errorMessage,
            stopReason: "error",
          } as unknown as AssistantMessage,
        });
      } finally {
        stream.end();
      }
    };

    void run();
    return stream;
  };
}
