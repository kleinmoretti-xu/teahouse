import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../CaptureApp.vue', import.meta.url), 'utf8')

describe('截图框选软渲染约束（决议 #221）', () => {
  it('桌面位图只保留一个 img 图层，选区使用四块纯色遮罩', () => {
    expect(source.match(/class="desktop"/g)).toHaveLength(1)
    expect(source).not.toContain('backgroundImage')
    expect(source).toContain('dim-top')
    expect(source).toContain('dim-right')
    expect(source).toContain('dim-bottom')
    expect(source).toContain('dim-left')
  })

  it('高频鼠标移动按动画帧合并，马赛克预览不做实时模糊', () => {
    expect(source).toContain('moveFrame = requestAnimationFrame')
    expect(source).not.toContain('backdrop-filter')
  })

  it('截图自然尺寸通过独立 X/Y 比例映射到输出像素', () => {
    expect(source).toContain('mapCaptureRectToImage')
    expect(source).toContain('crop.scaleX')
    expect(source).toContain('crop.scaleY')
  })
})
