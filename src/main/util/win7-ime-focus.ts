import { isWindows7 } from './windows-version'

/** 焦点稳定后再自愈，避开激活过程中的瞬态焦点切换。 */
export const WIN7_IME_HEAL_DELAY_MS = 150

/** 只依赖 BrowserWindow 的最小子集，便于纯函数测试（分层铁律：util 可被 vitest 直接实例化）。 */
export interface HealableWindow {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
  isFocused(): boolean
  show(): void
  on(event: 'focus', listener: () => void): unknown
}

/**
 * Win7 输入法焦点自愈（决议 #255）。
 *
 * Win7 上 Chromium 108 恒走 IMM32 输入法路径（决议 #254），候选窗定位、MSAA 光标事件
 * 与 WM_IME_* 消息处理全部以「Win32 键盘焦点位于顶层窗口」为前提。焦点一旦落到内部
 * 子窗口（如 Chrome Legacy Window）：普通按键仍被转发、打字可上屏，但 WM_IME_* 不被
 * 转发，输入法退回系统默认行为——候选窗与拼音条固定在屏幕左上角；且窗口已处激活态，
 * 点击页面不会触发系统重派焦点，故障呈粘性，只有重新激活窗口才能恢复。
 *
 * 自愈方式：窗口每次获得焦点后延迟片刻重走一次原生 show 流程——views 层
 * HWNDMessageHandler::Show 结尾的 SetInitialFocus 会把 Win32 键盘焦点重新钉回顶层窗口
 * （Electron 未提供初始焦点视图，该分支恒执行）。show 对已显示且已聚焦的窗口幂等，
 * 不改变激活状态、不触发新的 focus 事件，不会形成事件循环。仅 Win7 安装。
 */
export function installWin7ImeFocusHeal(
  win: HealableWindow,
  windows7: boolean = isWindows7(),
  delayMs: number = WIN7_IME_HEAL_DELAY_MS
): boolean {
  if (!windows7) return false

  let pending = false
  win.on('focus', () => {
    if (pending) return
    pending = true
    setTimeout(() => {
      pending = false
      if (win.isDestroyed()) return
      // 已失焦/最小化/隐藏时放弃本次自愈：show 会抢前台或还原窗口，副作用大于收益
      if (!win.isVisible() || win.isMinimized() || !win.isFocused()) return
      win.show()
    }, delayMs)
  })
  return true
}
