import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  refreshWin7ImeCaret,
  type Win7ImeCaretRefreshState,
  type Win7ImeTextArea
} from './win7-ime-caret'

function fakeTextArea(overrides: Partial<Win7ImeTextArea> = {}): Win7ImeTextArea {
  return {
    disabled: false,
    selectionStart: 3,
    selectionEnd: 5,
    selectionDirection: 'backward',
    scrollTop: 24,
    scrollLeft: 7,
    blur: vi.fn(),
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    ...overrides
  }
}

const ready: Win7ImeCaretRefreshState = {
  windows7: true,
  active: true,
  composing: false
}

describe('Win7 IME caret 刷新', () => {
  it('重建文本输入焦点并恢复选区和滚动位置', () => {
    const textarea = fakeTextArea()
    textarea.blur = vi.fn(() => {
      textarea.selectionStart = 0
      textarea.selectionEnd = 0
      textarea.scrollTop = 0
      textarea.scrollLeft = 0
    })

    expect(refreshWin7ImeCaret(textarea, ready)).toBe(true)
    expect(textarea.blur).toHaveBeenCalledTimes(1)
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(3, 5, 'backward')
    expect(textarea.scrollTop).toBe(24)
    expect(textarea.scrollLeft).toBe(7)
  })

  it('空选区信息退化为 0 宽选区', () => {
    const textarea = fakeTextArea({
      selectionStart: null,
      selectionEnd: null,
      selectionDirection: null
    })

    expect(refreshWin7ImeCaret(textarea, ready)).toBe(true)
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, 0)
  })

  it.each([
    ['非 Win7', { windows7: false }],
    ['输入框非活动元素', { active: false }],
    ['正在组词', { composing: true }]
  ])('%s 时跳过刷新', (_label, statePatch) => {
    const textarea = fakeTextArea()
    expect(refreshWin7ImeCaret(textarea, { ...ready, ...statePatch })).toBe(false)
    expect(textarea.blur).not.toHaveBeenCalled()
    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('输入框禁用时跳过刷新', () => {
    const textarea = fakeTextArea({ disabled: true })
    expect(refreshWin7ImeCaret(textarea, ready)).toBe(false)
    expect(textarea.blur).not.toHaveBeenCalled()
  })

  it('主聊天输入框按 Win7 标记接入焦点、窗口与 composition 门控', () => {
    const chatPane = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../App.vue', import.meta.url), 'utf8')
    const main = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

    expect(app).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPane).toContain('@focus="scheduleWin7ImeCaretRefresh"')
    expect(chatPane).toContain('queueMicrotask(() =>')
    expect(chatPane).toContain("window.addEventListener('focus', scheduleWin7ImeCaretRefresh)")
    expect(chatPane).toContain('@compositionstart="onInputCompositionStart"')
    expect(chatPane).toContain('@compositionend="onInputCompositionEnd"')
    expect(main).toContain('windows7: WINDOWS7')
    expect(main).not.toContain('installWin7ImeFocusHeal')
  })
})
