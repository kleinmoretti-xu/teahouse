import { app, BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { IpcEvents, type SettingsView } from '../../shared/ipc'
import { resolveDevRendererUrl } from '../util/renderer-url'
import { applyWindowZoom } from '../util/window-zoom'

// 文件柜独立窗口（决议 #283）：1000×680，左栏我的柜子 + 同事列表，右栏文件浏览器。
// 与设置窗的区别：**可缩放、可最大化、非模态**——用户要能把它和主窗并排放着边聊边翻，
// 因此不复用设置窗的 modal + scrim 路径（决议 #222 只针对模态设置窗）。
// 复用同一渲染包，经 #/cabinet 哈希路由挂载 CabinetApp。

const CABINET_WIDTH = 1000
const CABINET_HEIGHT = 680
const CABINET_MIN_WIDTH = 860
const CABINET_MIN_HEIGHT = 560

let win: BrowserWindow | null = null
let currentFontScale: SettingsView['fontScale'] = 100
// 同一次运行内记住上次大小与位置（重启回默认，与主窗口口径一致，不落库）
let lastBounds: { x: number; y: number; width: number; height: number } | null = null

/**
 * 首次打开时居中到主窗几何中心（同设置窗，决议 #123），并夹取到主窗所在显示器工作区；
 * 之后沿用本次运行内记住的位置与大小。主窗不可用时回退为 Electron 默认屏幕居中。
 */
function initialBounds(
  parent: BrowserWindow | null
): { x: number; y: number; width: number; height: number } | { width: number; height: number } {
  if (lastBounds) return lastBounds
  const size = { width: CABINET_WIDTH, height: CABINET_HEIGHT }
  if (!parent || parent.isDestroyed()) return size
  const p = parent.getBounds()
  const area = screen.getDisplayMatching(p).workArea
  const cx = Math.round(p.x + (p.width - size.width) / 2)
  const cy = Math.round(p.y + (p.height - size.height) / 2)
  return {
    ...size,
    x: Math.max(area.x, Math.min(cx, area.x + area.width - size.width)),
    y: Math.max(area.y, Math.min(cy, area.y + area.height - size.height))
  }
}

/** Linux 窗口图标（决议 #58）：与主窗同款，任务栏不依赖 desktop 关联 */
function linuxWindowIcon(): { icon: string } | Record<string, never> {
  if (process.platform !== 'linux') return {}
  const icon = app.isPackaged
    ? join(process.resourcesPath, 'icons/pantry.png')
    : join(app.getAppPath(), 'build/icons/linux/256x256.png')
  return { icon }
}

export function syncCabinetWindowZoom(fontScale: SettingsView['fontScale']): void {
  currentFontScale = fontScale
  applyWindowZoom(win?.webContents, fontScale)
}

/**
 * 打开（或聚焦）文件柜窗口。单实例：已开时只聚焦，不再开第二个。
 * peerId 用于私聊面板的「在文件柜窗口打开」——新建走哈希参数（渲染层挂载即读，
 * 不依赖事件时序，避免截图窗那类"事件早于挂载"的坑，决议 #218），已开则直接发事件切换。
 */
export function openCabinetWindow(
  parent: BrowserWindow | null,
  fontScale: SettingsView['fontScale'],
  peerId?: string
): void {
  const activeParent = parent && !parent.isDestroyed() ? parent : null
  if (win && !win.isDestroyed()) {
    syncCabinetWindowZoom(fontScale)
    if (peerId && !win.webContents.isDestroyed()) {
      win.webContents.send(IpcEvents.cabinetFocusPeer, peerId)
    }
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
    return
  }
  win = new BrowserWindow({
    ...initialBounds(activeParent),
    minWidth: CABINET_MIN_WIDTH,
    minHeight: CABINET_MIN_HEIGHT,
    show: false,
    title: '文件柜 - 茶话间',
    // 非模态：不设 parent，允许与主窗并排、各自独立最小化
    hasShadow: true,
    // 沉浸式无标题栏（决议 #49）：mac 红绿灯内嵌，Win/Linux 渲染层自绘控制按钮
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
      : { frame: false }),
    ...linuxWindowIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  syncCabinetWindowZoom(fontScale)
  win.webContents.on('did-finish-load', () => syncCabinetWindowZoom(currentFontScale))
  win.setMenuBarVisibility(false)
  // 安全红线（README）：不放行任何窗口内导航与新窗口
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  // 最大化状态推送：渲染层自绘「最大化/还原」按钮据此切图标
  win.on('maximize', () => win?.webContents.send(IpcEvents.winMaximizeChanged, true))
  win.on('unmaximize', () => win?.webContents.send(IpcEvents.winMaximizeChanged, false))
  win.once('ready-to-show', () => win?.show())
  win.on('close', () => {
    if (win && !win.isDestroyed() && !win.isMaximized() && !win.isMinimized()) {
      lastBounds = win.getBounds()
    }
  })
  win.on('closed', () => {
    win = null
  })

  const hash = peerId ? `/cabinet?peer=${encodeURIComponent(peerId)}` : '/cabinet'
  const rendererUrl = resolveDevRendererUrl(
    process.env['ELECTRON_RENDERER_URL'],
    hash,
    app.isPackaged
  )
  if (rendererUrl) {
    void win.loadURL(rendererUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'), { hash })
  }
}
