export {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_DEFAULT_MODEL,
} from "./src/defaults.js";
export {
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  isReasoningModelHeuristic,
  queryOllamaContextWindow,
  queryOllamaModelShowInfo,
  resolveOllamaApiBase,
  type OllamaModelShowInfo,
  type OllamaModelWithContext,
  type OllamaTagModel,
  type OllamaTagsResponse,
} from "./src/provider-models.js";
export {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./src/setup.js";
export {
  buildOllamaChatRequest,
  createConfiguredOllamaCompatStreamWrapper,
  isOllamaCompatProvider,
  resolveOllamaCompatNumCtxEnabled,
  shouldInjectOllamaCompatNumCtx,
  wrapOllamaCompatNumCtx,
} from "./src/stream.js";
export {
  convertToGemma4Format,
  formatGemmaToolDeclarations,
  stringifyGemma,
} from "./src/gemma4-formatter.js";
export { Gemma4Parser, type Gemma4StreamEvent } from "./src/gemma4-parser.js";
export { createGemma4StreamFn, decodeGenerateNdjsonStream } from "./src/gemma4-stream.js";
