import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const messageSource = readFileSync(new URL('../components/MessageRow.vue', import.meta.url), 'utf8')
const fileCardSource = readFileSync(new URL('../components/FileCard.vue', import.meta.url), 'utf8')
const fileIconSource = readFileSync(new URL('../components/FileTypeIcon.vue', import.meta.url), 'utf8')

function ruleBody(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))
  expect(match, `缺少样式规则 ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

function readPngHeader(path: URL): { width: number; height: number; bitDepth: number; colorType: number } {
  const png = readFileSync(path)
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  return {
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
    bitDepth: png[24],
    colorType: png[25]
  }
}

describe('消息与文件视觉统一', () => {
  it('文字气泡移除顶部高光', () => {
    expect(ruleBody(messageSource, '.row.peer .bubble')).not.toContain('--highlight-edge')
    expect(ruleBody(messageSource, '.row.mine .bubble')).not.toContain('--highlight-edge')
    expect(ruleBody(messageSource, '.row.mine .bubble')).toContain('box-shadow: none')
  })

  it('文字气泡与文件卡统一四角 14px', () => {
    expect(ruleBody(messageSource, '.bubble')).toContain('border-radius: 14px')
    expect(ruleBody(fileCardSource, '.card')).toContain('border-radius: 14px')
  })

  it('文件类型 atlas 是 1024 RGBA PNG', () => {
    expect(
      readPngHeader(new URL('../assets/file-types/file-type-atlas.png', import.meta.url))
    ).toEqual({ width: 1024, height: 1024, bitDepth: 8, colorType: 6 })
  })

  it('文件类型组件使用 atlas 并覆盖全部类型', () => {
    expect(fileIconSource).toContain("file-type-atlas.png?url")
    expect(fileIconSource).not.toContain('<svg')
    const atlasPositions = fileIconSource.match(/const ATLAS_POS[\s\S]*?\n\}/)?.[0] ?? ''
    for (const type of [
      'word', 'excel', 'ppt', 'pdf', 'archive', 'image', 'audio', 'video',
      'text', 'code', 'app', 'generic', 'folder'
    ]) {
      expect(atlasPositions).toContain(`${type}: [`)
    }
  })
})
