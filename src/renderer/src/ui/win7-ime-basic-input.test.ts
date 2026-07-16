import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const chatPaneSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const compatEmojiSource = readFileSync(new URL('../components/CompatEmoji.vue', import.meta.url), 'utf8')
const emojiFontGeneratorSource = readFileSync(
  new URL('../../../../scripts/gen-emoji-blank-font.mjs', import.meta.url),
  'utf8'
)
const oldCaretHelper = new URL('../utils/win7-ime-caret.ts', import.meta.url)

describe('Win7 搜狗安全 textarea 与彩色 emoji 覆盖层', () => {
  it('只由 Win7 平台标记启用安全输入框', () => {
    expect(appSource).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPaneSource).toContain("? 'win7-ime-safe-input'")
  })

  it('安全输入框恢复 1.3em 等宽表情槽并保持实体输入层', () => {
    const start = chatPaneSource.indexOf('.win7-ime-safe-input {')
    const end = chatPaneSource.indexOf('.input {', start)
    const safeCss = chatPaneSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(safeCss).toContain("'PantryEmojiBlank',")
    expect(safeCss).toContain("'Microsoft YaHei',")
    expect(safeCss).toContain('background: var(--material-strong);')
    expect(safeCss).toContain('padding: 6px 8px;')
    expect(safeCss).toContain('border: none;')
    expect(safeCss).not.toContain('border-radius')
    expect(safeCss).not.toContain('transparent')
    expect(safeCss).not.toContain('position:')
  })

  it('Win7 恢复 Twemoji，但透明展示层不改变真实输入层', () => {
    expect(chatPaneSource).toContain("'win7-ime-emoji-overlay': props.win7ImeCompat")
    expect(chatPaneSource).toContain('draftEmojiParts.value.some((part) => part.emoji)')

    const start = chatPaneSource.indexOf('.input-mirror.win7-ime-emoji-overlay {')
    const end = chatPaneSource.indexOf('.input-mirror-content {', start)
    const overlayCss = chatPaneSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(overlayCss).toContain('z-index: 1;')
    expect(overlayCss).toContain('color: transparent;')
    expect(overlayCss).toContain('padding: 6px 8px;')
    expect(overlayCss).toContain("'PantryEmojiBlank',")
    expect(overlayCss).toContain("'Microsoft YaHei',")
    expect(overlayCss).not.toContain('background:')
    expect(overlayCss).not.toContain('box-shadow:')
  })

  it('输入槽和发送后表情使用同一 1.3em 尺寸', () => {
    expect(emojiFontGeneratorSource).toContain('const EM_ADVANCE = 1300')
    expect(compatEmojiSource).toContain('width: 1.3em;')
    expect(compatEmojiSource).toContain('height: 1.3em;')
    expect(chatPaneSource).toContain('width: min(1.3em, 100%);')
  })

  it('完整撤销实机无效的 composition 几何脉冲', () => {
    expect(existsSync(oldCaretHelper)).toBe(false)
    expect(chatPaneSource).not.toContain('pulseWin7ImeCaretGeometry')
    expect(chatPaneSource).not.toContain('resetWin7ImeCaretGeometry')
    expect(chatPaneSource).not.toContain('@compositionstart')
    expect(chatPaneSource).not.toContain('@compositionupdate')
    expect(chatPaneSource).not.toContain('@compositionend')
    expect(chatPaneSource).not.toContain('input.style.paddingLeft')
    expect(chatPaneSource).not.toContain('input.getBoundingClientRect()')
  })
})
