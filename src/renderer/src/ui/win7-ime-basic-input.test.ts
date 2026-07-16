import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const appSource = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
const chatPaneSource = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
const oldCaretHelper = new URL('../utils/win7-ime-caret.ts', import.meta.url)

describe('Win7 搜狗基础 textarea 诊断画像', () => {
  it('只由 Win7 平台标记启用基础输入框', () => {
    expect(appSource).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPaneSource).toContain("? 'win7-ime-basic-input'")
    expect(chatPaneSource).toContain('() => !props.win7ImeCompat &&')
  })

  it('基础输入框绕开自定义字体、镜像透明层和定位样式', () => {
    const start = chatPaneSource.indexOf('.win7-ime-basic-input {')
    const end = chatPaneSource.indexOf('.input {', start)
    const basicCss = chatPaneSource.slice(start, end)

    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(basicCss).toContain("font-family: 'Microsoft YaHei', sans-serif;")
    expect(basicCss).toContain('background: var(--bg-window);')
    expect(basicCss).toContain('padding: 6px 8px;')
    expect(basicCss).not.toContain('PantryEmojiBlank')
    expect(basicCss).not.toContain('transparent')
    expect(basicCss).not.toContain('position:')
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
