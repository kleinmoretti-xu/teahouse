import { describe, expect, it, vi } from 'vitest'
import { configureWindowsImeCompatibility, isWindows7 } from './windows-ime'

function commandLine(existingFeatures = '') {
  return {
    appendSwitch: vi.fn(),
    getSwitchValue: vi.fn().mockReturnValue(existingFeatures)
  }
}

describe('Win7 输入法兼容', () => {
  it('仅识别 Windows NT 6.1', () => {
    expect(isWindows7('win32', '6.1.7601')).toBe(true)
    expect(isWindows7('win32', '6.1')).toBe(true)
    expect(isWindows7('win32', '6.2.9200')).toBe(false)
    expect(isWindows7('win32', '10.0.22631')).toBe(false)
    expect(isWindows7('win32', '6.10.0')).toBe(false)
    expect(isWindows7('linux', '6.1.0')).toBe(false)
    expect(isWindows7('darwin', '23.0.0')).toBe(false)
  })

  it('Win7 关闭 TSF 输入法支持并回退 IMM32', () => {
    const api = commandLine()

    expect(configureWindowsImeCompatibility(api, 'win32', '6.1.7601')).toBe(true)
    expect(api.appendSwitch).toHaveBeenCalledWith('disable-features', 'TSFImeSupport')
  })

  it('保留已有 Chromium 禁用特性且不重复 TSFImeSupport', () => {
    const withOtherFeature = commandLine('BackForwardCache')
    configureWindowsImeCompatibility(withOtherFeature, 'win32', '6.1.7601')
    expect(withOtherFeature.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      'BackForwardCache,TSFImeSupport'
    )

    const alreadyConfigured = commandLine('TSFImeSupport,BackForwardCache')
    configureWindowsImeCompatibility(alreadyConfigured, 'win32', '6.1.7601')
    expect(alreadyConfigured.appendSwitch).toHaveBeenCalledWith(
      'disable-features',
      'TSFImeSupport,BackForwardCache'
    )
  })

  it('其他平台不修改 Chromium 启动参数', () => {
    const api = commandLine()

    expect(configureWindowsImeCompatibility(api, 'win32', '10.0.22631')).toBe(false)
    expect(configureWindowsImeCompatibility(api, 'linux', '6.1.0')).toBe(false)
    expect(configureWindowsImeCompatibility(api, 'darwin', '23.0.0')).toBe(false)
    expect(api.getSwitchValue).not.toHaveBeenCalled()
    expect(api.appendSwitch).not.toHaveBeenCalled()
  })
})
