# Gemma 4 Agentic API (GTR) Documentation

This document describes the **GTR (Gemma Token-level Robust)** API, a secure, spec-compliant agentic interface designed specifically for Gemma 4 models in Ollama.

## Overview

The GTR API provides a low-level, token-accurate interface for managing complex agentic workflows. It ensures that structural boundaries (like thinking states and tool calls) are handled with mathematical precision by operating directly on the model's token stream rather than using vulnerable string-based heuristics.

---

## The Agentic Orchestrator Loop (Client Guide)

When interacting with the `/api/gtrchat` endpoint, the client orchestrator must manage the conversation state based on the events emitted by the server.

### Understanding Token Swallowing

Gemma 4 inherently uses structural tokens like `<|tool_response>` and `<turn|>` to signal the end of its generation. **These tokens are explicitly swallowed** by the C++ execution engine and will NEVER appear in the response text or as discrete events.

Instead, the client must rely entirely on the `status` field of the final `done` event to know exactly what the model expects next.

#### Scenario 1: Model Emits a Tool Call (`status: "call_wait"`)

If the model decides to use a tool, it outputs a `<|tool_call>`, which the API parses and streams as a `{"type": "tool_call"}` event. The model then generates a `<|tool_response>` token, indicating it is waiting for your system's input.

1. The engine swallows the `<|tool_response>` token and stops.
2. The GTR API emits: `{"type": "done", "status": "call_wait"}`.
3. **Client Action**: The orchestrator must parse the tool call, execute the function locally, and append a **single** `model` turn containing _both_ the `toolcall` and `toolresponse` components. Do _not_ prompt the user. You must immediately send this updated history back to `/api/gtrchat` so the model can read the result and continue reasoning.

#### Scenario 2: Model Answers the User (`status: "complete"`)

If the model does not call a tool or has finished providing a final answer after reading a tool response, it will generate a `<turn|>` token to end its turn.

1. The engine swallows the `<turn|>` token and stops.
2. The GTR API emits: `{"type": "done", "status": "complete"}`.
3. **Client Action**: The orchestrator knows the model is fully finished. The orchestrator should now display the final text response to the user and wait for new human input before making another API request.

### Example Orchestrator Flow

#### 1. Initial Request

The client sends the system instructions, tool schema, and the user's initial query. Notice `thinking_enabled: true` to trigger the `<|think|>` protocol.

```json
{
  "model": "gemma4:31b",
  "stream": true,
  "turns": [
    {
      "role": "system",
      "thinking_enabled": true,
      "components": [
        { "ctype": "system_text", "data": { "text": "You are a travel agent." } },
        {
          "ctype": "tool_schema",
          "data": {
            "tools": [
              { "name": "get_weather", "args": [{ "name": "location", "arg_type": "string" }] }
            ]
          }
        }
      ]
    },
    {
      "role": "user",
      "components": [{ "ctype": "answer", "data": { "text": "What is the temperature in Tokyo?" } }]
    }
  ]
}
```

#### 2. Model Responds with Tool Call

The API streams back `thinking` chunks, then a parsed tool call, and finishes with `call_wait`:

```json
{"type": "thinking", "content": "I need to check the weather..."}
{"type": "tool_call", "tool_call": {"name": "get_weather", "args": [{"key": "location", "val": "Tokyo"}]}}
{"type": "done", "status": "call_wait"}
```

#### 3. Client Executes Tool & Resubmits

The client sees `status: "call_wait"`. It executes `get_weather("Tokyo")`, gets `{ "temp": 15 }`, and makes a **new request**.

_Crucial Implementation Rule_: The historical tool call request (`toolcall`) and the execution result (`toolresponse`) must be grouped together under a `model` turn.

```json
{
  "model": "gemma4:31b",
  "stream": true,
  "turns": [
    {
      "role": "system", ... // Same as before
    },
    {
      "role": "user", ... // Same as before
    },
    {
      "role": "model",
      "components": [
        { "ctype": "tool_call", "data": {"name": "get_weather", "args": [{"key": "location", "val": "Tokyo"}]} },
        { "ctype": "tool_response", "data": {"name": "get_weather", "args": [{"key": "temp", "val": "15"}]} }
      ]
    }
  ]
}
```

#### 4. Model Reads Data and Completes

The model reads the injected tool results, continues reasoning if needed, and finally responds to the user.

```json
{"type": "text", "content": "The temperature in Tokyo is currently 15 degrees."}
{"type": "done", "status": "complete"}
```

The client sees `status: "complete"`, renders the text to the user, and waits for a new user turn.

---

## API Data Contract Reference

### Request Object: `GTRChatRequest`

| Field         | Type    | Description                                                                            |
| :------------ | :------ | :------------------------------------------------------------------------------------- |
| `model`       | string  | **Required**. The model name (e.g., `gemma4:31b`).                                     |
| `turns`       | array   | **Required**. A list of conversation turns. See `GTRChatTurn`.                         |
| `stream`      | boolean | Optional. If `true`, the response is streamed as multiple events. Defaults to `false`. |
| `stream_mode` | string  | Optional. Defaults to `"structured"`. Options: `"structured"` or `"raw"`.              |
| `options`     | object  | Optional. Standard model parameter overrides (e.g., `temperature`, `top_p`, `stop`).   |
| `keep_alive`  | string  | Optional. Duration the model should stay loaded (e.g., `"5m"`).                        |

### Turn Object: `GTRChatTurn`

| Field              | Type    | Description                                                                                                              |
| :----------------- | :------ | :----------------------------------------------------------------------------------------------------------------------- | ----- | --------------------- |
| `role`             | string  | One of: `system`, `user`, or `model`.                                                                                    |
| `thinking_enabled` | boolean | **Thinking Trigger**. If `true` (typically in the `system` turn), activates Gemma 4's chain-of-thought engine via the `< | think | >` structural marker. |
| `components`       | array   | Typed content blocks. See `GTRChatComponent`.                                                                            |

### Component Object: `GTRChatComponent`

Each component has a `ctype` (Component Type) which determines the structure of its `data` field.

| `ctype`         | Data Structure      | Description                                         |
| :-------------- | :------------------ | :-------------------------------------------------- |
| `system_text`   | `GTRTextData`       | Core system instructions.                           |
| `answer`        | `GTRTextData`       | Standard user queries or model text responses.      |
| `thinking`      | `GTRTextData`       | Historical reasoning blocks for context retention.  |
| `tool_schema`   | `GTRToolSchemaData` | Definitions of functions available to the model.    |
| `tool_call`     | `GTRToolCallData`   | A record of a function call performed by the model. |
| `tool_response` | `GTRToolCallData`   | The result of a function execution.                 |
| `image`         | `GTRMultimodalData` | Base64-encoded image data.                          |
| `audio`         | `GTRMultimodalData` | Base64-encoded audio data.                          |

---

## Component Data Structures

### `GTRTextData`

```json
{ "text": "string content" }
```

### `GTRToolSchemaData`

```json
{
  "tools": [
    {
      "name": "get_weather",
      "description": "Get current weather",
      "args": [{ "name": "location", "arg_type": "string", "description": "City" }]
    }
  ]
}
```

### `GTRToolCallData`

Used for both `toolcall` (requests) and `tool_call` (events).

```json
{
  "name": "get_weather",
  "args": [{ "key": "location", "val": "Tokyo" }]
}
```

---

## Technical Implementation & Hardening Details

The GTR API is built on several key architectural principles to ensure security and robustness.

### 1. Token-Native State Machine

Instead of parsing raw text, the server monitors the **Token ID stream** from the model runner. The parser resolves structural markers at initialization to their exact IDs (e.g., for Gemma 4 31B):

- **Thought Start**: `[100, 45518, 107]` (`<|channel>thought\n`)
- **Thought End**: `[101]` (`<channel|>`)
- **Tool Call Start**: `[48]` (`<|tool_call>`)
- **Tool Call End**: `[49]` (`<tool_call|>`)
- **String Delimiter**: `[52]` (`<|"|>`)

### 2. Injection Prevention (Restricted Tokenization)

To prevent "Prompt Injection," all user-provided components (like `answer`) are encoded using `EncodeWithAllowed` with an **empty allowed list**.

- This forces the tokenizer to treat suspected control sequences (e.g., `<|turn>`) as literal text rather than single structural tokens.
- The model's attention mechanism sees these as "shattered" sub-tokens that do not trigger state machine transitions.

### 3. Delimiter Swallowing

To ensure that tool call arguments are parsed cleanly as JSON, the parser implements **Delimiter Swallowing**.

- Structural tokens like `<|"|>` (ID 52) are explicitly identified and removed from the character stream natively.

### 4. Runner-to-Server Wire Protocol & EOS Halts

The `ollama-engine` runner delivers **TokenIDs** alongside content in every completion event.
Because system boundaries like `<|tool_response>` (50) and `<turn|>` (106) are defined as hard EOS tokens within the `Gemma 4` vocabulary, they are intentionally dropped sequence-terminators. Once emitted internally, the pipeline gracefully shuts down, bypassing standard text streams to ensure structural integrity across agentic jumps.
