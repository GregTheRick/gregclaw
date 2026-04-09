import type { StreamFn } from "@mariozechner/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@mariozechner/pi-ai";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { convertToGemma4Format } from "./gemma4-formatter.js";
import { Gemma4Parser } from "./gemma4-parser.js";
import { parseJsonPreservingUnsafeIntegers } from "./ollama-json.js";
import { OLLAMA_NATIVE_BASE_URL } from "./stream.js";

const log = createSubsystemLogger("ollama-gemma4-stream");

export async function* decodeGenerateNdjsonStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<{ response?: string; done?: boolean }> {
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
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        yield parseJsonPreservingUnsafeIntegers(trimmed) as { response?: string; done?: boolean };
      } catch {
        log.warn(`Skipping malformed NDJSON line: ${trimmed.slice(0, 120)}`);
      }
    }
  }

  if (buffer.trim()) {
    try {
      yield parseJsonPreservingUnsafeIntegers(buffer.trim()) as {
        response?: string;
        done?: boolean;
      };
    } catch {}
  }
}

export function createGemma4StreamFn(
  baseUrl: string,
  defaultHeaders?: Record<string, string>,
): StreamFn {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const generateUrl = `${normalizedBase || OLLAMA_NATIVE_BASE_URL}/api/generate`;

  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();

    const run = async () => {
      try {
        const messages = context.messages ? [...context.messages] : [];

        // Pi-Agent natively handles the loop and will send us the `toolResult`
        // messages on subsequent invocations.
        // Formatter logic preserves thoughts across ongoing sessions inherently.
        const rawPrompt = convertToGemma4Format(messages, {
          system: context.systemPrompt,
          tools: context.tools,
          thinkActive:
            (model as unknown as { extraParams?: { thinking?: boolean } }).extraParams?.thinking ??
            true,
          preserveAllThoughts: false, // handled intrinsically by isLastMessage checks
        });

        const ollamaOptions: Record<string, unknown> = {
          num_ctx: model.contextWindow ?? 8192,
          stop: ["<|tool_response>", "<turn|>", "<|turn>"],
        };
        if (typeof options?.temperature === "number") {
          ollamaOptions.temperature = options.temperature;
        }

        const body = {
          model: model.id,
          prompt: rawPrompt,
          raw: true,
          stream: true,
          options: ollamaOptions,
        };

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
          throw new Error(`${response.status} ${errorText}`);
        }
        if (!response.body) {
          throw new Error("Ollama API returned empty response body");
        }

        const reader = response.body.getReader();
        const parser = new Gemma4Parser();

        let loopRequiresToolExec = false;
        let executedToolCalls: Array<{
          id?: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];
        let assistantContentStr = "";
        let assistantThinkingStr = "";
        let rawResponseBuffer = "";

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

        for await (const chunk of decodeGenerateNdjsonStream(reader)) {
          if (chunk.response) {
            rawResponseBuffer += chunk.response;
            const events = parser.push(chunk.response);

            for (const ev of events) {
              if (ev.type === "text" && ev.content) {
                assistantContentStr += ev.content;
                stream.push({
                  type: "text_delta",
                  contentIndex: 0,
                  delta: ev.content,
                  partial: {
                    role: "assistant",
                    content: [{ type: "text", text: assistantContentStr }],
                    stopReason: "stop",
                  } as unknown as AssistantMessage,
                });
              } else if (ev.type === "thinking" && ev.content) {
                assistantThinkingStr += ev.content;
                stream.push({
                  type: "thinking_delta",
                  contentIndex: 0,
                  delta: ev.content,
                  partial: {
                    role: "assistant",
                    content: [{ type: "thinking", thinking: assistantThinkingStr }],
                    stopReason: "stop",
                  } as unknown as AssistantMessage,
                });
              } else if (ev.type === "tool_call" && ev.toolCall) {
                loopRequiresToolExec = true;
                executedToolCalls.push(ev.toolCall);
              }
            }
          }
        }

        const buildContentObj = () => {
          let arr: unknown[] = [];
          if (assistantThinkingStr) {
            arr.push({ type: "thinking", thinking: assistantThinkingStr });
          }
          if (assistantContentStr) {
            arr.push({ type: "text", text: assistantContentStr });
          }
          if (loopRequiresToolExec && executedToolCalls.length > 0) {
            for (const call of executedToolCalls) {
              arr.push({
                type: "toolCall",
                id: call.id || `ollama_call_${Math.random().toString(36).substring(7)}`,
                name: call.name,
                arguments: call.arguments,
              });
            }
          }
          return arr;
        };

        const partialResp = {
          role: "assistant",
          api: modelInfo.api,
          provider: modelInfo.provider,
          model: modelInfo.id,
          content: buildContentObj(),
          stopReason: loopRequiresToolExec ? "toolUse" : "stop",
          usage: {
            input: 0,
            output: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        } as unknown as AssistantMessage;

        stream.push({
          type: "done",
          reason: loopRequiresToolExec ? "toolUse" : "stop",
          message: partialResp,
        });
        stream.end();

        try {
          const logPath =
            process.env.OPENCLAW_GEMMA4_LOG_FILE ||
            require("node:path").join(require("node:os").tmpdir(), "openclaw-gemma4.log");
          const logContent =
            `\n========== TURN at ${new Date().toISOString()} ==========\n` +
            `>>> RAW PROMPT >>>\n${rawPrompt}\n` +
            `<<< RAW RESPONSE <<<\n${rawResponseBuffer}\n`;
          require("node:fs").appendFileSync(logPath, logContent);
        } catch (e) {
          log.warn(`Failed to write Gemma 4 raw log: ${String(e)}`);
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            error: errorMessage,
            stopReason: "error",
          } as unknown as AssistantMessage,
        });
        stream.end();
      }
    };

    void run();
    return stream;
  };
}
