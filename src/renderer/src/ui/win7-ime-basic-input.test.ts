import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const chatPaneSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const oldCaretHelper = new URL('../utils/win7-ime-caret.ts', import.meta.url)

describe('Win7 搜狗安全 textarea 与彩色 emoji 覆盖层', () => {
  it('只由 Win7 平台标记启用安全输入框', () => {
    expect(appSource).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPaneSource).toContain("? 'win7-ime-safe-input'")
  })

  it('安全输入框恢复一体化视觉并保持实体系统字体输入层', () => {
    const start = chatPaneSource.indexOf('.win7-ime-safe-input {')
    const end = chatPaneSource.indexOf('.input {', start)
    const safeCss = chatPaneSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(safeCss).toContain(
      "font-family: 'Microsoft YaHei', 'Noto Sans CJK SC', sans-serif;"
    )
    expect(safeCss).toContain('background: var(--material-strong);')
    expect(safeCss).toContain('padding: 6px 8px;')
    expect(safeCss).toContain('border: none;')
    expect(safeCss).not.toContain('border-radius')
    expect(safeCss).not.toContain('PantryEmojiBlank')
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
    expect(overlayCss).toContain('background: var(--material-strong);')
    expect(overlayCss).toContain('box-shadow: 0 0 0 1px var(--material-strong);')
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
