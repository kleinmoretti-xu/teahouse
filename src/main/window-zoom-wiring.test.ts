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
    expect(mainSource).toContain("mainWindow.on('focus', refreshMainWindowImeFocus)")
    expect(mainSource).toContain('focusWindowsImeTarget(event.sender, WINDOWS7)')
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

  it('renderer 清除 CSS zoom 并撤销失效的 Win7 焦点刷新', () => {
    expect(appearanceSource).toContain("document.body.style.removeProperty('zoom')")
    expect(appearanceSource).not.toContain("setProperty('zoom'")
    expect(appSource).not.toContain('win7-ime-compat')
    expect(chatPaneSource).not.toContain('win7-ime-caret')
    expect(chatPaneSource).not.toContain('scheduleWin7ImeCaretRefresh')
    expect(chatPaneSource).toContain('@focus="refreshWindowsImeFocus"')
    expect(ipcSource).not.toContain('windows7: boolean')
  })
})
