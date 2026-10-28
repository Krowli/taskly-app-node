// Deterministic prompt-injection signals in the lines a PR adds. A signal, not a filter:
// nothing is removed or blocked, the report only shows where to look.
const MAX_SIGNALS = 20

const HIDDEN_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/

// Moderate on purpose: phrases that address a reader that is an AI agent.
export const ADDRESSED_TO_AI = /(ignore|disregard)\s+(all\s+|any\s+)?(previous|prior|above)\s+(instructions|rules)|(note|message|instructions?)\s+(to|for)\s+(ai|llm|agents?|assistants?)|\bai\s+agents?\b|system\s+prompt/i

// diffFiles: Map of path -> { added: [{ line, text }] } as returned by parseFileDiffs.
export function injectionSignals(diffFiles) {
  const signals = []
  for (const [path, { added }] of diffFiles) {
    for (const { line, text } of added) {
      if (HIDDEN_CHARACTERS.test(text)) signals.push({ path, line, kind: 'hidden-characters' })
      else if (ADDRESSED_TO_AI.test(text)) signals.push({ path, line, kind: 'addressed-to-ai' })
      if (signals.length >= MAX_SIGNALS) return signals
    }
  }
  return signals
}
