# Plan: Gemma4 Integration for OpenClaw Ollama Provider

Complete end-to-end Gemma4 support with raw format mode, streaming working, tool calling, and thought handling. Build model-aware stream wrapper, integrate parser/formatter into Ollama pipeline, and add integration tests.

If needed, look up ollama source code at https://github.com/ollama/ollama to understand how to best integrate the Gemma4-specific stream wrapper and ensure it integrates seamlessly with Ollama implementation. Before implementing, check the ollama source code to understand if there are any blocking limitations in the third-party implementation that would prevent us from implementing the required features for Gemma4 support, and if so, adjust the implementation plan accordingly to work around those limitations.

For expanding the tests, also make sure to use the exact good examples from the Google documentation: https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4.md.txt to create realistic test cases that reflect actual usage scenarios of Gemma4's raw format mode, tool calling, and thinking capabilities. This will ensure our tests are aligned with real-world use cases and provide robust coverage for the new features we are implementing.

### 1. Create Gemma4-specific stream wrapper

**File:** `extensions/ollama/src/gemma4-stream.ts`

Create `createGemma4StreamFn()` to:

- Wrap the Ollama stream function
- Detect Gemma4 models (by name pattern or config)
- Format outgoing messages using `convertToGemma4Format()`
- Parse raw responses using `parseGemma4Response()`
- Implement tool call loop handling with iteration limits
- Inject tool responses back into the prompt for model continuation
- Strip previous thoughts when looping on tool calls

Key concerns:

- Tool call loop termination strategy (max iterations, timeout, force-exit conditions)
- How to handle incomplete responses mid-stream
- Graceful error handling for malformed tool calls

### 2. Integrate wrapper into Ollama factory

**File:** `extensions/ollama/src/index.ts`

Modify to:

- Detect Gemma4 models (by name pattern like `gemma*`, `ollama/gemma*` or explicit config flag)
- Apply Gemma4 wrapper to the stream pipeline
- Handle configuration validation (`raw: true`, `streaming: true` required)
- Emit warnings if Gemma4 model is configured without raw format
- Chain wrapper into existing Ollama stream wrapper stack

### 3. Add Gemma4 model definitions

**File:** `extensions/ollama/src/models.ts` (or workspace config)

Define at least one Gemma4 model entry:

```typescript
{
  id: "gemma4",
  name: "Gemma 4",
  input: ["text"],
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8192,
  maxTokens: 4096,
  extraParams: {
    raw: true,
    streaming: true
  }
}
```

Include multiple variants (different context windows, reasoning settings).

### 4. Expand formatter tests

**File:** `extensions/ollama/src/gemma4-formatter.test.ts`

Add test cases for:

- Mixed content (thinking + tool calls + text in single response)
- Thinking preservation across tool loops (should preserve in tool calls, strip between turns)
- Large tool sets (10+ tools in declarations)
- Edge cases: empty arguments, deeply nested objects, special characters in tool names
- Tool declaration ordering and deduplication
- System prompt merging with first user turn (if required by model version)
- Consecutive tool calls without text between them
- Message history truncation/stripping

### 5. Expand parser tests

**File:** `extensions/ollama/src/gemma4-parser.test.ts`

Add test cases for:

- Streaming chunk accumulation (receiving tokens one at a time)
- Incomplete token sequences mid-stream (partial `<|tool_call>` markers)
- Tool response loop scenarios: model outputs tool call → tool response injected → model continues
- Malformed tool calls (missing `{}`, invalid JSON arguments)
- Mixed thinking + tool calls + text in single response
- Multiple consecutive tool calls with responses
- Edge case: text appearing after tool calls (should be captured correctly)
- Performance with large responses (1000+ token responses)
- Error recovery: incomplete closing markers, nested delimiters

### 6. Build integration test suite

**File:** `extensions/ollama/src/gemma4-integration.test.ts` (NEW)

Create comprehensive tests covering:

- **Full tool call loop:** Request → Format → Send → Receive tool call tokens → Parse → Inject response → Continue
- **Streaming with Gemma4 tokens:** Receive NDJSON chunks with raw Gemma4 format, accumulate and parse correctly
- **Response parsing:** Extract text, thoughts, tool calls, and tool responses from raw output
- **Multiple tool calls:** Single response with 2+ tool calls, verify all are extracted and sequenced
- **Error scenarios:** Malformed tokens, incomplete responses, network errors
- **Edge cases:** Empty response, only thinking/only tool calls, tool call with no text, etc.
- **Performance:** Measure streaming latency with varying response sizes
- Mock tests (using fake Ollama responses) for deterministic testing
- Optional: Live tests with actual Ollama instance (requires `OPENCLAW_LIVE_TEST=1`)

### 7. Wire API/runtime exports

**File:** `extensions/ollama/api.ts` and `runtime-api.ts`

Verify exports include:

- `createGemma4StreamFn` (new stream wrapper)
- All Gemma4 formatter functions (already exported)
- All Gemma4 parser functions (already exported)
- Gemma4 control tokens constant (already exported)
- Type definitions for parsed responses

### 8. Update documentation

**File:** `docs/providers/ollama.md`

Add/enhance sections:

- **Implementation Details:** How raw format mode works, why it's needed for Gemma4
- **Configuration Guide:** Step-by-step setup for Gemma4 models with raw format
- **Tool Integration:** How tool calling works in Gemma4, tool loop behavior
- **Thinking Mode:** How to enable internal reasoning, thinking token handling
- **Troubleshooting:**
  - Common issues with raw format (e.g., tokens visible in output)
  - How to verify raw format is working
  - Performance tuning tips
  - Error messages and solutions
- **Examples:**
  - Complete config example with all parameters
  - Example Gemma4 conversation with tool calls and thinking
  - Tool calling loop walkthrough

---

## Further Considerations

### Tool Call Loop Termination

- **Max iterations:** Enforce global limit (e.g., 5-10 tool calls per request) to prevent infinite loops
- **Detection logic:** Track if model outputs same tool call repeatedly without change → force exit
- **Timeout:** Set time limit for entire tool loop sequence
- **User control:** Allow configuration of loop limits per model or request

### Thinking Mode Integration

- **Auto-enable:** If `agents.defaults.thinking.enabled = true`, should Gemma4 automatically use thinking?
- **Config option:** Allow per-model flag to control thinking behavior
- **Level mapping:** How to map OpenClaw thinking levels (minimal/low/medium/high) to Gemma4 thinking tokens?
- **Thought stripping:** When to preserve vs. strip thoughts in multi-turn conversations?

### Error Recovery

- **Malformed tool calls:** Log warning, skip malformed call, continue processing
- **Incomplete responses:** Decide if stream should continue waiting or close
- **Graceful degradation:** If tool call fails to parse, treat response as pure text?
- **Retry policy:** Should failed tool calls automatically retry, or bubble error up?

### Model Detection Strategy

- **Pattern matching:** Check if model name contains "gemma" (case-insensitive)
- **Explicit flag:** Allow user to set `isGemma4: true` in model config
- **Config-based:** Read from model's metadata in workspace configuration
- **Fallback:** Ask user during setup if model appears unknown

### Performance Baseline

- **Latency targets:** Should establish baseline for streaming first token, tool call extraction time
- **Throughput:** Measure tokens/sec with various response sizes
- **Memory usage:** Track peak memory during large tool loops
- **Optimization:** Identify bottlenecks before adding streaming optimizations

---

## COMPLETED ✅ vs. TODO 🔲

### Pending Implementation

- 🔲 Gemma4 control token definitions (`GEMMA4_CONTROL_TOKENS`)
- 🔲 Formatter module with all functions:
  - escaping, tool args, tool calls, system prompts, turns, thoughts
  - declarations, message conversion, thought stripping
- 🔲 Parser module with all functions:
  - unescaping, arg parsing, thought extraction, tool call extraction
  - tool response extraction, text extraction, response completion detection, full parsing
- 🔲 Comprehensive formatter tests (23/23 passing)
  - All token types and combinations covered
- 🔲 Comprehensive parser tests (33/33 passing)
  - All parsing scenarios and edge cases covered
- 🔲 API exports in `api.ts` and `runtime-api.ts`
- 🔲 Ollama provider documentation with Gemma4 configuration section

- 🔲 **High Priority - Core Integration:**
  - Create Gemma4-specific stream wrapper function
  - Implement Ollama provider model detection for Gemma4
  - Wire wrapper into Ollama factory

- 🔲 **High Priority - Tool Loop Handling:**
  - Implement tool call loop handler with iteration limits
  - Format tool responses for loop continuation
  - Inject responses back into prompt stream

- 🔲 **High Priority - Streaming:**
  - Apply formatter to outgoing messages in stream
  - Parse raw Gemma4 responses from API
  - Handle streaming chunk accumulation

- 🔲 **Medium Priority - Configuration & Models:**
  - Add Gemma4 model definitions to workspace config
  - Configuration validation (raw: true, streaming: true)
  - Model detection/routing logic

- 🔲 **Medium Priority - Testing:**
  - Expand formatter tests (mixed content, edge cases, large tool sets)
  - Expand parser tests (streaming chunks, incomplete tokens, loops)
  - Build integration test suite (tool loops, streaming, errors)
  - Live tests with actual Ollama instance

- 🔲 **Lower Priority - Polish:**
  - Documentation updates (implementation guide, troubleshooting, examples)
  - Performance profiling and optimization
  - Error handling refinement

---

## Success Criteria

- [ ] All 56 existing tests continue to pass (formatter + parser)
- [ ] New formatter tests added covering edge cases (target: +10 tests)
- [ ] New parser tests added covering streaming scenarios (target: +15 tests)
- [ ] Integration tests for complete tool call loops (target: 10+ tests)
- [ ] Gemma4 model can be configured in workspace with raw format
- [ ] Streaming requests to Gemma4 models work end-to-end
- [ ] Tool calls are detected, parsed, and looped correctly
- [ ] Thoughts are extracted and managed across tool loops
- [ ] Documentation covers setup, usage, troubleshooting
- [ ] No breaking changes to existing Ollama provider functionality

---

## File Structure After Implementation

```
extensions/ollama/src/
├── gemma4-formatter.ts          (existing - complete)
├── gemma4-formatter.test.ts     (existing - expand)
├── gemma4-parser.ts             (existing - complete)
├── gemma4-parser.test.ts        (existing - expand)
├── gemma4-stream.ts             (NEW - wrapper function)
├── gemma4-integration.test.ts   (NEW - integration tests)
├── index.ts                     (modify - add model detection)
├── models.ts                    (modify - add Gemma4 definitions)
├── api.ts                       (verify exports)
├── runtime-api.ts               (verify exports)
└── ...

docs/providers/
└── ollama.md                    (update - add impl details)
```

---

## Dependencies & Prerequisites

- Ollama instance running with Gemma4 model available
- Node 22+, TypeScript, Vitest
- pnpm for dependency management
- No new dependencies required (uses existing OpenClaw patterns)

---

## Risk Assessment

**Low Risk:**

- New wrapper is isolated (doesn't affect existing Ollama paths)
- Tests are comprehensive and will catch regressions
- Formatter/parser are already thoroughly tested

**Medium Risk:**

- Model detection logic must be robust (avoid false positives)
- Tool loop handling needs careful iteration limits
- Streaming integration touches core message pipeline

**Mitigations:**

- Feature flag for Gemma4 support (can be disabled if issues arise)
- Gradual rollout: test → internal staging → production
- Comprehensive logging for debugging tool loops
- Clear user docs to prevent misconfiguration
