# Gemma4 Integration - Research Findings

## Key Discoveries from Google Gemma4 Documentation

### 1. Control Tokens Summary

**Turn Structure:**

- `<|turn>` / `<turn|>` - Wrap entire turns
- `system`, `user`, `model` - Role indicators (placed after `<|turn>`)
- Example: `<|turn>user\nContent<turn|>`

**Tool/Function Calling:**

- `<|tool>` / `<tool|>` - Wraps tool declarations in system prompt
- `<|tool_call>` / `<tool_call|>` - Model's request to use a tool
- `<|tool_response>` / `<tool_response|>` - Tool execution result
- `<|"|>` - String delimiter for all string values in structured data

**Thinking/Reasoning:**

- `<|think|>` - Activates thinking mode (goes in system instruction)
- `<|channel>` / `<channel|>` - Wraps model's internal reasoning
- Always followed by word "thought" when thinking mode is active
- Example: `<|channel>thought\n...<channel|>`

### 2. Critical Behavior Rules

**Tool Call Loop Behavior:**

- Model outputs `<|tool_call>call:function_name{args}<tool_call|>`
- Application parses, executes tool, then appends response
- Application appends `<|tool_response>response:function_name{data}<tool_response|>`
- **KEY:** Tool response is injected back into the SAME model turn (not a separate turn)
- Model continues generation after seeing tool response without explicit turn change

**Thought Stripping Between Turns:**

- **Standard Multi-Turn:** Must remove thoughts from previous turn before next user turn
- **Exception:** If single model turn has function calls, thoughts must NOT be removed between function calls
- **Long-Running Agents:** Can optionally summarize and re-inject thoughts as regular text

**Thinking Mode:**

- Enable with `<|think|>` token in system instruction
- Larger models (26B, 31B) may generate thoughts even when disabled → add empty channel
- Can use system instructions to control thinking depth dynamically (e.g., "think efficiently")
- ~20% cost reduction possible with "LOW" thinking instruction

### 3. Real-World Example from Documentation

Complete weather tool calling example:

```
<|turn>system
You are a helpful assistant.<|tool>declaration:get_current_temperature{
    location: string,
    unit: string (default: "celsius")
}<tool|><|think|><turn|>

<|turn>user
What's the temperature in London?<turn|>

<|turn>model
<|channel>thought
The user is asking for the temperature in London. I should call the get_current_temperature tool with location set to "London".
<channel|><|tool_call>call:get_current_temperature{location:<|"|>London<|"|>}<tool_call|><|tool_response>response:get_current_temperature{temperature:15,weather:<|"|>sunny<|"|>}<tool_response|>The temperature in London is 15 degrees and it is sunny.<turn|>
```

**Key observations:**

- Tool declaration in system prompt
- Thoughts are internal reasoning before tool call
- Tool call and response both in same model turn
- Text response after tool response in same turn
- No role/turn changes within the tool loop

### 4. JSON Chat History Format

After tool calls, the chat history should be stored as:

```json
{
  "role": "assistant",
  "tool_calls": [
    {
      "function": {
        "name": "get_current_weather",
        "arguments": { "location": "London" }
      }
    }
  ],
  "tool_responses": [
    {
      "name": "get_current_weather",
      "response": { "temperature": 15, "weather": "sunny" }
    }
  ],
  "content": "The temperature in London is 15 degrees and it is sunny."
}
```

### 5. Ollama Integration Notes (from Ollama source)

- Ollama has native `format`, `tools`, and `thinking` support
- Streaming API returns NDJSON with `message` object containing:
  - `role`, `content`
  - `tool_calls` (if present)
  - `thinking` (if thinking is enabled)
- Raw format mode (our solution) bypasses Ollama's prompt formatting
- No blocking limitations found for Gemma4 + raw format + streaming

### 6. Implementation Implications

**Stream Wrapper Design:**

- Intercept messages → apply `convertToGemma4Format()`
- Send to Ollama with `raw: true` and `streaming: true`
- Accumulate NDJSON chunks as they arrive
- Parse Gemma4 tokens from raw text using `parseGemma4Response()`
- Detect tool calls → execute → format response → inject back into prompt
- Continue streaming until no more tool calls or max iterations reached

**Tool Loop Handling:**

- Keep model turn open (don't close with `<turn|>`)
- Inject `<|tool_response>...` without wrapping in new turn
- Allow model to continue generation after response
- Track iterations to prevent infinite loops (recommended: 5-10 max)

**Thought Stripping:**

- After tool loop completes and model turn ends
- Strip all `<|channel>thought...thought|>` blocks
- Only for next user turn (not during tool loop)
- Can optionally preserve for long-running agents

### 7. Test Case Strategy

Use these realistic examples from Google docs:

**1. Simple Tool Call:**

```
System: get_current_temperature tool
User: "What's the temperature in London?"
Expected: Tool call → response → final text
```

**2. Multiple Tool Calls:**

```
User: "Compare temperatures in London, Paris, and Tokyo"
Expected: Three sequential tool calls with responses
```

**3. Thinking + Tool Call:**

```
With <|think|> enabled
Expected: Thought channel before tool call
```

**4. Tool Call with Complex Arguments:**

```
Tool expects: location (string), unit (string), format (string)
Expected: All strings properly delimited with <|"|>
```

**5. Tool Response Injection:**

```
Model outputs: <|tool_call>call:func{args}<tool_call|>
App injects: <|tool_response>response:func{data}<tool_response|>
Model continues in same turn
Expected: No turn marker, model continues
```

---

## No Blocking Limitations Found ✅

- Ollama supports raw format mode
- Ollama supports streaming with proper NDJSON parsing
- Tool calling is supported in Ollama
- Thinking tokens are recognized by Ollama
- Our formatter/parser handle all required tokens
- Implementation plan is sound and feasible

## Next Steps

1. Add comprehensive test cases using Google examples
2. Implement stream wrapper with tool loop handling
3. Wire into Ollama provider
4. Test with actual Gemma4 model
