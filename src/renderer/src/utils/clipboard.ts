import { TABLE_TEXT_LIMIT_BYTES } from '../../../shared/protocol'
import type { TableTextMeta } from '../../../shared/ipc'

export interface ClipboardTextSource {
  getData(type: string): string
}

export type ClipboardTableText = TableTextMeta

export function hasClipboardText(data: ClipboardTextSource): boolean {
  return data.getData('text/plain').length > 0
}

export function readClipboardTableText(data: ClipboardTextSource): ClipboardTableText | null {
  const html = data.getData('text/html')
  const plain = normalizeClipboardText(data.getData('text/plain'))
  const hasTableHtml = /<table[\s>]/i.test(html)
  const htmlText = hasTableHtml ? tableHtmlToText(html) : ''
  const text = hasTableHtml ? htmlText || plain : plain
  if (!text) return null
  if (!hasTableHtml && !isTsvTableText(text)) return null
  const truncated = truncateUtf8(text, TABLE_TEXT_LIMIT_BYTES)
  return {
    tableText: truncated.text,
    tableTextTruncated: truncated.truncated
  }
}

export const NATIVE_IMAGE_FALLBACK_SUPPRESS_MS = 300

export function shouldSuppressNativeImageFallback(
  lastPasteHandledAt: number,
  now = Date.now()
): boolean {
  return (
    lastPasteHandledAt > 0 &&
    now >= lastPasteHandledAt &&
    now - lastPasteHandledAt < NATIVE_IMAGE_FALLBACK_SUPPRESS_MS
  )
}

export function imageMimeFromExt(ext: string): string {
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return 'image/png'
}

export function normalizeClipboardText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function isTsvTableText(text: string): boolean {
  if (!text.includes('\t')) return false
  return text.split('\n').filter((line) => line.length > 0).length >= 2
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(text).byteLength <= maxBytes) return { text, truncated: false }
  let out = ''
  let used = 0
  for (const char of text) {
    const size = encoder.encode(char).byteLength
    if (used + size > maxBytes) break
    out += char
    used += size
  }
  return { text: out, truncated: true }
}

function tableHtmlToText(html: string): string {
  if (typeof DOMParser === 'undefined') return ''
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const table = doc.querySelector('table')
  if (!table) return ''
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th,td'))
        .map((cell) => normalizeClipboardText(cell.textContent ?? '').trim())
        .join('\t')
    )
    .filter((row) => row.length > 0)
    .join('\n')
}
