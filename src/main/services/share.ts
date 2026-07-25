import { isAbsolute, parse, resolve, sep } from 'node:path'
import { effectiveShareMode, type ShareMode } from '../../shared/protocol'
import type { ShareGrantRecord } from '../store/share-grants-repo'

// 共享文件柜（requirements §6.10 / protocol §8.2 / 决议 #271–#277）。
// 本文件零 Electron 依赖（vitest 可直接实例化）：只做权限判定与共享根策略校验，
// 目录列举、报文应答与传输编排在后续增量接入（决议 #275 的 ② ③ 步）。

/** 共享根被拒的原因（决议 #276）：渲染层按 shared/ipc.ts 的文案表提示用户。 */
export type ShareRootRejectReason = 'empty' | 'relative' | 'fs-root' | 'home' | 'app-data'

export type ShareRootCheck =
  | { ok: true; path: string }
  | { ok: false; reason: ShareRootRejectReason }

export interface ShareRootContext {
  /** 当前用户主目录 */
  home: string
  /** 本应用数据目录（dataRoot） */
  dataRoot: string
  /** 大小写不敏感的文件系统（Windows / macOS 默认如此） */
  caseInsensitive?: boolean
}

function canonical(path: string, caseInsensitive: boolean): string {
  // 去掉结尾分隔符，避免 "/a/b" 与 "/a/b/" 被判成不同目录；根目录本身保留其分隔符
  const resolved = resolve(path)
  const root = parse(resolved).root
  const trimmed =
    resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') || root : resolved
  return caseInsensitive ? trimmed.toLowerCase() : trimmed
}

/** a 是否等于 b 或包含 b（两者都必须已 canonical 过） */
function contains(a: string, b: string): boolean {
  if (a === b) return true
  const prefix = a.endsWith(sep) ? a : a + sep
  return b.startsWith(prefix)
}

/**
 * 共享根策略校验（决议 #276）：纯函数、不碰文件系统，调用方另行确认目录存在且可读。
 * 拒绝用户主目录根、文件系统 / 盘符根，以及与应用数据目录相互包含的路径——
 * 后者会把 chat.db、日志和图片缓存一并暴露出去。
 */
export function evaluateShareRoot(input: string, ctx: ShareRootContext): ShareRootCheck {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length === 0) return { ok: false, reason: 'empty' }
  if (!isAbsolute(raw)) return { ok: false, reason: 'relative' }

  const insensitive = ctx.caseInsensitive ?? process.platform !== 'linux'
  const path = canonical(raw, insensitive)
  if (path === canonical(parse(resolve(raw)).root, insensitive)) {
    return { ok: false, reason: 'fs-root' }
  }
  if (ctx.home.trim().length > 0 && path === canonical(ctx.home, insensitive)) {
    return { ok: false, reason: 'home' }
  }
  if (ctx.dataRoot.trim().length > 0) {
    const dataRoot = canonical(ctx.dataRoot, insensitive)
    if (contains(path, dataRoot) || contains(dataRoot, path)) {
      return { ok: false, reason: 'app-data' }
    }
  }
  return { ok: true, path: resolve(raw) }
}

export interface ShareGrantsStore {
  list(): ShareGrantRecord[]
  loadAll(): Map<string, ShareMode>
  set(nodeId: string, mode: ShareMode | null, at?: number): void
}

export interface ShareServiceDeps {
  /** 当前共享根，空串 = 未设置（功能关闭） */
  getRoot: () => string
  /** 当前默认权限档 */
  getDefaultMode: () => ShareMode
  /** 按人例外存储；库尚未打开或不可用时返回 null，例外退化为仅本次会话内存态 */
  getGrants: () => ShareGrantsStore | null
}

/**
 * 权限判定的唯一入口：任何列目录 / 下载 / 上传请求都必须先过这里，
 * 且只依据本机配置，不信任对端声明（决议 #275）。
 */
export class ShareService {
  private grants = new Map<string, ShareMode>()

  constructor(private readonly deps: ShareServiceDeps) {
    this.reload()
  }

  reload(): void {
    this.grants = this.deps.getGrants()?.loadAll() ?? new Map()
  }

  /** 对某个联系人的有效权限：命中例外用例外，否则回落默认档；未设共享根一律 off。 */
  modeFor(nodeId: string): ShareMode {
    if (this.deps.getRoot().trim().length === 0) return 'off'
    return effectiveShareMode(this.deps.getDefaultMode(), this.grants.get(nodeId) ?? null)
  }

  /** 本机文件柜是否对任何人开放：用于 UI 状态与后续 shr1 声明判断。 */
  isEnabled(): boolean {
    if (this.deps.getRoot().trim().length === 0) return false
    if (this.deps.getDefaultMode() !== 'off') return true
    for (const mode of this.grants.values()) if (mode !== 'off') return true
    return false
  }

  grantFor(nodeId: string): ShareMode | null {
    return this.grants.get(nodeId) ?? null
  }

  listGrants(): ShareGrantRecord[] {
    return this.deps.getGrants()?.list() ?? []
  }

  /** 写入例外；mode 传 null 表示恢复"跟随默认档"。 */
  setGrant(nodeId: string, mode: ShareMode | null): void {
    if (mode === null) this.grants.delete(nodeId)
    else this.grants.set(nodeId, mode)
    this.deps.getGrants()?.set(nodeId, mode)
  }
}
