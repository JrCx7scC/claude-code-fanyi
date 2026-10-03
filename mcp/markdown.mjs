// Splits Markdown into the plain-text pieces a machine translator should see, and puts the
// translated pieces back. Code blocks, inline code, links' targets, URLs, list markers,
// headings, quotes and table pipes never reach the translator, so it can't mangle them.

const FENCE = /^\s*(```|~~~)/
// Leading list markers, task boxes, heading hashes and quote marks, repeated (a quoted list)
const PREFIX = /^(?:\s*(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s?))*/
// Inline code, a link's target, a bare URL
const PROTECTED = /`[^`\n]+`|\]\([^)\s]+\)|https?:\/\/[^\s)>\]]+/g
const HAS_LETTER = /\p{L}/u
// Placeholders survive Apple Translation unchanged in every form tried; ⟦ ⟧ never occur in prose
const placeholder = (i) => `⟦${i}⟧`
const PLACEHOLDER = /⟦\s*(\d+)\s*⟧/g

/**
 * @param {string} text Markdown
 * @returns {{ segments: string[], rebuild: (translated: string[]) => string }}
 */
export function splitMarkdown(text) {
  const segments = []
  // Each output line is a list of literal strings and segment references
  const lines = []
  let inFence = false

  // Adds a piece of prose as a segment, its protected spans swapped for placeholders
  const prose = (s) => {
    const kept = []
    const masked = s.replace(PROTECTED, (m) => {
      kept.push(m)
      return placeholder(kept.length - 1)
    })
    if (!HAS_LETTER.test(masked.replace(PLACEHOLDER, ''))) return { literal: s }
    // Keep the surrounding spaces outside the segment; translators trim them
    const [, lead, body, trail] = masked.match(/^(\s*)([\s\S]*?)(\s*)$/)
    segments.push(body)
    return { segment: segments.length - 1, lead, trail, kept }
  }

  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      lines.push([{ literal: line }])
      continue
    }
    if (inFence) {
      lines.push([{ literal: line }])
      continue
    }
    // A table row: each cell is translated on its own, the pipes kept
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split('|')
      lines.push(cells.flatMap((cell, i) => (i ? [{ literal: '|' }, prose(cell)] : [prose(cell)])))
      continue
    }
    const prefix = line.match(PREFIX)[0]
    lines.push([{ literal: prefix }, prose(line.slice(prefix.length))])
  }

  const rebuild = (translated) =>
    lines
      .map((parts) =>
        parts
          .map((p) => {
            if ('literal' in p) return p.literal
            const out = (translated[p.segment] ?? segments[p.segment]).replace(PLACEHOLDER, (m, i) => p.kept[Number(i)] ?? m)
            return p.lead + out.trim() + p.trail
          })
          .join(''),
      )
      .join('\n')

  return { segments, rebuild }
}

/**
 * The prose of a Markdown text: code blocks, inline code, link targets and URLs removed. What
 * language checks should look at, so identifiers and commands don't count as English.
 * @param {string} text Markdown
 * @returns {string}
 */
export function proseOf(text) {
  let inFence = false
  return text
    .split('\n')
    .filter((line) => {
      if (FENCE.test(line)) {
        inFence = !inFence
        return false
      }
      return !inFence
    })
    .join('\n')
    .replace(PROTECTED, ' ')
}
