import { describe, expect, it } from 'vitest'
import { allowsAutomaticOcr, applyPerformanceProfile } from './performance-profile'

describe('低性能平台运行时画像', () => {
  it('软渲染画像停用自动 OCR，硬件加速画像允许自动 OCR', () => {
    expect(allowsAutomaticOcr({ softwareRendering: true })).toBe(false)
    expect(allowsAutomaticOcr({ softwareRendering: false })).toBe(true)
  })

  it('把渲染方式写入页面根节点供 CSS 降级', () => {
    const root = { dataset: {} } as unknown as HTMLElement

    applyPerformanceProfile({ softwareRendering: true }, root)
    expect(root.dataset.rendering).toBe('software')

    applyPerformanceProfile({ softwareRendering: false }, root)
    expect(root.dataset.rendering).toBe('hardware')
  })
})
