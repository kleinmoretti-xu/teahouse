import { release } from 'node:os'

const DISABLE_FEATURES_SWITCH = 'disable-features'
const TSF_IME_FEATURE = 'TSFImeSupport'

interface ChromiumCommandLine {
  appendSwitch(name: string, value?: string): void
  getSwitchValue(name: string): string
}

/** Windows NT 6.1 同时覆盖 Windows 7 与 Windows Server 2008 R2。 */
export function isWindows7(platform: NodeJS.Platform, osRelease: string): boolean {
  return platform === 'win32' && /^6\.1(?:\.|$)/.test(osRelease)
}

/**
 * Win7 部分旧输入法与 Chromium 108 的 TSF 路径不兼容，候选窗会回退到屏幕左上角。
 * 启动早期关闭 TSF 后 Chromium 自动使用 IMM32；其他平台继续沿用默认输入法路径。
 */
export function configureWindowsImeCompatibility(
  commandLine: ChromiumCommandLine,
  platform: NodeJS.Platform = process.platform,
  osRelease: string = release()
): boolean {
  if (!isWindows7(platform, osRelease)) return false

  const disabledFeatures = commandLine
    .getSwitchValue(DISABLE_FEATURES_SWITCH)
    .split(',')
    .map((feature) => feature.trim())
    .filter(Boolean)
  if (!disabledFeatures.includes(TSF_IME_FEATURE)) disabledFeatures.push(TSF_IME_FEATURE)
  commandLine.appendSwitch(DISABLE_FEATURES_SWITCH, disabledFeatures.join(','))
  return true
}
