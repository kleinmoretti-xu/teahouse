import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  installWin7ImeFocusHeal,
  WIN7_IME_HEAL_DELAY_MS,
  type HealableWindow
} from './win7-ime-focus'

function fakeWindow(overrides: Partial<HealableWindow> = {}) {
  const listeners: Array<() => void> = []
  const win = {
    isDestroyed: vi.fn().mockReturnValue(false),
    isVisible: vi.fn().mockReturnValue(true),
    isMinimized: vi.fn().mockReturnValue(false),
    isFocused: vi.fn().mockReturnValue(true),
    show: vi.fn(),
    on: vi.fn((_event: 'focus', listener: () => void) => listeners.push(listener)),
    ...overrides
  }
  return { win, focus: () => listeners.forEach((fn) => fn()) }
}

describe('Win7 输入法焦点自愈', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('非 Win7 不安装、不监听', () => {
    const { win } = fakeWindow()
    expect(installWin7ImeFocusHeal(win, false)).toBe(false)
    expect(win.on).not.toHaveBeenCalled()
  })

  it('获得焦点后延迟重走原生 show 流程', () => {
    const { win, focus } = fakeWindow()
    expect(installWin7ImeFocusHeal(win, true)).toBe(true)

    focus()
    expect(win.show).not.toHaveBeenCalled()
    vi.advanceTimersByTime(WIN7_IME_HEAL_DELAY_MS)
    expect(win.show).toHaveBeenCalledTimes(1)
  })

  it('延迟窗口内重复 focus 只自愈一次', () => {
    const { win, focus } = fakeWindow()
    installWin7ImeFocusHeal(win, true)

    focus()
    focus()
    focus()
    vi.runAllTimers()
    expect(win.show).toHaveBeenCalledTimes(1)

    focus()
    vi.runAllTimers()
    expect(win.show).toHaveBeenCalledTimes(2)
  })

  it('已销毁 / 失焦 / 最小化 / 隐藏时放弃自愈', () => {
    for (const overrides of [
      { isDestroyed: vi.fn().mockReturnValue(true) },
      { isFocused: vi.fn().mockReturnValue(false) },
      { isMinimized: vi.fn().mockReturnValue(true) },
      { isVisible: vi.fn().mockReturnValue(false) }
    ] satisfies Array<Partial<HealableWindow>>) {
      const { win, focus } = fakeWindow(overrides)
      installWin7ImeFocusHeal(win, true)
      focus()
      vi.runAllTimers()
      expect(win.show).not.toHaveBeenCalled()
    }
  })

  it('主窗口与设置窗口都安装自愈', () => {
    const mainSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')
    const settingsSource = readFileSync(
      new URL('../windows/settings-window.ts', import.meta.url),
      'utf8'
    )
    expect(mainSource).toContain('installWin7ImeFocusHeal(mainWindow)')
    expect(settingsSource).toContain('installWin7ImeFocusHeal(win)')
  })
})
