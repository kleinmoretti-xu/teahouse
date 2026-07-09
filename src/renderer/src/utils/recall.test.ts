import { describe, expect, it } from 'vitest'
import { canRecallAt, formatRecallButtonLabel, recallRemainingMs } from './recall'

describe('撤回倒计时工具', () => {
  it('按剩余毫秒生成撤回菜单文案', () => {
    expect(formatRecallButtonLabel(59_001)).toBe('撤回（01:00）')
    expect(formatRecallButtonLabel(59_000)).toBe('撤回（00:59）')
    expect(formatRecallButtonLabel(0)).toBe('撤回（超时）')
    expect(formatRecallButtonLabel(30_000, '已接收')).toBe('撤回（已接收）')
  })

  it('按当前时间判断撤回窗口', () => {
    expect(recallRemainingMs(12_000, 10_000, 5_000)).toBe(3_000)
    expect(recallRemainingMs(16_000, 10_000, 5_000)).toBe(0)
    expect(canRecallAt(12_000, 10_000, 5_000)).toBe(true)
    expect(canRecallAt(15_000, 10_000, 5_000)).toBe(true)
    expect(canRecallAt(16_000, 10_000, 5_000)).toBe(false)
    expect(canRecallAt(12_000, 10_000, 5_000, '不可用')).toBe(false)
  })
})
