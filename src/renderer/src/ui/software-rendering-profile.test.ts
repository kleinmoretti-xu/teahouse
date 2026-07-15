import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const tokensSource = readFileSync(new URL('../styles/tokens.css', import.meta.url), 'utf8')
const imageViewerAppSource = readFileSync(new URL('../ImageViewerApp.vue', import.meta.url), 'utf8')
const imageViewerSource = readFileSync(new URL('../components/ImageViewer.vue', import.meta.url), 'utf8')
const mainSource = readFileSync(new URL('../../../main/index.ts', import.meta.url), 'utf8')

describe('Win7 与 Linux 软渲染画像', () => {
  it('Win7 输入法兼容开关在应用就绪前配置', () => {
    const compatibilityIndex = mainSource.indexOf(
      'configureWindowsImeCompatibility(app.commandLine)'
    )
    const readyIndex = mainSource.indexOf('app.whenReady()')
    expect(compatibilityIndex).toBeGreaterThan(-1)
    expect(readyIndex).toBeGreaterThan(-1)
    expect(compatibilityIndex).toBeLessThan(readyIndex)
  })

  it('主进程复用禁用硬件加速条件并通过 AppInfo 下发', () => {
    expect(mainSource).toContain('const SOFTWARE_RENDERING =')
    expect(mainSource).toContain('if (SOFTWARE_RENDERING)')
    expect(mainSource).toContain('softwareRendering: SOFTWARE_RENDERING')
  })

  it('软件渲染样式关闭浮层磨砂并缩短阴影', () => {
    expect(tokensSource).toContain("html[data-rendering='software']")
    expect(tokensSource).toContain('backdrop-filter: none')
    expect(tokensSource).toContain('--shadow-float: 0 4px 14px')
    expect(tokensSource).toContain('.viewer-menu')
    expect(tokensSource).toContain('.ocr-panel')
  })

  it('图片查看窗口加载画像后再挂载，并把自动 OCR 策略传入组件', () => {
    expect(imageViewerAppSource).toContain('runtimeReady')
    expect(imageViewerAppSource).toContain('allowsAutomaticOcr(info)')
    expect(imageViewerAppSource).toContain(':automatic-ocr="automaticOcr"')
    expect(imageViewerSource).toContain('!props.automaticOcr')
    expect(imageViewerSource).toContain("startOcr('manual')")
  })
})
