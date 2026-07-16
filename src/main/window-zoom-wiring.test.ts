import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const settingsWindowSource = readFileSync(
  new URL('./windows/settings-window.ts', import.meta.url),
  'utf8'
)
const appearanceSource = readFileSync(
  new URL('../renderer/src/utils/appearance.ts', import.meta.url),
  'utf8'
)
const appSource = readFileSync(new URL('../renderer/src/App.vue', import.meta.url), 'utf8')
const chatPaneSource = readFileSync(
  new URL('../renderer/src/components/ChatPane.vue', import.meta.url),
  'utf8'
)
const ipcSource = readFileSync(new URL('../shared/ipc.ts', import.meta.url), 'utf8')

describe('页面缩放主进程接线', () => {
  it('主窗口创建和设置更新均同步 WebContents 倍率', () => {
    expect(mainSource).toContain(
      'applyWindowZoom(mainWindow?.webContents, settingsView().fontScale)'
    )
    expect(mainSource).toContain("mainWindow.webContents.on('did-finish-load', syncMainWindowZoom)")
    expect(mainSource).toContain('syncMainWindowZoom()')
    expect(mainSource).toContain('syncSettingsWindowZoom(view.fontScale)')
    expect(mainSource).toContain('openSettingsWindow(mainWindow, settingsView().fontScale)')
  })

  it('设置窗口在加载前应用倍率并在重复打开时刷新', () => {
    const createIndex = settingsWindowSource.indexOf('win = new BrowserWindow')
    const initialZoomIndex = settingsWindowSource.indexOf(
      'syncSettingsWindowZoom(fontScale)',
      createIndex
    )
    const loadIndex = settingsWindowSource.indexOf('void win.loadURL(rendererUrl)')
    expect(createIndex).toBeGreaterThan(-1)
    expect(initialZoomIndex).toBeGreaterThan(createIndex)
    expect(initialZoomIndex).toBeLessThan(loadIndex)
    expect(settingsWindowSource).toContain(
      "win.webContents.on('did-finish-load', () => syncSettingsWindowZoom(currentFontScale))"
    )
  })

  it('renderer 清除 CSS zoom 并以正常流 textarea 刷新 Win7 caret 几何', () => {
    const inputCssStart = chatPaneSource.indexOf('.input {')
    const inputCssEnd = chatPaneSource.indexOf('.input.mirror-active', inputCssStart)
    const inputCss = chatPaneSource.slice(inputCssStart, inputCssEnd)

    expect(appearanceSource).toContain("document.body.style.removeProperty('zoom')")
    expect(appearanceSource).not.toContain("setProperty('zoom'")
    expect(appSource).toContain(':win7-ime-compat="info?.windows7 === true"')
    expect(chatPaneSource).toContain('@compositionstart="pulseWin7ImeCaretGeometry"')
    expect(chatPaneSource).toContain('@compositionupdate="pulseWin7ImeCaretGeometry"')
    expect(chatPaneSource).toContain('@compositionend="resetWin7ImeCaretGeometry"')
    expect(chatPaneSource).toContain('input.style.paddingLeft = `${next}px`')
    expect(chatPaneSource).toContain('input.getBoundingClientRect()')
    expect(inputCss).toContain('position: relative;')
    expect(inputCss).toContain('box-sizing: border-box;')
    expect(inputCss).not.toContain('position: absolute;')
    expect(inputCss).not.toContain('inset: 0;')
    expect(ipcSource).toContain('windows7: boolean')
  })

  it('完整移除已失效的 WebContents 焦点补丁', () => {
    expect(mainSource).not.toContain('refreshMainWindowImeFocus')
    expect(mainSource).not.toContain('focusWindowsImeTarget')
    expect(ipcSource).not.toContain('winRefreshImeFocus')
    expect(chatPaneSource).not.toContain('refreshWindowsImeFocus')
  })
})
