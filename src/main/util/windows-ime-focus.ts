export interface FocusableWebContents {
  isDestroyed(): boolean
  focus(): void
}

/**
 * Win7 Chromium 108 的 IMM32Manager 只在目标 HWND 持有 Win32 键盘焦点时更新候选窗。
 * 直接聚焦 WebContents 原生视图，避免 DOM textarea 有焦点但系统焦点句柄仍停在外层窗口。
 */
export function focusWindowsImeTarget(
  contents: FocusableWebContents | null | undefined,
  windows7: boolean
): boolean {
  try {
    if (!windows7 || !contents || contents.isDestroyed()) return false
    contents.focus()
    return true
  } catch {
    return false
  }
}
