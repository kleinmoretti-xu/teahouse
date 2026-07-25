import { describe, expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { evaluateShareRoot, ShareService, type ShareGrantsStore } from './share'
import type { ShareMode } from '../../shared/protocol'
import type { ShareGrantRecord } from '../store/share-grants-repo'

// 共享文件柜的两条底线（决议 #271/#276）：
// ① 权限判定只看本机配置；② 共享根不许落在会连带暴露隐私的位置。

const HOME = '/home/tea'
const DATA_ROOT = '/home/tea/.config/pantry/data'
const CTX = { home: HOME, dataRoot: DATA_ROOT, caseInsensitive: false }

describe('evaluateShareRoot（共享根策略，决议 #276）', () => {
  it('普通目录放行，并返回归一化后的绝对路径', () => {
    // 用 resolve 做期望值：Windows 上 '/home/tea/共享' 会归一到 'C:\\home\\tea\\共享'
    expect(evaluateShareRoot('/home/tea/共享', CTX)).toEqual({
      ok: true,
      path: resolve('/home/tea/共享')
    })
    expect(evaluateShareRoot('/home/tea/共享/', CTX)).toEqual({
      ok: true,
      path: resolve('/home/tea/共享')
    })
  })

  it('空值与相对路径拒绝', () => {
    expect(evaluateShareRoot('', CTX)).toEqual({ ok: false, reason: 'empty' })
    expect(evaluateShareRoot('   ', CTX)).toEqual({ ok: false, reason: 'empty' })
    expect(evaluateShareRoot('共享', CTX)).toEqual({ ok: false, reason: 'relative' })
    expect(evaluateShareRoot('./共享', CTX)).toEqual({ ok: false, reason: 'relative' })
  })

  it('文件系统根与用户主目录根拒绝', () => {
    expect(evaluateShareRoot('/', CTX)).toEqual({ ok: false, reason: 'fs-root' })
    expect(evaluateShareRoot(HOME, CTX)).toEqual({ ok: false, reason: 'home' })
    expect(evaluateShareRoot(`${HOME}/`, CTX)).toEqual({ ok: false, reason: 'home' })
  })

  it('与应用数据目录相互包含都拒绝——否则会连 chat.db、日志一起共享出去', () => {
    expect(evaluateShareRoot(DATA_ROOT, CTX)).toEqual({ ok: false, reason: 'app-data' })
    // 数据目录内部
    expect(evaluateShareRoot(join(DATA_ROOT, 'images'), CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    // 数据目录的祖先
    expect(evaluateShareRoot('/home/tea/.config/pantry', CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    expect(evaluateShareRoot('/home/tea/.config', CTX)).toEqual({
      ok: false,
      reason: 'app-data'
    })
  })

  it('同名前缀的兄弟目录不算包含，应放行', () => {
    expect(evaluateShareRoot('/home/tea/.config/pantry-shared', CTX).ok).toBe(true)
    expect(evaluateShareRoot(`${DATA_ROOT}-backup`, CTX).ok).toBe(true)
  })

  it('大小写不敏感的文件系统上，改个大小写不能绕过', () => {
    const ctx = { home: HOME, dataRoot: DATA_ROOT, caseInsensitive: true }
    expect(evaluateShareRoot('/HOME/TEA', ctx)).toEqual({ ok: false, reason: 'home' })
    expect(evaluateShareRoot('/home/tea/.CONFIG/Pantry/DATA', ctx)).toEqual({
      ok: false,
      reason: 'app-data'
    })
    // 区分大小写的系统上它们是不同目录，放行
    expect(evaluateShareRoot('/HOME/TEA', CTX).ok).toBe(true)
  })
})

class FakeGrants implements ShareGrantsStore {
  readonly rows = new Map<string, ShareMode>()

  list(): ShareGrantRecord[] {
    return [...this.rows].map(([nodeId, mode]) => ({ nodeId, mode, updatedTs: 0 }))
  }

  loadAll(): Map<string, ShareMode> {
    return new Map(this.rows)
  }

  set(nodeId: string, mode: ShareMode | null): void {
    if (mode === null) this.rows.delete(nodeId)
    else this.rows.set(nodeId, mode)
  }
}

function makeService(
  root: string,
  mode: ShareMode,
  seed: Array<[string, ShareMode]> = []
): { service: ShareService; grants: FakeGrants } {
  const grants = new FakeGrants()
  for (const [nodeId, m] of seed) grants.rows.set(nodeId, m)
  const service = new ShareService({
    getRoot: () => root,
    getDefaultMode: () => mode,
    getGrants: () => grants
  })
  return { service, grants }
}

describe('ShareService 权限判定（决议 #271）', () => {
  it('没设共享根时一律 off，哪怕默认档和例外都开着', () => {
    const { service } = makeService('', 'write', [['bob', 'write']])
    expect(service.modeFor('bob')).toBe('off')
    expect(service.modeFor('anyone')).toBe('off')
    expect(service.isEnabled()).toBe(false)
  })

  it('无例外时回落默认档', () => {
    const { service } = makeService('/srv/share', 'read')
    expect(service.modeFor('bob')).toBe('read')
    expect(service.grantFor('bob')).toBeNull()
  })

  it('例外可以调高，也可以调低', () => {
    const { service } = makeService('/srv/share', 'read', [
      ['up', 'write'],
      ['down', 'off']
    ])
    expect(service.modeFor('up')).toBe('write')
    expect(service.modeFor('down')).toBe('off')
    expect(service.modeFor('other')).toBe('read')
  })

  it('默认不共享时，单个例外就能让文件柜对外可用', () => {
    const { service } = makeService('/srv/share', 'off')
    expect(service.isEnabled()).toBe(false)
    service.setGrant('bob', 'read')
    expect(service.isEnabled()).toBe(true)
    expect(service.modeFor('bob')).toBe('read')
    expect(service.modeFor('alice')).toBe('off')
  })

  it('例外置 null 即恢复跟随默认档，并从存储里删掉', () => {
    const { service, grants } = makeService('/srv/share', 'read', [['bob', 'write']])
    expect(service.modeFor('bob')).toBe('write')
    service.setGrant('bob', null)
    expect(service.modeFor('bob')).toBe('read')
    expect(service.grantFor('bob')).toBeNull()
    expect(grants.rows.has('bob')).toBe(false)
  })

  it('写入例外会落到存储，reload 后仍在', () => {
    const { service, grants } = makeService('/srv/share', 'off')
    service.setGrant('bob', 'write')
    expect(grants.rows.get('bob')).toBe('write')
    service.reload()
    expect(service.modeFor('bob')).toBe('write')
  })

  it('库不可用时例外退化为内存态，判定照常', () => {
    const service = new ShareService({
      getRoot: () => '/srv/share',
      getDefaultMode: () => 'off',
      getGrants: () => null
    })
    service.setGrant('bob', 'read')
    expect(service.modeFor('bob')).toBe('read')
    expect(service.listGrants()).toEqual([])
    service.reload() // 无存储可回灌，例外清空但不应抛错
    expect(service.modeFor('bob')).toBe('off')
  })
})
