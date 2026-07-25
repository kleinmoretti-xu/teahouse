import { randomUUID } from 'node:crypto'
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import {
  effectiveShareMode,
  SHARE_DIR_MAX_ENTRIES,
  SHARE_GET_MAX_PATHS,
  SHARE_LIST_FRAME_MAX,
  SHARE_LIST_PAGE,
  SHARE_LIST_RATE_MAX,
  SHARE_LIST_RATE_WINDOW,
  SHARE_MAX_DEPTH,
  SHARE_NAME_MAX,
  SHARE_PATH_MAX,
  SHARE_SNAPSHOT_MAX,
  SHARE_SNAPSHOT_TTL,
  type ShareDenyReason,
  type ShareEntry,
  type ShareMode,
  type SharePayload
} from '../../shared/protocol'
import type { ShareGrantRecord } from '../store/share-grants-repo'

// 共享文件柜（requirements §6.10 / protocol §8.2 / 决议 #271–#277）。
// 本文件零 Electron 依赖（vitest 可直接实例化）：权限判定、共享根策略、目录列举与分页快照。
// 报文收发与传输编排在 main/index.ts 装配，上传（purpose:"share-put"）在第 ③ 步接入。

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

/**
 * 相对路径格式清洗（§8.2）：空串 = 共享根；返回以 '/' 连接的规范相对路径，非法返回 null。
 * 与 codec 的 isSharePath 同口径，另加深度上限——codec 只保证"看起来是相对路径"，
 * 这里保证"可以安全地拼到共享根后面"。
 */
export function sanitizeSharePath(input: unknown): string | null {
  if (typeof input !== 'string') return null
  if (Buffer.byteLength(input, 'utf8') > SHARE_PATH_MAX) return null
  if (input.length === 0) return ''
  if (input.startsWith('/') || input.startsWith('\\')) return null
  if (/^[a-zA-Z]:/.test(input)) return null
  if (input.includes('\\') || input.includes('\u0000')) return null
  const segments = input.split('/')
  if (segments.length > SHARE_MAX_DEPTH) return null
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > SHARE_NAME_MAX) return null
    if (seg === '.' || seg === '..') return null
  }
  return segments.join('/')
}

/**
 * 把相对路径解析到共享根下的真实绝对路径（决议 #276）。
 * 关键在于解析后再用 realpath 复核：共享根里可能有指向根外的符号链接，
 * 只做字符串拼接会把整块磁盘漏出去。目标不存在或越界一律返回 null。
 */
export function resolveWithinRoot(root: string, rel: string): string | null {
  if (root.trim().length === 0) return null
  let realRoot: string
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  const target = rel.length === 0 ? realRoot : join(realRoot, ...rel.split('/'))
  let realTarget: string
  try {
    realTarget = realpathSync(target)
  } catch {
    return null
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)) {
    return null
  }
  return realTarget
}

export interface ShareListing {
  entries: ShareEntry[]
  truncated: boolean
}

/**
 * 列举共享根下某个目录（§8.2 / 决议 #276）：
 * 跳过 `.` 开头的隐藏项，跳过指向共享根之外的符号链接，超过条目上限截断并标记。
 * 排序为"目录在前、再按名称"，用码点序保证两端一致（不依赖运行环境的 Intl 数据）。
 */
export function listShareDirectory(root: string, rel: string): ShareListing | null {
  const abs = resolveWithinRoot(root, rel)
  if (!abs) return null
  let names: string[]
  try {
    if (!statSync(abs).isDirectory()) return null
    names = readdirSync(abs)
  } catch {
    return null
  }
  const entries: ShareEntry[] = []
  let truncated = false
  for (const name of names) {
    if (name.startsWith('.')) continue // 不列 .ssh / .git 等，避免误共享
    if (name.length > SHARE_NAME_MAX) continue
    if (entries.length >= SHARE_DIR_MAX_ENTRIES) {
      truncated = true
      break
    }
    const child = join(abs, name)
    try {
      // 符号链接必须按其真实目标判断归属，指向根外的直接跳过
      if (lstatSync(child).isSymbolicLink()) {
        const rel2 = rel.length === 0 ? name : `${rel}/${name}`
        if (!resolveWithinRoot(root, rel2)) continue
      }
      const st = statSync(child)
      entries.push({
        name,
        size: st.isDirectory() ? 0 : st.size,
        isDir: st.isDirectory(),
        mtime: Math.max(0, Math.trunc(st.mtimeMs))
      })
    } catch {
      continue // 读不到的条目（权限、竞态删除）直接跳过，不让整页失败
    }
  }
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return { entries, truncated }
}

/**
 * 一页能装多少条：条目数与整条 list-ok 信封大小同时受限，先到者收窄（§8.2）。
 * 逐条累加实际编码长度，避免长中文文件名把信封顶过 TCP 帧上限。
 */
export function fitSharePage(entries: ShareEntry[], offset: number): ShareEntry[] {
  const page: ShareEntry[] = []
  let bytes = 0
  for (let i = offset; i < entries.length && page.length < SHARE_LIST_PAGE; i++) {
    const size = Buffer.byteLength(JSON.stringify(entries[i]), 'utf8') + 1
    if (page.length > 0 && bytes + size > SHARE_LIST_FRAME_MAX) break
    bytes += size
    page.push(entries[i])
  }
  return page
}

interface ListSnapshot {
  peerId: string
  path: string
  entries: ShareEntry[]
  truncated: boolean
  createdAt: number
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
  private readonly snapshots = new Map<string, ListSnapshot>()
  private readonly listHits = new Map<string, number[]>()

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

  // ---------- 共享方：应答对端的 share 报文（§8.2） ----------

  /**
   * 列目录请求。先限流、再判权限、最后才碰文件系统——顺序不能换，
   * 否则未授权的人也能靠请求节奏探出目录是否存在。
   */
  handleList(
    peerId: string,
    req: { reqId: string; path: string; offset: number; snapshotId?: string },
    now = Date.now()
  ): SharePayload {
    const deny = (reason: ShareDenyReason): SharePayload => ({
      op: 'deny',
      reqId: req.reqId,
      reason
    })
    if (!this.allowListRequest(peerId, now)) return deny('busy')
    const mode = this.modeFor(peerId)
    if (mode === 'off') return deny('off')
    const rel = sanitizeSharePath(req.path)
    if (rel === null) return deny('not-found')

    let snapshot: ListSnapshot | null = null
    if (req.snapshotId) {
      const cached = this.snapshots.get(req.snapshotId)
      // 快照过期或不是本人、本目录的，让对端从第 0 页重来，别返回错位的一页
      if (!cached || cached.peerId !== peerId || cached.path !== rel) return deny('gone')
      if (now - cached.createdAt > SHARE_SNAPSHOT_TTL) {
        this.snapshots.delete(req.snapshotId)
        return deny('gone')
      }
      snapshot = cached
    }
    let snapshotId = req.snapshotId ?? ''
    if (!snapshot) {
      const listing = listShareDirectory(this.deps.getRoot(), rel)
      if (!listing) return deny('not-found')
      snapshotId = randomUUID()
      snapshot = { peerId, path: rel, ...listing, createdAt: now }
      this.putSnapshot(snapshotId, snapshot, now)
    }

    const offset = Math.min(Math.max(0, req.offset), snapshot.entries.length)
    return {
      op: 'list-ok',
      reqId: req.reqId,
      path: rel,
      // 上传（purpose:"share-put"）在第 ③ 步才接入，此前一律只声明 read——
      // 否则对端会显示一个必然被拒的上传入口。第 ③ 步把这里改回 mode。
      perm: 'read',
      snapshotId,
      offset,
      total: snapshot.entries.length,
      truncated: snapshot.truncated,
      entries: fitSharePage(snapshot.entries, offset)
    }
  }

  /**
   * 下载请求：逐条复核权限与路径归属，返回可供 offer 的真实绝对路径。
   * 任何一条不合法就整体拒绝——部分成功会让对端拿到一个语义不明的传输。
   */
  handleGet(
    peerId: string,
    paths: string[]
  ): { ok: true; absPaths: string[] } | { ok: false; reason: ShareDenyReason } {
    if (this.modeFor(peerId) === 'off') return { ok: false, reason: 'off' }
    if (!Array.isArray(paths) || paths.length === 0) return { ok: false, reason: 'not-found' }
    if (paths.length > SHARE_GET_MAX_PATHS) return { ok: false, reason: 'not-found' }
    const absPaths: string[] = []
    for (const raw of paths) {
      const rel = sanitizeSharePath(raw)
      if (rel === null || rel.length === 0) return { ok: false, reason: 'not-found' }
      const abs = resolveWithinRoot(this.deps.getRoot(), rel)
      if (!abs) return { ok: false, reason: 'not-found' }
      absPaths.push(abs)
    }
    return { ok: true, absPaths }
  }

  /** 同一对端 10 秒最多 5 次列目录（决议 #276），防止有人拿它反复扫盘。 */
  private allowListRequest(peerId: string, now: number): boolean {
    const hits = (this.listHits.get(peerId) ?? []).filter(
      (at) => now - at < SHARE_LIST_RATE_WINDOW
    )
    if (hits.length >= SHARE_LIST_RATE_MAX) {
      this.listHits.set(peerId, hits)
      return false
    }
    hits.push(now)
    this.listHits.set(peerId, hits)
    if (this.listHits.size > 256) {
      // 防止离线节点的计数长期堆积
      for (const [id, list] of this.listHits) {
        if (list.every((at) => now - at >= SHARE_LIST_RATE_WINDOW)) this.listHits.delete(id)
      }
    }
    return true
  }

  private putSnapshot(id: string, snapshot: ListSnapshot, now: number): void {
    for (const [key, value] of this.snapshots) {
      if (now - value.createdAt > SHARE_SNAPSHOT_TTL) this.snapshots.delete(key)
    }
    while (this.snapshots.size >= SHARE_SNAPSHOT_MAX) {
      const oldest = this.snapshots.keys().next()
      if (oldest.done) break
      this.snapshots.delete(oldest.value)
    }
    this.snapshots.set(id, snapshot)
  }
}

// 目录名里必须剥掉的字符：路径分隔符会造成越级，其余是各平台文件系统保留字符
// eslint-disable-next-line no-control-regex
const BAD_DIR_CHARS = new RegExp('[<>:"|?*/\\\\\\u0000-\\u001f]', 'g')

/**
 * 文件柜下载的默认落点目录名（决议 #271）：`文件柜-<对方显示名>`。
 * 加前缀是为了和决议 #179 的「聊天里收到的文件」目录一眼分开。
 */
export function shareDownloadDirName(displayName: string): string {
  const clean = displayName
    .replace(BAD_DIR_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return `文件柜-${clean && clean !== '.' && clean !== '..' ? clean : '未知节点'}`
}

/**
 * 下载授权（决议 #275）：本机发出 get 之后，才接受来自该节点的一次 share-get offer。
 * 不绑文件名——请求时还不知道对方会展开出什么，故以"来源 + 时限 + 一次性"为边界。
 */
export class ShareDownloadGate {
  private readonly pending = new Map<string, { saveDir: string; expiresAt: number }>()

  begin(peerId: string, saveDir: string, ttl: number, now = Date.now()): void {
    this.pending.set(peerId, { saveDir, expiresAt: now + ttl })
  }

  cancel(peerId: string): void {
    this.pending.delete(peerId)
  }

  /** 命中返回落盘目录并消费授权；未授权 / 过期返回 null。 */
  consume(peerId: string, now = Date.now()): string | null {
    const entry = this.pending.get(peerId)
    if (!entry) return null
    this.pending.delete(peerId)
    return now >= entry.expiresAt ? null : entry.saveDir
  }
}
