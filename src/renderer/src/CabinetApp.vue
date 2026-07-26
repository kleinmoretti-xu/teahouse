<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { darkTheme, dateZhCN, NButton, NConfigProvider, NInput, NSelect, zhCN } from 'naive-ui'
import {
  SHARE_FAIL_TEXT,
  SHARE_ROOT_REJECT_TEXT,
  SHARE_UPLOAD_FAIL_TEXT,
  type PeerView,
  type SettingsView,
  type ShareBrowseFailReason,
  type ShareGrantView,
  type ShareRecentUploadView,
  type TransferView
} from '../../shared/ipc'
import { CAPS, SHARE_DIR_MAX_ENTRIES, type ShareEntry, type ShareMode } from '../../shared/protocol'
import AvatarMark from './components/AvatarMark.vue'
import FileTypeIcon from './components/FileTypeIcon.vue'
import PantryIcon from './components/PantryIcon.vue'
import WindowControls from './components/WindowControls.vue'
import WindowDragStrip from './components/WindowDragStrip.vue'
import { teahouseDarkThemeOverrides, teahouseLightThemeOverrides } from './ui/naive-theme'
import { applyAppearance } from './utils/appearance'
import { formatBytes } from './utils/format'
import { applyPerformanceProfile } from './utils/performance-profile'

// 文件柜独立窗口（ui-design §8.2 / 决议 #283）：左栏「我的文件柜」+ 支持文件柜的同事，
// 右栏文件浏览器或我的柜子管理页。浏览手感对齐系统文件管理器：单击选中、双击进目录、
// Ctrl/Shift 多选、键盘与右键菜单。权限判定仍全在对方本机（protocol §8.2），本窗只做展示与请求编排。

type Target = { kind: 'mine' } | { kind: 'peer'; peerId: string }
type ViewMode = 'list' | 'grid'

const VIEW_MODE_KEY = 'pantry.cabinet.viewMode'
const SHARE_MODE_OPTIONS: Array<{ label: string; value: ShareMode }> = [
  { label: '不共享', value: 'off' },
  { label: '只读', value: 'read' },
  { label: '可读可传', value: 'write' }
]

const settings = ref<SettingsView | null>(null)
const peers = ref<PeerView[]>([])
const target = ref<Target>({ kind: 'mine' })
const peerQuery = ref('')
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null

const naiveTheme = computed(() => (settings.value?.theme === 'dark' ? darkTheme : null))
const naiveThemeOverrides = computed(() =>
  settings.value?.theme === 'dark' ? teahouseDarkThemeOverrides : teahouseLightThemeOverrides
)

// —— 我的文件柜（决议 #271/#272/#276，本轮从设置窗迁来）——
const grants = ref<ShareGrantView[]>([])
const recentUploads = ref<ShareRecentUploadView[]>([])
const shareRootError = ref('')
const newGrantId = ref<string | null>(null)

const shareRoot = computed(() => settings.value?.fileCabinet.root ?? '')
const shareMode = computed<ShareMode>(() => settings.value?.fileCabinet.mode ?? 'off')
const selfName = computed(() => settings.value?.nick.trim() || '你的名字')

const shareModeHint = computed(() => {
  if (!shareRoot.value) return '先选择共享目录，权限才会生效。'
  if (shareMode.value === 'write') {
    return '同事可以浏览、下载，也能往你的文件柜放新文件；他们不能删除、改名或覆盖你已有的文件。'
  }
  if (shareMode.value === 'read') return '同事可以浏览和下载，不能往里放东西。'
  return '默认谁都看不到；可以在下面单独给某位同事开放。'
})

const grantCandidates = computed(() =>
  peers.value
    .filter((p) => !grants.value.some((g) => g.nodeId === p.nodeId))
    .map((p) => ({
      label: `${p.remark || p.nick || p.nodeId.slice(0, 8)}${p.online ? '' : '（离线）'}`,
      value: p.nodeId
    }))
)

// —— 同事列表：只收声明 shr1 的联系人，在线在前、离线灰显在后（决议 #17/#283）——
const cabinetPeers = computed(() =>
  peers.value
    .filter((p) => Array.isArray(p.caps) && p.caps.includes(CAPS.fileCabinet))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1
      return peerName(a).localeCompare(peerName(b), 'zh-Hans-CN')
    })
)

const visiblePeers = computed(() => {
  const q = peerQuery.value.trim().toLowerCase()
  if (!q) return cabinetPeers.value
  return cabinetPeers.value.filter((p) =>
    [p.remark, p.nick, p.dept, p.ip].some((f) => (f ?? '').toLowerCase().includes(q))
  )
})

const activePeer = computed(() => {
  const current = target.value
  if (current.kind !== 'peer') return null
  return peers.value.find((p) => p.nodeId === current.peerId) ?? null
})

function peerName(p: PeerView): string {
  return p.remark || p.nick || p.nodeId.slice(0, 8)
}

/** 离线与旧版本条目仍可点，进去再给确定原因；这里只提供副标题文案 */
function peerSubtitle(p: PeerView): string {
  if (!Array.isArray(p.caps) || !p.caps.includes(CAPS.fileCabinet)) return '版本较旧，不支持文件柜'
  if (!p.online) return p.lastSeen ? `离线 · 最后在线 ${formatTime(p.lastSeen)}` : '离线'
  return [p.dept, p.ip].filter((s) => (s ?? '').length > 0).join(' · ') || '在线'
}

// —— 浏览状态（与私聊面板同一套语义，决议 #275/#278）——
const entries = ref<ShareEntry[]>([])
const path = ref('')
const perm = ref<'read' | 'write'>('read')
const snapshotId = ref('')
const total = ref(0)
const truncated = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const failReason = ref<ShareBrowseFailReason | null>(null)
const moreFailReason = ref<ShareBrowseFailReason | null>(null)
const picked = ref<Set<string>>(new Set())
const cursor = ref(-1)
const viewMode = ref<ViewMode>('list')
const downloading = ref(false)
const uploading = ref(false)
const note = ref('')
const transfer = ref<TransferView | null>(null)
const dragActive = ref(false)
const menu = ref<{ open: boolean; x: number; y: number; name: string; isDir: boolean }>({
  open: false,
  x: 0,
  y: 0,
  name: '',
  isDir: false
})

const canUpload = computed(() => perm.value === 'write')
const hasMore = computed(() => entries.value.length < total.value)
const failText = computed(() => (failReason.value ? SHARE_FAIL_TEXT[failReason.value] : ''))
const moreFailText = computed(() =>
  moreFailReason.value ? SHARE_FAIL_TEXT[moreFailReason.value] : ''
)
const pickedCount = computed(() => picked.value.size)
const pickedSize = computed(() =>
  entries.value
    .filter((e) => picked.value.has(e.name) && !e.isDir)
    .reduce((sum, e) => sum + e.size, 0)
)
const allLoadedPicked = computed(
  () => entries.value.length > 0 && entries.value.every((e) => picked.value.has(e.name))
)
// 勾选只覆盖已取回的条目，还有下一页时说「全选」会让人以为把 total 项都选上了（决议 #281）
const pickAllLabel = computed(() => (hasMore.value ? '选择已加载' : '全选'))
const crumbs = computed(() => {
  const list = [{ name: '文件柜', path: '' }]
  let acc = ''
  for (const seg of path.value ? path.value.split('/') : []) {
    acc = acc ? `${acc}/${seg}` : seg
    list.push({ name: seg, path: acc })
  }
  return list
})
const progressPercent = computed(() => {
  const t = transfer.value
  if (!t || t.totalSize <= 0) return 0
  return Math.min(100, Math.round((t.bytesDone / t.totalSize) * 100))
})
const transferActive = computed(
  () => transfer.value?.status === 'accepted' || transfer.value?.status === 'offering'
)

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  if (d.getFullYear() !== now.getFullYear()) return `${d.getFullYear()}-${mm}-${dd}`
  const sameDay =
    d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay ? `今天 ${hh}:${mi}` : `${mm}-${dd} ${hh}:${mi}`
}

function flashToast(text: string): void {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 1800)
}

function childPath(name: string): string {
  return path.value ? `${path.value}/${name}` : name
}

// ——— 目标切换 ———

function selectMine(): void {
  target.value = { kind: 'mine' }
  void loadRecentUploads()
}

function selectPeer(peerId: string): void {
  if (target.value.kind === 'peer' && target.value.peerId === peerId) return
  target.value = { kind: 'peer', peerId }
}

// ——— 浏览 ———

async function load(next: string, keepPick = false): Promise<void> {
  if (target.value.kind !== 'peer') return
  const peerId = target.value.peerId
  loading.value = true
  failReason.value = null
  moreFailReason.value = null
  if (!keepPick) {
    picked.value = new Set()
    cursor.value = -1
  }
  const result = await window.pantry.browseShare(peerId, next, 0)
  // 请求期间用户可能已经切到别人，迟到的结果直接丢弃
  if (target.value.kind !== 'peer' || target.value.peerId !== peerId) return
  loading.value = false
  if (!result.ok) {
    failReason.value = result.reason
    entries.value = []
    total.value = 0
    return
  }
  path.value = result.path
  perm.value = result.perm
  snapshotId.value = result.snapshotId
  entries.value = result.entries
  total.value = result.total
  truncated.value = result.truncated
}

// 滚到底继续取下一页；快照失效（gone）时静默从第 0 页重来，用户无感
async function loadMore(): Promise<void> {
  if (target.value.kind !== 'peer' || loadingMore.value || loading.value || !hasMore.value) return
  const peerId = target.value.peerId
  loadingMore.value = true
  moreFailReason.value = null
  const result = await window.pantry.browseShare(
    peerId,
    path.value,
    entries.value.length,
    snapshotId.value
  )
  if (target.value.kind !== 'peer' || target.value.peerId !== peerId) return
  loadingMore.value = false
  if (!result.ok) {
    if (result.reason === 'gone') {
      await load(path.value, true)
      return
    }
    // 已取到的条目一律保留，失败只落在列表末尾（决议 #278）
    moreFailReason.value = result.reason
    return
  }
  entries.value = [...entries.value, ...result.entries]
  total.value = result.total
  snapshotId.value = result.snapshotId
}

function onScroll(event: Event): void {
  // 上一页刚失败（多半撞了对方 10 秒 5 次的限流）就停下等用户点重试
  if (moreFailReason.value) return
  const el = event.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 160) void loadMore()
}

function goUp(): void {
  if (crumbs.value.length < 2) return
  void load(crumbs.value[crumbs.value.length - 2].path)
}

// ——— 选中与打开（文件管理器口径，决议 #283）———

function onRowClick(index: number, event: MouseEvent): void {
  const entry = entries.value[index]
  if (!entry) return
  if (event.shiftKey && cursor.value >= 0) {
    pickRange(cursor.value, index)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    togglePick(entry.name)
    cursor.value = index
    return
  }
  picked.value = new Set([entry.name])
  cursor.value = index
}

function onRowOpen(index: number): void {
  const entry = entries.value[index]
  if (!entry) return
  if (entry.isDir) void load(childPath(entry.name))
  else void downloadPaths([childPath(entry.name)], false)
}

function togglePick(name: string): void {
  const next = new Set(picked.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  picked.value = next
}

function pickRange(from: number, to: number): void {
  const [a, b] = from <= to ? [from, to] : [to, from]
  const next = new Set(picked.value)
  for (let i = a; i <= b; i += 1) {
    const entry = entries.value[i]
    if (entry) next.add(entry.name)
  }
  picked.value = next
  cursor.value = to
}

function toggleAll(): void {
  picked.value = allLoadedPicked.value ? new Set() : new Set(entries.value.map((e) => e.name))
}

function moveCursor(delta: number, extend: boolean): void {
  if (entries.value.length === 0) return
  const from = cursor.value < 0 ? (delta > 0 ? -1 : 0) : cursor.value
  const next = Math.max(0, Math.min(entries.value.length - 1, from + delta))
  if (extend && cursor.value >= 0) pickRange(cursor.value, next)
  else {
    picked.value = new Set([entries.value[next].name])
    cursor.value = next
  }
}

function onListKeydown(event: KeyboardEvent): void {
  const mod = event.ctrlKey || event.metaKey
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    moveCursor(1, event.shiftKey)
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    moveCursor(-1, event.shiftKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    if (cursor.value >= 0) onRowOpen(cursor.value)
  } else if (event.key === ' ') {
    event.preventDefault()
    if (cursor.value >= 0) togglePick(entries.value[cursor.value].name)
  } else if (event.key === 'Backspace' || (mod && event.key === 'ArrowUp')) {
    event.preventDefault()
    goUp()
  } else if (mod && event.key.toLowerCase() === 'a') {
    event.preventDefault()
    picked.value = new Set(entries.value.map((e) => e.name))
  } else if (event.key === 'F5' || (mod && event.key.toLowerCase() === 'r')) {
    event.preventDefault()
    void load(path.value)
  } else if (event.key === 'Escape') {
    if (menu.value.open) menu.value.open = false
    else picked.value = new Set()
  }
}

function openMenu(index: number, event: MouseEvent): void {
  const entry = entries.value[index]
  if (!entry) return
  if (!picked.value.has(entry.name)) {
    picked.value = new Set([entry.name])
    cursor.value = index
  }
  menu.value = { open: true, x: event.clientX, y: event.clientY, name: entry.name, isDir: entry.isDir }
}

async function copyName(): Promise<void> {
  const name = menu.value.name
  menu.value.open = false
  try {
    await navigator.clipboard.writeText(name)
    flashToast('文件名已复制')
  } catch {
    flashToast('复制失败')
  }
}

// ——— 下载与上传 ———

async function downloadPaths(paths: string[], saveAs: boolean): Promise<void> {
  if (target.value.kind !== 'peer' || paths.length === 0 || downloading.value) return
  downloading.value = true
  note.value = ''
  transfer.value = null
  const result = await window.pantry.downloadShare(target.value.peerId, paths, saveAs)
  downloading.value = false
  if (!result.ok) {
    note.value = SHARE_FAIL_TEXT[result.reason]
    return
  }
  if (result.canceled) return
  note.value = '已开始下载'
}

function downloadPicked(saveAs: boolean): void {
  void downloadPaths([...picked.value].map((name) => childPath(name)), saveAs)
  picked.value = new Set()
}

// 上传永远落到对方共享根下以我命名的子目录，与当前浏览到哪一层无关（决议 #272）
async function upload(directory: boolean): Promise<void> {
  if (target.value.kind !== 'peer' || !canUpload.value || uploading.value) return
  uploading.value = true
  note.value = ''
  transfer.value = null
  const result = await window.pantry.uploadShare(target.value.peerId, undefined, directory)
  uploading.value = false
  if (!result.ok) {
    note.value = SHARE_UPLOAD_FAIL_TEXT[result.reason]
    return
  }
  if (!result.canceled) note.value = `正在上传 ${result.fileCount} 个文件`
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  if (target.value.kind !== 'peer' || !canUpload.value || uploading.value) return
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path ?? '')
    .filter((p) => p.length > 0)
  if (paths.length === 0) return
  uploading.value = true
  note.value = ''
  transfer.value = null
  const granted = await window.pantry.grantFilePaths(paths)
  const result = await window.pantry.uploadShare(target.value.peerId, granted)
  uploading.value = false
  if (!result.ok) {
    note.value = SHARE_UPLOAD_FAIL_TEXT[result.reason]
    return
  }
  if (!result.canceled) note.value = `正在上传 ${result.fileCount} 个文件`
}

function onDragOver(event: DragEvent): void {
  if (target.value.kind !== 'peer') return
  event.preventDefault()
  dragActive.value = true
}

// 拖过内部子元素时根节点也会收到 dragleave，只有真正离开边界才熄灭（决议 #281）
function onDragLeave(event: DragEvent): void {
  const next = event.relatedTarget as Node | null
  if (next && (event.currentTarget as HTMLElement).contains(next)) return
  dragActive.value = false
}

function cancelTransfer(): void {
  if (transfer.value) void window.pantry.cancelTransfer(transfer.value.transferId)
}

function revealTransfer(): void {
  if (transfer.value) void window.pantry.revealTransfer(transfer.value.transferId)
}

// ——— 我的文件柜 ———

async function loadGrants(): Promise<void> {
  grants.value = await window.pantry.listShareGrants()
}

async function loadRecentUploads(): Promise<void> {
  recentUploads.value = await window.pantry.listRecentShareUploads(10)
}

function revealShareRoot(): void {
  void window.pantry.revealShareRoot()
}

/** 点「最近有人放进来」的一条：打开对方在我柜子里的落盘目录（复用既有 file:reveal） */
function revealUpload(transferId: string): void {
  void window.pantry.revealTransfer(transferId)
}

function menuDownload(saveAs: boolean): void {
  menu.value.open = false
  downloadPicked(saveAs)
}

async function pickShareRoot(): Promise<void> {
  shareRootError.value = ''
  const result = await window.pantry.setShareRoot()
  if (!result.ok) {
    shareRootError.value = SHARE_ROOT_REJECT_TEXT[result.reason]
    return
  }
  if (result.canceled) return
  settings.value = result.view
  flashToast('共享目录已设置')
}

async function clearShareRoot(): Promise<void> {
  shareRootError.value = ''
  const result = await window.pantry.setShareRoot(true)
  if (result.ok && !result.canceled) {
    settings.value = result.view
    flashToast('已停止共享')
  }
}

async function changeShareMode(mode: ShareMode): Promise<void> {
  if (mode === shareMode.value) return
  settings.value = await window.pantry.setShareMode(mode)
  flashToast('设置已保存')
}

// 新例外默认给"只读"：加例外多半是为了对某人开一条缝，写权限再手动往上调
async function addGrant(): Promise<void> {
  if (!newGrantId.value) return
  grants.value = await window.pantry.setShareGrant(newGrantId.value, 'read')
  newGrantId.value = null
  flashToast('已添加例外')
}

async function changeGrant(nodeId: string, mode: string | number | null): Promise<void> {
  if (mode !== 'off' && mode !== 'read' && mode !== 'write') return
  grants.value = await window.pantry.setShareGrant(nodeId, mode)
  flashToast('设置已保存')
}

async function removeGrant(nodeId: string): Promise<void> {
  grants.value = await window.pantry.setShareGrant(nodeId, null)
  flashToast('已恢复跟随默认')
}

function setViewMode(mode: ViewMode): void {
  viewMode.value = mode
  try {
    localStorage.setItem(VIEW_MODE_KEY, mode)
  } catch {
    // 隐私模式等写不进去不影响使用
  }
}

// 文件柜传输不进聊天流，进度只在本窗就地显示（决议 #275）
const stopTransfer = window.pantry.onTransferUpdated((view) => {
  if (!view.msgId.startsWith('share:')) return
  // 别人往我柜子里放完东西：正看着「我的文件柜」时顺手刷新汇总列表（决议 #283）
  if (target.value.kind === 'mine') {
    if (view.direction === 'in' && view.status === 'done') void loadRecentUploads()
    return
  }
  if (target.value.kind !== 'peer' || view.peerId !== target.value.peerId) return
  transfer.value = view
  const up = view.direction === 'out'
  if (view.status === 'done') note.value = up ? '上传完成' : '下载完成'
  else if (view.status === 'failed') note.value = up ? '上传失败，可重试' : '下载失败，可重试'
  else if (view.status === 'canceled') note.value = '已取消'
})

const stopPeers = window.pantry.onPeersUpdated((list) => {
  peers.value = list
})

const stopSettings = window.pantry.onSettingsUpdated((view) => {
  settings.value = view
  applyAppearance(view)
})

const stopFocusPeer = window.pantry.onCabinetFocusPeer((peerId) => {
  selectPeer(peerId)
})

function closeMenuOnClick(): void {
  if (menu.value.open) menu.value.open = false
}

watch(
  () => (target.value.kind === 'peer' ? target.value.peerId : ''),
  (peerId) => {
    transfer.value = null
    note.value = ''
    entries.value = []
    total.value = 0
    truncated.value = false
    path.value = ''
    picked.value = new Set()
    cursor.value = -1
    failReason.value = null
    moreFailReason.value = null
    if (peerId) void load('')
  }
)

onMounted(async () => {
  const info = await window.pantry.getAppInfo()
  applyPerformanceProfile(info)
  const view = await window.pantry.getSettings()
  if (view) {
    settings.value = view
    applyAppearance(view)
  }
  peers.value = await window.pantry.getPeers()
  await Promise.all([loadGrants(), loadRecentUploads()])
  try {
    const saved = localStorage.getItem(VIEW_MODE_KEY)
    if (saved === 'grid' || saved === 'list') viewMode.value = saved
  } catch {
    // 读不到就用默认列表视图
  }
  // 主进程带 peerId 打开时（私聊面板的「在文件柜窗口打开」）直接定位到该同事
  const initial = new URLSearchParams(location.hash.split('?')[1] ?? '').get('peer')
  if (initial) selectPeer(initial)
  window.addEventListener('click', closeMenuOnClick)
})

onUnmounted(() => {
  stopTransfer()
  stopPeers()
  stopSettings()
  stopFocusPeer()
  window.removeEventListener('click', closeMenuOnClick)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <NConfigProvider
    :theme="naiveTheme"
    :theme-overrides="naiveThemeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
  >
    <div class="cabinet">
      <!-- 沉浸式无标题栏（决议 #49/#52）：顶部拖拽带 + Win/Linux 自绘窗口控制 -->
      <WindowDragStrip />
      <WindowControls />

      <aside class="side">
        <button
          type="button"
          class="mine-card"
          :class="{ on: target.kind === 'mine' }"
          @click="selectMine"
        >
          <span class="mine-top">
            <span class="mine-icon"><PantryIcon name="cabinet" :size="17" /></span>
            <span class="mine-title">
              <strong>我的文件柜</strong>
              <small>{{ shareRoot ? '同事能看到这里的内容' : '未开启' }}</small>
            </span>
          </span>
          <span v-if="shareRoot" class="mine-rows">
            <span class="kv"><span>共享目录</span><b class="path" :title="shareRoot">{{ shareRoot }}</b></span>
            <span class="kv">
              <span>默认权限</span>
              <b>{{ shareMode === 'write' ? '可读可传' : shareMode === 'read' ? '只读' : '不共享' }}</b>
            </span>
            <span class="kv"><span>单独设过的同事</span><b>{{ grants.length }} 人</b></span>
          </span>
          <span v-else class="mine-empty">选个目录，同事就能自己来取文件</span>
        </button>

        <div class="side-head">
          <span>同事的文件柜</span>
          <span>{{ cabinetPeers.length }}</span>
        </div>
        <div class="side-search">
          <NInput v-model:value="peerQuery" size="small" clearable placeholder="搜索同事">
            <template #prefix><PantryIcon name="search" :size="14" /></template>
          </NInput>
        </div>
        <div class="peers">
          <button
            v-for="p in visiblePeers"
            :key="p.nodeId"
            type="button"
            class="peer"
            :class="{
              on: target.kind === 'peer' && target.peerId === p.nodeId,
              off: !p.online
            }"
            @click="selectPeer(p.nodeId)"
          >
            <AvatarMark
              class="peer-avatar"
              :avatar="p.avatar"
              :avatar-hash="p.avatarHash"
              :name="peerName(p)"
              :presence="p.online ? 'online' : 'offline'"
            />
            <span class="peer-txt">
              <span class="peer-name">{{ peerName(p) }}</span>
              <span class="peer-sub">{{ peerSubtitle(p) }}</span>
            </span>
          </button>
          <p v-if="cabinetPeers.length === 0" class="side-empty">
            还没有同事开启文件柜。等对方设好共享目录，这里就会出现。
          </p>
          <p v-else-if="visiblePeers.length === 0" class="side-empty">没有匹配的同事</p>
        </div>
      </aside>

      <!-- ——— 我的文件柜管理页 ——— -->
      <section v-if="target.kind === 'mine'" class="main">
        <header class="head">
          <span class="head-icon"><PantryIcon name="cabinet" :size="18" /></span>
          <span class="head-txt">
            <span class="head-title">我的文件柜</span>
            <span class="head-sub">
              {{ shareRoot ? '正在共享 · 同事按下面的权限访问' : '还没有开启，同事看不到任何内容' }}
            </span>
          </span>
          <NButton v-if="shareRoot" quaternary size="small" @click="clearShareRoot">停止共享</NButton>
        </header>

        <div v-if="!shareRoot" class="mine-guide">
          <span class="guide-icon"><PantryIcon name="cabinet" :size="24" /></span>
          <strong>你还没有开文件柜</strong>
          <p>选一个目录，同事就能自己来取里面的文件，不用你一个个发。</p>
          <p v-if="shareRootError" class="guide-error">{{ shareRootError }}</p>
          <NButton type="primary" @click="pickShareRoot">选择共享目录</NButton>
        </div>

        <div v-else class="page">
          <section class="card">
            <h3>共享目录</h3>
            <div class="path-row">
              <span class="path-icon"><PantryIcon name="folder" :size="15" /></span>
              <span class="path grow" :title="shareRoot">{{ shareRoot }}</span>
              <NButton size="tiny" secondary @click="revealShareRoot">打开</NButton>
              <NButton size="tiny" secondary @click="pickShareRoot">更改…</NButton>
            </div>
            <p v-if="shareRootError" class="card-error">{{ shareRootError }}</p>
            <p class="card-hint">同事只能看到这个目录里面的内容，看不到它在你磁盘上的位置。</p>
          </section>

          <section class="card">
            <h3>默认权限</h3>
            <div class="segment" role="radiogroup" aria-label="文件柜默认权限">
              <button
                v-for="opt in SHARE_MODE_OPTIONS"
                :key="opt.value"
                type="button"
                role="radio"
                :class="{ on: shareMode === opt.value }"
                :aria-checked="shareMode === opt.value"
                @click="changeShareMode(opt.value)"
              >
                {{ opt.label }}
              </button>
            </div>
            <p class="card-hint">{{ shareModeHint }}</p>
          </section>

          <section class="card">
            <h3>单独设过的同事 <em v-if="grants.length">{{ grants.length }} 人</em></h3>
            <div v-if="grants.length === 0" class="card-empty">所有同事都按默认权限</div>
            <div v-else class="grant-table">
              <div class="grant-row grant-head">
                <span>同事</span><span>权限</span><span></span>
              </div>
              <div v-for="g in grants" :key="g.nodeId" class="grant-row">
                <span class="grant-peer">
                  <AvatarMark
                    class="grant-avatar"
                    :avatar="g.avatar"
                    :avatar-hash="g.avatarHash"
                    :name="g.name"
                    :offline="!g.online"
                  />
                  <span :class="{ offline: !g.online }">{{ g.name }}{{ g.online ? '' : '（离线）' }}</span>
                </span>
                <NSelect
                  :value="g.mode"
                  :options="SHARE_MODE_OPTIONS"
                  size="small"
                  @update:value="(v: string | number | null) => changeGrant(g.nodeId, v)"
                />
                <button
                  type="button"
                  class="icon-btn danger"
                  title="移除例外（恢复跟随默认权限）"
                  @click="removeGrant(g.nodeId)"
                >
                  <PantryIcon name="x" :size="13" />
                </button>
              </div>
            </div>
            <div class="grant-add">
              <NSelect
                v-model:value="newGrantId"
                :options="grantCandidates"
                filterable
                clearable
                size="small"
                placeholder="搜索同事，为 TA 单独设置权限"
              />
              <NButton size="small" :disabled="!newGrantId" @click="addGrant">添加</NButton>
            </div>
          </section>

          <section class="card">
            <h3>最近有人放进来</h3>
            <div v-if="recentUploads.length === 0" class="card-empty">还没有人往你的文件柜放东西</div>
            <div v-else class="feed">
              <button
                v-for="item in recentUploads"
                :key="item.transferId"
                type="button"
                class="feed-row"
                @click="revealUpload(item.transferId)"
              >
                <AvatarMark
                  class="feed-avatar"
                  :avatar="item.avatar"
                  :avatar-hash="item.avatarHash"
                  :name="item.name"
                />
                <span class="feed-txt">
                  <b>{{ item.name }}</b> 放进来 {{ item.fileCount }} 个文件 ·
                  {{ formatBytes(item.totalSize) }}
                </span>
                <time>{{ formatTime(item.ts) }}</time>
              </button>
            </div>
            <p class="card-hint">点任意一条打开本机对应目录。别人只是浏览、下载不会出现在这里。</p>
          </section>
        </div>
      </section>

      <!-- ——— 对方的文件柜浏览器 ——— -->
      <section
        v-else
        class="main"
        :class="{ 'drag-active': dragActive && canUpload, 'drag-deny': dragActive && !canUpload }"
        @dragover="onDragOver"
        @dragleave="onDragLeave"
        @drop.prevent="onDrop"
      >
        <header class="head">
          <AvatarMark
            v-if="activePeer"
            class="head-avatar"
            :avatar="activePeer.avatar"
            :avatar-hash="activePeer.avatarHash"
            :name="peerName(activePeer)"
            :presence="activePeer.online ? 'online' : 'offline'"
          />
          <span class="head-txt">
            <span class="head-title">{{ activePeer ? peerName(activePeer) : '' }}的文件柜</span>
            <span class="head-sub">
              {{ activePeer ? peerSubtitle(activePeer) : '' }}
              <template v-if="!failReason && total > 0"> · 共 {{ total }} 项</template>
            </span>
          </span>
          <span v-if="!failReason" class="perm" :class="perm">{{ canUpload ? '可上传' : '只读' }}</span>
          <span class="seg-view" role="group" aria-label="视图">
            <button
              type="button"
              :class="{ on: viewMode === 'list' }"
              title="详情列表"
              aria-label="详情列表"
              @click="setViewMode('list')"
            >
              <PantryIcon name="list" :size="15" />
            </button>
            <button
              type="button"
              :class="{ on: viewMode === 'grid' }"
              title="网格"
              aria-label="网格"
              @click="setViewMode('grid')"
            >
              <PantryIcon name="grid" :size="15" />
            </button>
          </span>
          <button
            type="button"
            class="icon-btn quiet"
            title="刷新"
            :disabled="loading"
            @click="load(path)"
          >
            <PantryIcon name="refresh" :size="16" />
          </button>
        </header>

        <div class="crumbs">
          <button
            type="button"
            class="icon-btn"
            title="返回上级"
            :disabled="crumbs.length < 2 || loading"
            @click="goUp"
          >
            <PantryIcon name="chevron-left" :size="16" />
          </button>
          <div class="crumb-track">
            <template v-for="(c, i) in crumbs" :key="c.path">
              <span v-if="i > 0" class="crumb-sep">/</span>
              <button
                type="button"
                class="crumb"
                :class="{ current: i === crumbs.length - 1 }"
                :disabled="i === crumbs.length - 1"
                @click="load(c.path)"
              >
                {{ c.name }}
              </button>
            </template>
          </div>
        </div>

        <div v-if="loading" class="state">正在读取…</div>
        <div v-else-if="failReason" class="state error">
          <span class="state-icon"><PantryIcon name="info" :size="21" /></span>
          <strong>{{ failText }}</strong>
          <NButton size="small" @click="load(path)">重试</NButton>
        </div>
        <div v-else-if="entries.length === 0" class="state">
          <span class="state-icon"><PantryIcon name="folder" :size="21" /></span>
          <strong>这个文件夹是空的</strong>
          <small v-if="canUpload">可以把文件拖进来，会放到 TA 柜子里以你命名的文件夹。</small>
        </div>
        <template v-else>
          <div v-if="viewMode === 'list'" class="cols">
            <label class="pick-all">
              <input type="checkbox" :checked="allLoadedPicked" @change="toggleAll" />
              <span>{{ pickAllLabel }}</span>
            </label>
            <span class="c-name">名称</span>
            <span class="c-size">大小</span>
            <span class="c-time">修改时间</span>
          </div>
          <div
            v-if="viewMode === 'list'"
            class="rows"
            tabindex="0"
            role="listbox"
            aria-label="文件列表"
            @scroll="onScroll"
            @keydown="onListKeydown"
          >
            <div
              v-for="(entry, index) in entries"
              :key="entry.name"
              class="row"
              :class="{ picked: picked.has(entry.name), cursor: cursor === index }"
              role="option"
              :aria-selected="picked.has(entry.name)"
              @click="onRowClick(index, $event)"
              @dblclick="onRowOpen(index)"
              @contextmenu.prevent="openMenu(index, $event)"
            >
              <input
                class="row-pick"
                type="checkbox"
                :checked="picked.has(entry.name)"
                :aria-label="`勾选 ${entry.name}`"
                @click.stop
                @change="togglePick(entry.name)"
              />
              <FileTypeIcon class="row-icon" :name="entry.name" :dir="entry.isDir" :size="22" />
              <span class="row-name" :title="entry.name">{{ entry.name }}</span>
              <span class="row-size">{{ entry.isDir ? '—' : formatBytes(entry.size) }}</span>
              <span class="row-time">{{ formatTime(entry.mtime) }}</span>
            </div>
            <div v-if="loadingMore" class="tail">正在加载更多…</div>
            <div v-else-if="moreFailReason" class="tail fail">
              <span>{{ moreFailText }}</span>
              <button type="button" class="link" @click="loadMore">重试</button>
            </div>
            <div v-else-if="truncated" class="tail">
              目录内容过多，仅显示前 {{ SHARE_DIR_MAX_ENTRIES }} 项
            </div>
          </div>

          <div
            v-else
            class="grid"
            tabindex="0"
            role="listbox"
            aria-label="文件网格"
            @scroll="onScroll"
            @keydown="onListKeydown"
          >
            <div
              v-for="(entry, index) in entries"
              :key="entry.name"
              class="card-item"
              :class="{ picked: picked.has(entry.name) }"
              role="option"
              :aria-selected="picked.has(entry.name)"
              :title="entry.name"
              @click="onRowClick(index, $event)"
              @dblclick="onRowOpen(index)"
              @contextmenu.prevent="openMenu(index, $event)"
            >
              <FileTypeIcon class="card-icon" :name="entry.name" :dir="entry.isDir" :size="42" />
              <span class="card-name">{{ entry.name }}</span>
            </div>
            <div v-if="loadingMore" class="tail grid-tail">正在加载更多…</div>
            <div v-else-if="moreFailReason" class="tail fail grid-tail">
              <span>{{ moreFailText }}</span>
              <button type="button" class="link" @click="loadMore">重试</button>
            </div>
            <div v-else-if="truncated" class="tail grid-tail">
              目录内容过多，仅显示前 {{ SHARE_DIR_MAX_ENTRIES }} 项
            </div>
          </div>
        </template>

        <div v-if="transfer || note" class="progress">
          <div class="progress-top">
            <PantryIcon
              :name="transfer?.direction === 'out' ? 'upload' : 'download'"
              :size="15"
              class="progress-icon"
            />
            <span class="progress-text">{{ note || transfer?.name }}</span>
            <span v-if="transferActive" class="progress-num">{{ progressPercent }}%</span>
            <button v-if="transferActive" type="button" class="link" @click="cancelTransfer">
              取消
            </button>
            <button
              v-else-if="transfer?.status === 'done' && transfer.direction === 'in'"
              type="button"
              class="link"
              @click="revealTransfer"
            >
              打开位置
            </button>
          </div>
          <div v-if="transferActive" class="bar">
            <span class="bar-fill" :style="{ width: `${progressPercent}%` }"></span>
          </div>
        </div>

        <footer class="foot">
          <div class="foot-row">
            <span class="foot-sum">
              <template v-if="pickedCount > 0">
                已选 <b>{{ pickedCount }}</b> 项<template v-if="pickedSize > 0">
                  · {{ formatBytes(pickedSize) }}</template>
              </template>
              <template v-else-if="!failReason">单击选中，双击进文件夹</template>
            </span>
            <span class="foot-actions">
              <template v-if="pickedCount > 0">
                <NButton size="small" secondary :disabled="downloading" @click="downloadPicked(true)">
                  另存为…
                </NButton>
                <NButton size="small" type="primary" :disabled="downloading" @click="downloadPicked(false)">
                  下载 {{ pickedCount }} 项
                </NButton>
              </template>
              <template v-else-if="canUpload">
                <NButton size="small" secondary :disabled="uploading" @click="upload(true)">
                  上传文件夹
                </NButton>
                <NButton size="small" type="primary" :disabled="uploading" @click="upload(false)">
                  上传到 TA 的柜子
                </NButton>
              </template>
            </span>
          </div>
          <p class="foot-hint">
            <template v-if="canUpload">
              上传的内容会放进 TA 柜子里的「{{ selfName }}」文件夹，不影响 TA 已有的文件；下载默认落到「文件保存位置」下的「文件柜-对方名称」。
            </template>
            <template v-else>
              下载默认落到「文件保存位置」下的「文件柜-对方名称」，也可以「另存为」自选目录。
            </template>
          </p>
        </footer>
      </section>

      <!-- 右键菜单：只有取，没有删改（决议 #272/#283） -->
      <div
        v-if="menu.open"
        class="ctx-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
        role="menu"
      >
        <button type="button" role="menuitem" @click="menuDownload(false)">下载</button>
        <button type="button" role="menuitem" @click="menuDownload(true)">另存为…</button>
        <button type="button" role="menuitem" @click="copyName">复制文件名</button>
      </div>

      <Transition name="toast">
        <div v-if="toast" class="toast" role="status" aria-live="polite">
          <PantryIcon name="check" :size="15" />
          <span>{{ toast }}</span>
        </div>
      </Transition>
    </div>
  </NConfigProvider>
</template>

<style scoped>
.cabinet {
  /* 沿用设置页的标尺口径（决议 #150/#216）：间距 4px 台阶、容器 14 / 控件 9 / 胶囊 999 */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --r-card: 14px;
  --r-control: 9px;
  display: flex;
  position: relative;
  isolation: isolate;
  height: 100vh;
  min-width: 820px;
  background: var(--bg-chat);
  color: var(--text-1);
}

/* ——— 左栏 ——— */
.side {
  width: 280px;
  flex: 0 0 280px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--line);
  background: var(--material-panel);
  padding: 36px 0 var(--sp-2); /* 顶部让出拖拽带与 mac 红绿灯 */
}

.mine-card {
  margin: var(--sp-1) 10px var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  background: var(--material-strong);
  box-shadow: var(--shadow-soft);
  display: flex;
  flex-direction: column;
  gap: 9px;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}

.mine-card.on {
  border-color: var(--primary);
  background: var(--primary-weak);
  box-shadow: none;
}

.mine-top {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.mine-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: var(--r-control);
  background: var(--primary-weak);
  color: var(--primary);
}

.mine-title {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.mine-title strong {
  font-size: 14px;
}

.mine-title small,
.mine-empty {
  font-size: 12px;
  color: var(--text-3);
}

.mine-rows {
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.kv {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
  color: var(--text-2);
}

.kv b {
  font-weight: 500;
  color: var(--text-1);
}

.path {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11.5px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
}

.path.grow {
  flex: 1;
  min-width: 0;
  max-width: none;
  font-size: 12px;
}

.side-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: var(--sp-1) var(--sp-4) 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-3);
}

.side-search {
  padding: 0 10px var(--sp-2);
}

.peers {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.peer {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 50px;
  padding: 0 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.peer:hover {
  background: var(--surface-hover);
}

.peer.on {
  background: var(--surface-selected);
}

.peer.off {
  opacity: 0.62;
}

.peer-avatar {
  flex: none;
  width: 32px;
  height: 32px;
}

.peer-txt {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.peer-name {
  font-size: 13.5px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.peer-sub,
.side-empty {
  font-size: 11.5px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.side-empty {
  white-space: normal;
  line-height: 1.6;
  padding: var(--sp-3) 10px;
  margin: 0;
}

/* ——— 右栏公共 ——— */
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-window);
  position: relative;
}

.main.drag-active::after,
.main.drag-deny::after {
  content: '松手就放进 TA 的柜子';
  position: absolute;
  inset: 8px;
  z-index: 5;
  display: grid;
  place-items: center;
  border: 2px dashed var(--primary);
  border-radius: var(--r-card);
  background: var(--primary-weak);
  color: var(--primary);
  font-size: 13px;
  font-weight: 500;
  pointer-events: none;
}

.main.drag-deny::after {
  content: '对方没有开放上传';
  border-color: var(--text-3);
  background: var(--surface-hover);
  color: var(--text-2);
}

.head {
  flex: none;
  height: 60px;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3) 0 var(--sp-4);
  margin-top: 32px; /* 拖拽带 */
  border-bottom: 1px solid var(--line);
}

.head-avatar {
  flex: none;
  width: 32px;
  height: 32px;
}

.head-icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: var(--r-control);
  background: var(--primary-weak);
  color: var(--primary);
}

.head-txt {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.head-title {
  font-size: 15px;
  font-weight: 600;
}

.head-sub {
  font-size: 12px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.perm {
  flex: none;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  background: var(--surface-hover);
  color: var(--text-2);
}

.perm.write {
  background: var(--primary-weak);
  color: var(--primary);
}

.seg-view {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: var(--r-control);
  background: var(--surface-hover);
}

.seg-view button {
  display: grid;
  place-items: center;
  width: 30px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
}

.seg-view button.on {
  background: var(--material-strong);
  color: var(--primary);
  box-shadow: var(--shadow-soft);
}

.icon-btn {
  flex: none;
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.icon-btn.quiet {
  background: var(--surface-hover);
}

.icon-btn:hover:not(:disabled) {
  color: var(--primary);
  background: var(--surface-hover);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.icon-btn.danger:hover {
  color: var(--danger);
}

/* ——— 浏览器 ——— */
.crumbs {
  flex: none;
  height: 40px;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 var(--sp-3);
  border-bottom: 1px solid var(--line);
}

.crumb-track {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 2px;
  overflow-x: auto;
  white-space: nowrap;
}

.crumb {
  flex: none;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 13px;
  color: var(--primary);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-1);
  font-weight: 500;
  cursor: default;
}

.crumb-sep {
  flex: none;
  color: var(--text-3);
  font-size: 13px;
}

.cols {
  flex: none;
  height: 28px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 var(--sp-3) 0 var(--sp-4);
  border-bottom: 1px solid var(--line);
  font-size: 11.5px;
  color: var(--text-3);
}

.pick-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.c-name {
  flex: 1;
}

.c-size {
  width: 76px;
  text-align: right;
}

.c-time {
  width: 104px;
  text-align: right;
}

.rows {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-1) 6px;
}

.rows:focus-visible,
.grid:focus-visible {
  outline: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 40px;
  padding: 0 10px;
  border-radius: var(--r-control);
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--surface-hover);
}

.row.picked {
  background: var(--surface-selected);
}

.row.cursor {
  box-shadow: inset 0 0 0 1px var(--primary);
}

/* 未勾选时复选框只在 hover / 选中时露出，平时让位给文件名 */
.row-pick {
  flex: none;
  opacity: 0;
}

.row:hover .row-pick,
.row.picked .row-pick,
.row-pick:focus-visible {
  opacity: 1;
}

.row-icon,
.card-icon {
  flex: none;
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-size,
.row-time {
  flex: none;
  font-size: 12px;
  color: var(--text-3);
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.row-size {
  width: 76px;
}

.row-time {
  width: 104px;
}

.grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-3);
  display: grid;
  /* 卡片固定 112px 不随窗口拉宽（1fr 会把 5 列摊成 250px，图标孤零零留在中间） */
  grid-template-columns: repeat(auto-fill, 112px);
  gap: var(--sp-2);
  align-content: start;
  justify-content: start;
}

.card-item {
  height: 108px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 6px;
  border: 1.5px solid transparent;
  border-radius: 10px;
  cursor: pointer;
  user-select: none;
}

.card-item:hover {
  background: var(--surface-hover);
}

.card-item.picked {
  background: var(--surface-selected);
  border-color: var(--primary);
}

.card-name {
  font-size: 12px;
  line-height: 1.35;
  text-align: center;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.grid-tail {
  grid-column: 1 / -1;
}

.state {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: var(--sp-4);
  text-align: center;
  color: var(--text-2);
  font-size: 13px;
}

.state strong {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text-1);
}

.state small {
  font-size: 12px;
  color: var(--text-3);
  max-width: 34ch;
  line-height: 1.6;
}

.state-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: var(--r-control);
  background: var(--surface-hover);
  color: var(--text-3);
}

.state.error .state-icon {
  color: var(--danger);
}

/* 翻页失败只贴在列表末尾，已加载条目一律保留（决议 #278） */
.tail {
  padding: 10px var(--sp-3);
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

.tail.fail {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
}

.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}

.progress {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px var(--sp-4) 10px;
  border-top: 1px solid var(--line);
  background: var(--bg-list);
}

.progress-top {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12.5px;
  color: var(--text-2);
}

.progress-icon {
  color: var(--primary);
}

.progress-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-1);
}

.progress-num {
  font-variant-numeric: tabular-nums;
  color: var(--text-3);
}

.bar {
  height: 4px;
  border-radius: 999px;
  background: var(--surface-hover);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--primary);
  transition: width 160ms linear;
}

.foot {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px var(--sp-3) 11px var(--sp-4);
  border-top: 1px solid var(--line);
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.foot-sum {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-2);
}

.foot-sum b {
  color: var(--text-1);
}

.foot-actions {
  flex: none;
  display: flex;
  gap: 6px;
}

.foot-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--text-3);
}

/* ——— 我的文件柜页 ——— */
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  background: var(--bg-list);
}

.card {
  border: 1px solid var(--line);
  border-radius: var(--r-card);
  background: var(--material-strong);
  padding: var(--sp-3) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: 11px;
}

.card h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.card h3 em {
  font-style: normal;
  font-size: 11px;
  font-weight: 500;
  color: var(--primary);
  background: var(--primary-weak);
  padding: 2px 7px;
  border-radius: 999px;
}

.card-hint,
.card-empty {
  margin: 0;
  font-size: 12px;
  color: var(--text-3);
}

.card-error,
.guide-error {
  margin: 0;
  font-size: 12px;
  color: var(--danger);
}

.path-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: var(--r-control);
  background: var(--bg-list);
}

.path-icon {
  flex: none;
  display: grid;
  place-items: center;
  color: var(--text-2);
}

.segment {
  display: flex;
  gap: 3px;
  padding: 3px;
  border-radius: var(--r-control);
  background: var(--bg-list);
}

.segment button {
  flex: 1;
  height: 28px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-2);
  font-size: 12.5px;
  cursor: pointer;
}

.segment button.on {
  background: var(--primary);
  color: #fff;
  font-weight: 500;
}

.grant-table {
  display: flex;
  flex-direction: column;
}

.grant-row {
  display: grid;
  grid-template-columns: 1fr 120px 28px;
  align-items: center;
  gap: 10px;
  padding: 7px 2px;
  border-bottom: 1px solid var(--line);
  font-size: 12.5px;
}

.grant-row:last-child {
  border-bottom: none;
}

.grant-head {
  font-size: 11.5px;
  color: var(--text-3);
}

.grant-peer {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.grant-peer > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.grant-avatar,
.feed-avatar {
  flex: none;
  width: 24px;
  height: 24px;
}

.offline {
  color: var(--text-3);
}

.grant-add {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.grant-add :deep(.n-select) {
  flex: 1;
  min-width: 0;
}

.feed {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.feed-row {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px var(--sp-2);
  border: none;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--text-2);
  font: inherit;
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}

.feed-row:hover {
  background: var(--surface-hover);
}

.feed-txt {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.feed-txt b {
  color: var(--text-1);
  font-weight: 500;
}

.feed-row time {
  flex: none;
  font-size: 11.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}

.mine-guide {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: var(--sp-4);
  text-align: center;
}

.mine-guide strong {
  font-size: 15px;
}

.mine-guide p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-3);
  max-width: 40ch;
  line-height: 1.6;
}

.guide-icon {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  border-radius: var(--r-card);
  background: var(--primary-weak);
  color: var(--primary);
}

/* ——— 右键菜单与 toast ——— */
.ctx-menu {
  position: fixed;
  z-index: 80;
  min-width: 140px;
  padding: 5px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--material-strong);
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--text-1);
  font: inherit;
  font-size: 13px;
  text-align: left;
  padding: 7px 10px;
  cursor: pointer;
}

.ctx-menu button:hover {
  background: var(--surface-hover);
  color: var(--primary);
}

/* 「设置已保存」胶囊（决议 #151）：底部居中淡入上移，1.8s 后淡出 */
.toast {
  position: fixed;
  left: 50%;
  bottom: 22px;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 9px var(--sp-4);
  border-radius: 999px;
  background: var(--text-1);
  color: var(--bg-window);
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  box-shadow: var(--shadow-float);
  z-index: 90;
  pointer-events: none;
}

.toast-enter-active {
  transition: opacity 0.24s ease, transform 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}

.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 10px);
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }

  .toast-enter-active,
  .toast-leave-active {
    transition: opacity 0.16s ease;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: translateX(-50%);
  }
}
</style>
