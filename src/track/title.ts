/**
 * The filename a download lands under, and the title a map label may carry.
 *
 * Two different shortenings of the same track name, kept beside each other
 * because they are one policy: a name long enough to be interesting is a name
 * long enough to break something downstream.
 */

/** Track names run to paragraphs in real files; a filename and a map label do not. */
const MAX_TITLE = 60

/** Collapse whitespace and cap the length, or fall back when nothing is left. */
export function clipTitle(name: string, fallback = '轨迹'): string {
  const cleaned = (name || '').replace(/\s+/gu, ' ').trim()
  return cleaned.length > MAX_TITLE ? `${cleaned.slice(0, MAX_TITLE - 1)}…` : cleaned || fallback
}
