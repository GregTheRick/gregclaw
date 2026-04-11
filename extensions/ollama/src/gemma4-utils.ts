export const ANCHOR = "\u200b";
export const META_ANCHOR = "\u200c\u200c\u200c";

const CONTROL_TOKENS = [
  "<bos>",
  "<eos>",
  "<|turn>",
  "<turn|>",
  "<|channel>",
  "<channel|>",
  "<|tool_call>",
  "<tool_call|>",
  "<|tool_response>",
  "<tool_response|>",
  "<|tool|>",
  "<tool|>",
  "declaration:",
  "call:",
  "response:",
  "<|image|>",
  "<|video|>",
  "<|audio|>",
  "<|part|>",
  '<|"|>',
];

function escapeToken(token: string): string {
  if (token.includes("|")) {
    // Insert anchor before and after EVERY pipe
    return token.replace(/\|/g, `${ANCHOR}|${ANCHOR}`);
  }
  // Fallback for tokens without pipes: insert after first character
  return token[0] + ANCHOR + token.slice(1);
}

const SORTED_TOKENS = [...CONTROL_TOKENS].toSorted((a, b) => b.length - a.length);

/**
 * Escapes Gemma 4 control tokens and the anchor character itself in dynamic content.
 * Layered approach:
 * 1. Replace existing anchor (\u200b) with meta-anchor (\u200c\u200c\u200c).
 * 2. Break control tokens by inserting anchors.
 */
export function metaEscape(text: string): string {
  if (!text) {
    return text;
  }
  // 1. Meta-escape the anchor
  let result = text.split(ANCHOR).join(META_ANCHOR);

  // 2. Escape control tokens
  for (const token of SORTED_TOKENS) {
    const escaped = escapeToken(token);
    result = result.split(token).join(escaped);
  }

  return result;
}

/**
 * Reverts the escape sequences from model responses.
 * 1. Removes all anchor characters (\u200b) which were used to break control tokens.
 * 2. Restores original anchors from meta-anchors.
 */
export function metaUnescape(text: string): string {
  if (!text) {
    return text;
  }
  // 1. Remove all anchors used as escapes
  let result = text.split(ANCHOR).join("");

  // 2. Restore meta-escaped anchors
  result = result.split(META_ANCHOR).join(ANCHOR);

  return result;
}
