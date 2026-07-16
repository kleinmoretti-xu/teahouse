import { describe, expect, it, vi } from 'vitest'
import { focusWindowsImeTarget } from './windows-ime-focus'

describe('Win7 输入法原生焦点', () => {
  it('只在 Win7 聚焦存活的 WebContents', () => {
    const contents = {
      isDestroyed: vi.fn().mockReturnValue(false),
      focus: vi.fn()
    }

    expect(focusWindowsImeTarget(contents, false)).toBe(false)
    expect(contents.focus).not.toHaveBeenCalled()
    expect(focusWindowsImeTarget(contents, true)).toBe(true)
    expect(contents.focus).toHaveBeenCalledTimes(1)
  })

  it('窗口缺失、销毁或退出竞态时安全跳过', () => {
    expect(focusWindowsImeTarget(null, true)).toBe(false)

    const destroyed = {
      isDestroyed: vi.fn().mockReturnValue(true),
      focus: vi.fn()
    }
    expect(focusWindowsImeTarget(destroyed, true)).toBe(false)
    expect(destroyed.focus).not.toHaveBeenCalled()

    const racing = {
      isDestroyed: vi.fn().mockReturnValue(false),
      focus: vi.fn(() => {
        throw new Error('destroyed')
      })
    }
    expect(focusWindowsImeTarget(racing, true)).toBe(false)
  })
})
