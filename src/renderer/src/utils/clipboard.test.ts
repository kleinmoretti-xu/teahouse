import { afterEach, describe, expect, it } from 'vitest'
import {
  NATIVE_IMAGE_FALLBACK_SUPPRESS_MS,
  readClipboardTableText,
  hasClipboardText,
  imageMimeFromExt,
  shouldSuppressNativeImageFallback
} from './clipboard'
import { TABLE_TEXT_LIMIT_BYTES } from '../../../shared/protocol'

const nativeDomParser = globalThis.DOMParser

afterEach(() => {
  globalThis.DOMParser = nativeDomParser
})

function installTinyTableParser(): void {
  globalThis.DOMParser = class {
    parseFromString(html: string): Document {
      const rows = Array.from(html.matchAll(/<tr[\s\S]*?>([\s\S]*?)<\/tr>/gi)).map((rowMatch) => {
        const cells = Array.from(rowMatch[1].matchAll(/<t[hd][\s\S]*?>([\s\S]*?)<\/t[hd]>/gi)).map(
          (cellMatch) => ({
            textContent: cellMatch[1].replace(/<[^>]+>/g, '')
          })
        )
        return {
          querySelectorAll: () => cells
        }
      })
      return {
        querySelector: () => ({
          querySelectorAll: () => rows
        })
      } as unknown as Document
    }
  } as typeof DOMParser
}

describe('clipboard helpers', () => {
  it('优先保留带文本的 emoji / 富文本粘贴', () => {
    expect(hasClipboardText({ getData: (type) => (type === 'text/plain' ? '😀' : '') })).toBe(true)
  })

  it('允许无文本截图继续走图片粘贴', () => {
    expect(hasClipboardText({ getData: () => '' })).toBe(false)
  })

  it('按源文件扩展名生成图片 MIME', () => {
    expect(imageMimeFromExt('.jpg')).toBe('image/jpeg')
    expect(imageMimeFromExt('.webp')).toBe('image/webp')
    expect(imageMimeFromExt('.gif')).toBe('image/gif')
    expect(imageMimeFromExt('.bin')).toBe('image/png')
  })

  it('浏览器 paste 已消费时短时间内抑制原生图片兜底', () => {
    expect(shouldSuppressNativeImageFallback(1_000, 1_000)).toBe(true)
    expect(shouldSuppressNativeImageFallback(1_000, 1_000 + NATIVE_IMAGE_FALLBACK_SUPPRESS_MS - 1)).toBe(true)
    expect(shouldSuppressNativeImageFallback(1_000, 1_000 + NATIVE_IMAGE_FALLBACK_SUPPRESS_MS)).toBe(false)
    expect(shouldSuppressNativeImageFallback(0, 1_000)).toBe(false)
  })

  it('识别 HTML table 或多行 TSV 为表格粘贴', () => {
    installTinyTableParser()
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<table><tr><td>A</td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>'
          if (type === 'text/plain') return '网页复制的普通文本'
          return ''
        }
      })
    ).toEqual({ tableText: 'A\tB\n1\t2', tableTextTruncated: false })

    expect(
      readClipboardTableText({
        getData: (type) => (type === 'text/plain' ? 'A\tB\n1\t2' : '')
      })
    ).toEqual({ tableText: 'A\tB\n1\t2', tableTextTruncated: false })
  })

  it('普通富文本 emoji 不按表格粘贴处理', () => {
    expect(
      readClipboardTableText({
        getData: (type) => {
          if (type === 'text/html') return '<span>😀</span>'
          if (type === 'text/plain') return '😀'
          return ''
        }
      })
    ).toBeNull()
  })

  it('表格文字按 UTF-8 字节安全截断并标记', () => {
    const source = Array.from({ length: TABLE_TEXT_LIMIT_BYTES }, () => '表\t格').join('\n')
    const result = readClipboardTableText({
      getData: (type) => {
        if (type === 'text/plain') return source
        return ''
      }
    })

    expect(result?.tableTextTruncated).toBe(true)
    expect(new TextEncoder().encode(result?.tableText ?? '').byteLength).toBeLessThanOrEqual(
      TABLE_TEXT_LIMIT_BYTES
    )
    expect(result?.tableText.endsWith('�')).toBe(false)
  })
})
