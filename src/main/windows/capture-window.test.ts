import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMock = vi.hoisted(() => {
  const instances: Array<Record<string, any>> = []
  const BrowserWindow = vi.fn(function (this: Record<string, any>, options: Record<string, any>) {
    const handlers = new Map<string, (...args: any[]) => void>()
    this.options = options
    this.webContents = {
      handlers,
      setWindowOpenHandler: vi.fn(),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
      send: vi.fn()
    }
    this.setAlwaysOnTop = vi.fn()
    this.on = vi.fn()
    this.loadURL = vi.fn().mockResolvedValue(undefined)
    this.loadFile = vi.fn().mockResolvedValue(undefined)
    this.show = vi.fn()
    this.focus = vi.fn()
    this.close = vi.fn()
    this.isDestroyed = vi.fn().mockReturnValue(false)
    instances.push(this)
  })
  return { instances, BrowserWindow, app: { isPackaged: true } }
})

vi.mock('electron', () => ({
  app: electronMock.app,
  BrowserWindow: electronMock.BrowserWindow
}))

describe('capture window 导航安全', () => {
  beforeEach(() => {
    electronMock.instances.length = 0
    electronMock.BrowserWindow.mockClear()
  })

  it('拦截截图窗口内的所有 will-navigate', async () => {
    const { openCaptureWindow } = await import('./capture-window')
    openCaptureWindow({ x: 0, y: 0, width: 800, height: 600 }, 'data:image/png;base64,AA==', 1, vi.fn())

    const instance = electronMock.instances[0]
    const handler = instance.webContents.handlers.get('will-navigate')
    const event = { preventDefault: vi.fn() }

    expect(handler).toBeTypeOf('function')
    handler(event, 'https://example.invalid/')
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })

  it('动态入口挂载前使用黑色加载底，避免透出应用背景', async () => {
    const { openCaptureWindow } = await import('./capture-window')
    openCaptureWindow({ x: 0, y: 0, width: 800, height: 600 }, 'data:image/png;base64,AA==', 1, vi.fn())

    expect(electronMock.instances[0].options.backgroundColor).toBe('#000000')
  })
})
