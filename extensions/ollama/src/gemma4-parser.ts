export interface Gemma4StreamEvent {
  type: "text" | "thinking" | "tool_call";
  content?: string;
  toolCall?: { id?: string; name: string; arguments: Record<string, unknown> };
}

export class Gemma4Parser {
  private buffer = "";
  private state: "text" | "thinking" | "tool_call" = "text";
  private strippedBos = false;

  // Unescape the <|"|> wrapping back into standard JSON
  public static unescapeGemmaParams(gemmaStr: string): Record<string, unknown> {
    try {
      // Replace <|"|>value<|"|> with "value"
      // Wait, Gemma strings might contain quotes inside.
      // If we blindly replace <|"|> with ", it might produce invalid JSON if the internal string had unescaped quotes.
      // But JSON parser requires proper escaping. If the string format is e.g. location:<|"|>London<|"|>,
      // we can try a regex approach or manual parsing.

      // Let's first quote the keys.
      let jsonStr = gemmaStr.replace(/([a-zA-Z0-9_]+):/g, '"$1":');
      // Then replace <|"|> with " and hope internal quotes were escaped, OR
      // we might need to escape internal quotes first.

      // For simplicity, a regex to find all <|"|>...<|"|> and replace them with properly JSON stringified versions.
      jsonStr = jsonStr.replace(/<\|"\|>(.*?)<\|"\|>/gs, (match, p1) => {
        return JSON.stringify(p1);
      });

      return JSON.parse(jsonStr);
    } catch {
      return {}; // return empty if malformed
    }
  }

  public push(chunk: string): Gemma4StreamEvent[] {
    this.buffer += chunk;
    const events: Gemma4StreamEvent[] = [];

    if (!this.strippedBos) {
      if ("<bos>".startsWith(this.buffer)) {
        return [];
      }
      if (this.buffer.startsWith("<bos>")) {
        this.buffer = this.buffer.slice(5);
      }
      this.strippedBos = true;
    }

    let processedIdx = 0;
    while (processedIdx < this.buffer.length) {
      if (this.state === "text") {
        const thinkMatch = this.buffer.indexOf("<|channel>thought", processedIdx);
        const toolMatch = this.buffer.indexOf("<|tool_call>call:", processedIdx);

        let nextTransition = -1;
        let nextState: "thinking" | "tool_call" | null = null;

        if (thinkMatch !== -1 && (toolMatch === -1 || thinkMatch < toolMatch)) {
          nextTransition = thinkMatch;
          nextState = "thinking";
        } else if (toolMatch !== -1) {
          nextTransition = toolMatch;
          nextState = "tool_call";
        }

        if (nextTransition !== -1) {
          if (nextTransition > processedIdx) {
            events.push({ type: "text", content: this.buffer.slice(processedIdx, nextTransition) });
          }
          if (nextState === "thinking") {
            processedIdx = nextTransition + "<|channel>thought".length;
            this.state = "thinking";
          } else if (nextState === "tool_call") {
            processedIdx = nextTransition + "<|tool_call>call:".length;
            this.state = "tool_call";
          }
        } else {
          // Check for partial tags at the end of the buffer
          const potentialTags = new Set([
            "<|",
            "<|c",
            "<|ch",
            "<|cha",
            "<|chan",
            "<|chann",
            "<|channe",
            "<|channel",
            "<|channel>",
            "<|channel>t",
            "<|channel>th",
            "<|channel>tho",
            "<|channel>thou",
            "<|channel>thoug",
            "<|channel>though",
            "<|channel>thought",
            "<|t",
            "<|to",
            "<|too",
            "<|tool",
            "<|tool_",
            "<|tool_c",
            "<|tool_ca",
            "<|tool_cal",
            "<|tool_call",
            "<|tool_call>",
            "<|tool_call>c",
            "<|tool_call>ca",
            "<|tool_call>cal",
            "<|tool_call>call",
            "<|tool_call>call:",
          ]);

          let safeEnd = this.buffer.length;
          for (let i = this.buffer.length - 1; i >= processedIdx; i--) {
            const suffix = this.buffer.slice(i);
            if (potentialTags.has(suffix)) {
              safeEnd = i;
              break;
            }
          }

          if (safeEnd > processedIdx) {
            events.push({ type: "text", content: this.buffer.slice(processedIdx, safeEnd) });
          }
          processedIdx = safeEnd;
          break; // wait for more chunks
        }
      } else if (this.state === "thinking") {
        const endMatch = this.buffer.indexOf("<channel|>", processedIdx);
        if (endMatch !== -1) {
          const content = this.buffer.slice(processedIdx, endMatch);
          if (content.length > 0) {
            events.push({ type: "thinking", content });
          }
          processedIdx = endMatch + "<channel|>".length;
          this.state = "text";
        } else {
          // Check for partial <channel|>
          const potentialTags = new Set([
            "<",
            "<c",
            "<ch",
            "<cha",
            "<chan",
            "<chann",
            "<channe",
            "<channel",
            "<channel|",
          ]);
          let safeEnd = this.buffer.length;
          for (let i = this.buffer.length - 1; i >= processedIdx; i--) {
            const suffix = this.buffer.slice(i);
            if (potentialTags.has(suffix)) {
              safeEnd = i;
              break;
            }
          }
          if (safeEnd > processedIdx) {
            events.push({ type: "thinking", content: this.buffer.slice(processedIdx, safeEnd) });
          }
          processedIdx = safeEnd;
          break;
        }
      } else if (this.state === "tool_call") {
        const endMatch = this.buffer.indexOf("<tool_call|>", processedIdx);
        if (endMatch !== -1) {
          const callContent = this.buffer.slice(processedIdx, endMatch);
          // format: name{args}
          const braceIdx = callContent.indexOf("{");
          if (braceIdx !== -1) {
            const name = callContent.slice(0, braceIdx);
            const argsStr = callContent.slice(braceIdx);
            const parsedArgs = Gemma4Parser.unescapeGemmaParams(argsStr);
            let id: string | undefined;
            if ("_pid" in parsedArgs) {
              id = String(parsedArgs["_pid"]);
              delete parsedArgs["_pid"];
            }
            events.push({
              type: "tool_call",
              toolCall: { id, name, arguments: parsedArgs },
            });
          } else {
            events.push({
              type: "tool_call",
              toolCall: { name: callContent, arguments: {} },
            });
          }
          processedIdx = endMatch + "<tool_call|>".length;
          this.state = "text";
        } else {
          // wait for more tool_call buffer
          break;
        }
      }
    }

    this.buffer = this.buffer.slice(processedIdx);
    return events;
  }
}
