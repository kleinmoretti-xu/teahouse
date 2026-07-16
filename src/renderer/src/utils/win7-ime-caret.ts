/**
 * 刷新 Win7 Chromium 108 的文本输入客户端（决议 #256）。
 *
 * Win7 恒走 IMM32。原生 textarea 从 NONE 回到可输入状态时，Chromium 会重新发布文本
 * 输入状态与 selection bounds，InputMethodWinImm32 随后重取 caret bounds 并同步候选窗
 * 与临时系统 caret。这里把影响限制在主聊天输入框，并完整保存/恢复用户选区和滚动位置。
 */
export interface Win7ImeTextArea {
  disabled: boolean
  selectionStart: number | null
  selectionEnd: number | null
  selectionDirection: 'forward' | 'backward' | 'none' | null
  scrollTop: number
  scrollLeft: number
  blur(): void
  focus(options?: FocusOptions): void
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void
}

export interface Win7ImeCaretRefreshState {
  windows7: boolean
  active: boolean
  composing: boolean
}

export function refreshWin7ImeCaret(
  textarea: Win7ImeTextArea,
  state: Win7ImeCaretRefreshState
): boolean {
  if (!state.windows7 || !state.active || state.composing || textarea.disabled) return false

  const start = textarea.selectionStart ?? 0
  const end = textarea.selectionEnd ?? start
  const direction = textarea.selectionDirection
  const scrollTop = textarea.scrollTop
  const scrollLeft = textarea.scrollLeft

  textarea.blur()
  textarea.focus({ preventScroll: true })
  if (direction) textarea.setSelectionRange(start, end, direction)
  else textarea.setSelectionRange(start, end)
  textarea.scrollTop = scrollTop
  textarea.scrollLeft = scrollLeft
  return true
}
