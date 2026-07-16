export type Win7ImeCaretNudge = 0 | 1

/**
 * Win7 搜狗组合输入期间交替移动 1px，触发 Chromium 108 重算编辑光标几何。
 * 其他系统或 textarea 已失焦时保持零值，不产生任何布局扰动。
 */
export function nextWin7ImeCaretNudge(
  current: Win7ImeCaretNudge,
  windows7: boolean,
  inputActive: boolean
): Win7ImeCaretNudge {
  if (!windows7 || !inputActive) return 0
  return current === 0 ? 1 : 0
}
