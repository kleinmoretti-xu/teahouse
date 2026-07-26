import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// 文件柜窗口（决议 #283）：与设置窗最大的区别是**可缩放、非模态**——要能和主窗并排边聊边翻，
// 所以既不设 parent/modal，也不向主窗发遮罩事件。

const electronMock = vi.hoisted(() => {
  const instances: Array<Record<string, any>> = []
  const BrowserWindow = vi.fn(function (this: Record<string, any>, options: Record<string, any>) {
    const handlers = new Map<string, (...args: any[]) => void>()
    const webHandlers = new Map<string, (...args: any[]) => void>()
    this.options = options
    this.handlers = handlers
    this.webContents = {
      handlers: webHandlers,
      isDestroyed: vi.fn().mockReturnValue(false),
      setZoomFactor: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => webHandlers.set(event, handler)),
      send: vi.fn()
    }
    this.setMenuBarVisibility = vi.fn()
    this.once = vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler))
    this.on = vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler))
    this.loadURL = vi.fn().mockResolvedValue(undefined)
    this.loadFile = vi.fn().mockResolvedValue(undefined)
    this.show = vi.fn()
    this.focus = vi.fn()
    this.restore = vi.fn()
    this.isMinimized = vi.fn().mockReturnValue(false)
    this.isMaximized = vi.fn().mockReturnValue(false)
    this.getBounds = vi.fn().mockReturnValue({ x: 30, y: 40, width: 1200, height: 800 })
    this.isDestroyed = vi.fn().mockReturnValue(false)
    instances.push(this)
  })
  return {
    instances,
    BrowserWindow,
    app: { isPackaged: false, getAppPath: vi.fn().mockReturnValue('/tmp/pantry') },
    screen: {
      getDisplayMatching: vi.fn().mockReturnValue({
        workArea: { x: 0, y: 0, width: 1920, height: 1040 }
      })
    }
  }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow,
  screen: electronMock.screen
}))

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function makeParent(): Record<string, any> {
  return {
    isDestroyed: vi.fn().mockReturnValue(false),
    getBounds: vi.fn().mockReturnValue({ x: 100, y: 80, width: 960, height: 640 }),
    webContents: {
      isDestroyed: vi.fn().mockReturnValue(false),
      send: vi.fn()
    }
  }
}

async function loadCabinetWindow(
  platform: NodeJS.Platform
): Promise<typeof import('./cabinet-window')> {
  setPlatform(platform)
  vi.resetModules()
  return import('./cabinet-window')
}

describe('文件柜窗口', () => {
  beforeEach(() => {
    electronMock.instances.length = 0
    electronMock.BrowserWindow.mockClear()
  })

  afterAll(() => setPlatform(originalPlatform))

  it('非模态、可缩放，并居中到主窗几何中心', async () => {
    const parent = makeParent()
    const { openCabinetWindow } = await loadCabinetWindow('win32')

    openCabinetWindow(parent as never, 125)

    const instance = electronMock.instances[0]
    expect(instance.options.parent).toBeUndefined()
    expect(instance.options.modal).toBeUndefined()
    expect(instance.options.resizable).toBeUndefined() // 未显式关闭 = Electron 默认可缩放
    expect(instance.options.width).toBe(1000)
    expect(instance.options.height).toBe(680)
    expect(instance.options.minWidth).toBe(860)
    expect(instance.options.minHeight).toBe(560)
    // 主窗 100,80 960×640 的几何中心：100+(960-1000)/2=80、80+(640-680)/2=60，均在工作区内
    expect(instance.options.x).toBe(80)
    expect(instance.options.y).toBe(60)
    expect(instance.options.frame).toBe(false)
    expect(instance.webContents.setZoomFactor).toHaveBeenCalledWith(1.25)
    // 不向主窗发任何遮罩事件（决议 #222 只针对模态设置窗）
    expect(parent.webContents.send).not.toHaveBeenCalled()
  })

  it('单实例：重复打开只聚焦已开窗口，并可切到指定同事', async () => {
    const parent = makeParent()
    const { openCabinetWindow } = await loadCabinetWindow('linux')

    openCabinetWindow(parent as never, 100)
    openCabinetWindow(parent as never, 110, 'node-2')

    const instance = electronMock.instances[0]
    expect(electronMock.instances).toHaveLength(1)
    expect(instance.show).toHaveBeenCalledTimes(1)
    expect(instance.focus).toHaveBeenCalledTimes(1)
    expect(instance.webContents.send).toHaveBeenCalledWith('cabinet:focus-peer', 'node-2')
    expect(instance.webContents.setZoomFactor).toHaveBeenLastCalledWith(1.1)
  })

  it('新建时把 peerId 放进哈希，渲染层挂载即读，不依赖事件时序', async () => {
    const parent = makeParent()
    const { openCabinetWindow } = await loadCabinetWindow('darwin')

    openCabinetWindow(parent as never, 100, 'node-1')

    const instance = electronMock.instances[0]
    expect(instance.options.titleBarStyle).toBe('hiddenInset')
    expect(instance.loadFile).toHaveBeenCalledWith(expect.stringContaining('index.html'), {
      hash: '/cabinet?peer=node-1'
    })
  })

  it('关闭前记住本次运行的大小与位置，重开沿用', async () => {
    const parent = makeParent()
    const { openCabinetWindow } = await loadCabinetWindow('win32')

    openCabinetWindow(parent as never, 100)
    const first = electronMock.instances[0]
    first.handlers.get('close')?.()
    first.isDestroyed.mockReturnValue(true)
    first.handlers.get('closed')?.()

    openCabinetWindow(parent as never, 100)
    const second = electronMock.instances[1]
    expect(second.options.width).toBe(1200)
    expect(second.options.height).toBe(800)
    expect(second.options.x).toBe(30)
    expect(second.options.y).toBe(40)
  })
})
