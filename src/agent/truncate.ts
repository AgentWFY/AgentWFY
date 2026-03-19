/**
 * Tool result truncation utilities.
 *
 * Keeps tool results small to reduce context window consumption and API costs.
 * All LLM-bound text content passes through these limits before entering the
 * conversation history.
 */

/** Max characters for a single tool result text block sent to the LLM. */
export const TOOL_RESULT_MAX_CHARS = 50_000

/** Max lines for a single tool result text block. */
const TOOL_RESULT_MAX_LINES = 2000

/**
 * Truncate text keeping the beginning (head), with line and char limits.
 * Used for file reads, search results, and general tool output where the
 * beginning is most relevant.
 */
export function truncateHead(
  text: string,
  maxChars = TOOL_RESULT_MAX_CHARS,
  maxLines = TOOL_RESULT_MAX_LINES,
): string {
  const lines = text.split('\n')
  let result = text
  let truncated = false

  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join('\n')
    truncated = true
  }

  if (result.length > maxChars) {
    result = result.slice(0, maxChars)
    truncated = true
  }

  if (truncated) {
    const originalSize =
      text.length > 1024
        ? `${Math.round(text.length / 1024)}KB`
        : `${text.length} chars`
    return `${result}\n\n...[truncated from ${originalSize}. Request specific sections if you need more.]`
  }

  return result
}
