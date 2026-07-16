import { describe, expect, it } from 'vitest'
import { nextWin7ImeCaretNudge } from './win7-ime-caret'

describe('Win7 搜狗输入法 caret 几何脉冲', () => {
  it('只在 Win7 且输入框活动时交替 0–1px', () => {
    expect(nextWin7ImeCaretNudge(0, true, true)).toBe(1)
    expect(nextWin7ImeCaretNudge(1, true, true)).toBe(0)
  })

  it('其他系统或输入框失焦时复位', () => {
    expect(nextWin7ImeCaretNudge(1, false, true)).toBe(0)
    expect(nextWin7ImeCaretNudge(1, true, false)).toBe(0)
  })
})
