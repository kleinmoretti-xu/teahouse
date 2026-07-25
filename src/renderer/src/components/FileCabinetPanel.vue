<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import {
  SHARE_FAIL_TEXT,
  SHARE_UPLOAD_FAIL_TEXT,
  type ShareBrowseFailReason,
  type TransferView
} from '../../../shared/ipc'
import type { ShareEntry } from '../../../shared/protocol'
import { useChatStore } from '../stores/chat'
import PantryIcon from './PantryIcon.vue'
import FileTypeIcon from './FileTypeIcon.vue'

// 对方的文件柜面板（ui-design §5 / 决议 #273）：覆盖聊天右侧一整列，可边聊边浏览。
// 只做展示与请求编排，权限判定全部在对方本机（protocol §8.2）。

const props = defineProps<{ peerId: string; peerName: string }>()
const emit = defineEmits<{ close: [] }>()

interface Crumb {
  name: string
  path: string
}

const entries = ref<ShareEntry[]>([])
const path = ref('')
const perm = ref<'read' | 'write'>('read')
const snapshotId = ref('')
const total = ref(0)
const truncated = ref(false)
const loading = ref(false)
const loadingMore = ref(false)
const failReason = ref<ShareBrowseFailReason | null>(null)
const picked = ref<Set<string>>(new Set())
const downloading = ref(false)
const downloadNote = ref('')
const transfer = ref<TransferView | null>(null)
const uploading = ref(false)
const dragActive = ref(false)
const chatStore = useChatStore()

const canUpload = computed(() => perm.value === 'write')
const uploadHint = computed(
  () => `文件会放进 TA 文件柜的「${chatStore.selfNick || '你的名字'}」文件夹里`
)

const crumbs = computed<Crumb[]>(() => {
  const list: Crumb[] = [{ name: '文件柜', path: '' }]
  const segs = path.value ? path.value.split('/') : []
  let acc = ''
  for (const seg of segs) {
    acc = acc ? `${acc}/${seg}` : seg
    list.push({ name: seg, path: acc })
  }
  return list
})

const hasMore = computed(() => entries.value.length < total.value)
const failText = computed(() => (failReason.value ? SHARE_FAIL_TEXT[failReason.value] : ''))
const pickedCount = computed(() => picked.value.size)
const allPagePicked = computed(
  () => entries.value.length > 0 && entries.value.every((e) => picked.value.has(e.name))
)
const progressPercent = computed(() => {
  const t = transfer.value
  if (!t || t.totalSize <= 0) return 0
  return Math.min(100, Math.round((t.bytesDone / t.totalSize) * 100))
})

function formatSize(bytes: number): string {
  if (bytes <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${d.getFullYear()}-${mm}-${dd}`
}

function childPath(name: string): string {
  return path.value ? `${path.value}/${name}` : name
}

async function load(target: string, keepPick = false): Promise<void> {
  loading.value = true
  failReason.value = null
  if (!keepPick) picked.value = new Set()
  const result = await window.pantry.browseShare(props.peerId, target, 0)
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
  if (loadingMore.value || loading.value || !hasMore.value) return
  loadingMore.value = true
  const result = await window.pantry.browseShare(
    props.peerId,
    path.value,
    entries.value.length,
    snapshotId.value
  )
  loadingMore.value = false
  if (!result.ok) {
    if (result.reason === 'gone') {
      await load(path.value, true)
      return
    }
    failReason.value = result.reason
    return
  }
  entries.value = [...entries.value, ...result.entries]
  total.value = result.total
  snapshotId.value = result.snapshotId
}

function onScroll(event: Event): void {
  const el = event.target as HTMLElement
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) void loadMore()
}

function open(entry: ShareEntry): void {
  if (entry.isDir) void load(childPath(entry.name))
  else togglePick(entry.name)
}

function togglePick(name: string): void {
  const next = new Set(picked.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  picked.value = next
}

function toggleAll(): void {
  picked.value = allPagePicked.value ? new Set() : new Set(entries.value.map((e) => e.name))
}

async function download(saveAs: boolean): Promise<void> {
  if (pickedCount.value === 0 || downloading.value) return
  downloading.value = true
  downloadNote.value = ''
  transfer.value = null
  const paths = [...picked.value].map((name) => childPath(name))
  const result = await window.pantry.downloadShare(props.peerId, paths, saveAs)
  downloading.value = false
  if (!result.ok) {
    downloadNote.value = SHARE_FAIL_TEXT[result.reason]
    return
  }
  if (result.canceled) return
  picked.value = new Set()
  downloadNote.value = '已开始下载'
}

// 上传永远落到对方共享根下以我命名的子目录，与当前浏览到哪一层无关（决议 #272）
async function upload(directory: boolean): Promise<void> {
  if (!canUpload.value || uploading.value) return
  uploading.value = true
  downloadNote.value = ''
  transfer.value = null
  const result = await window.pantry.uploadShare(props.peerId, undefined, directory)
  uploading.value = false
  if (!result.ok) {
    downloadNote.value = SHARE_UPLOAD_FAIL_TEXT[result.reason]
    return
  }
  if (result.canceled) return
  downloadNote.value = `正在上传 ${result.fileCount} 个文件`
}

async function onDrop(event: DragEvent): Promise<void> {
  dragActive.value = false
  if (!canUpload.value || uploading.value) return
  const paths = [...(event.dataTransfer?.files ?? [])]
    .map((f) => (f as File & { path?: string }).path ?? '')
    .filter((p) => p.length > 0)
  if (paths.length === 0) return
  uploading.value = true
  downloadNote.value = ''
  transfer.value = null
  const granted = await window.pantry.grantFilePaths(paths)
  const result = await window.pantry.uploadShare(props.peerId, granted)
  uploading.value = false
  if (!result.ok) {
    downloadNote.value = SHARE_UPLOAD_FAIL_TEXT[result.reason]
    return
  }
  if (!result.canceled) downloadNote.value = `正在上传 ${result.fileCount} 个文件`
}

function onDragOver(event: DragEvent): void {
  if (!canUpload.value) return
  event.preventDefault()
  dragActive.value = true
}

// 文件柜传输不进聊天流，进度只在本面板就地显示（决议 #275）
const stopTransfer = window.pantry.onTransferUpdated((view) => {
  if (view.peerId !== props.peerId || !view.msgId.startsWith('share:')) return
  transfer.value = view
  const up = view.direction === 'out'
  if (view.status === 'done') downloadNote.value = up ? '上传完成' : '下载完成'
  else if (view.status === 'failed') downloadNote.value = up ? '上传失败，可重试' : '下载失败，可重试'
  else if (view.status === 'canceled') downloadNote.value = '已取消'
})

function revealDone(): void {
  if (transfer.value?.status === 'done') void window.pantry.revealTransfer(transfer.value.transferId)
}

function cancelDownload(): void {
  if (transfer.value) void window.pantry.cancelTransfer(transfer.value.transferId)
}

watch(
  () => props.peerId,
  () => {
    transfer.value = null
    downloadNote.value = ''
    void load('')
  },
  { immediate: true }
)

onUnmounted(() => stopTransfer())
</script>

<template>
  <aside
    class="panel"
    :class="{ 'drag-active': dragActive }"
    aria-label="对方的文件柜"
    @dragover="onDragOver"
    @dragleave="dragActive = false"
    @drop.prevent="onDrop"
  >
    <header class="panel-head">
      <span class="panel-title">{{ peerName }} 的文件柜</span>
      <button class="icon-btn" title="关闭" @click="emit('close')">
        <PantryIcon name="x" :size="14" />
      </button>
    </header>

    <div class="crumbs">
      <button
        class="icon-btn"
        title="返回上级"
        :disabled="crumbs.length < 2 || loading"
        @click="load(crumbs[crumbs.length - 2].path)"
      >
        <PantryIcon name="chevron-left" :size="14" />
      </button>
      <div class="crumb-track">
        <template v-for="(c, i) in crumbs" :key="c.path">
          <span v-if="i > 0" class="crumb-sep">/</span>
          <button
            class="crumb"
            :class="{ current: i === crumbs.length - 1 }"
            :disabled="i === crumbs.length - 1"
            @click="load(c.path)"
          >
            {{ c.name }}
          </button>
        </template>
      </div>
      <button class="icon-btn" title="刷新" :disabled="loading" @click="load(path)">
        <PantryIcon name="refresh" :size="14" />
      </button>
    </div>

    <div v-if="loading" class="hint">正在读取…</div>
    <div v-else-if="failReason" class="hint error">
      <span>{{ failText }}</span>
      <button class="retry" @click="load(path)">重试</button>
    </div>
    <div v-else-if="entries.length === 0" class="hint">这个文件夹是空的</div>
    <template v-else>
      <div class="list-head">
        <label class="pick-all">
          <input type="checkbox" :checked="allPagePicked" @change="toggleAll" />
          <span>全选</span>
        </label>
        <span class="count">{{ total }} 项</span>
      </div>
      <div class="list" @scroll="onScroll">
        <div
          v-for="entry in entries"
          :key="entry.name"
          class="row"
          :class="{ picked: picked.has(entry.name) }"
          @click="open(entry)"
        >
          <input
            class="row-pick"
            type="checkbox"
            :checked="picked.has(entry.name)"
            @click.stop
            @change="togglePick(entry.name)"
          />
          <PantryIcon v-if="entry.isDir" class="row-icon" name="folder" :size="18" />
          <FileTypeIcon v-else class="row-icon" :name="entry.name" :size="18" />
          <span class="row-name">{{ entry.name }}</span>
          <span class="row-meta">
            <span v-if="!entry.isDir">{{ formatSize(entry.size) }}</span>
            <span class="row-time">{{ formatTime(entry.mtime) }}</span>
          </span>
        </div>
        <div v-if="loadingMore" class="hint small">正在加载更多…</div>
        <div v-else-if="truncated" class="hint small">目录内容过多，仅显示前 5000 项</div>
      </div>
    </template>

    <div v-if="transfer || downloadNote" class="progress-row">
      <div v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')" class="bar">
        <span class="bar-fill" :style="{ width: `${progressPercent}%` }"></span>
      </div>
      <span class="progress-text">{{ downloadNote || `${progressPercent}%` }}</span>
      <button
        v-if="transfer && (transfer.status === 'accepted' || transfer.status === 'offering')"
        class="link"
        @click="cancelDownload"
      >
        取消
      </button>
      <button
        v-else-if="transfer?.status === 'done' && transfer.direction === 'in'"
        class="link"
        @click="revealDone"
      >
        打开位置
      </button>
    </div>

    <footer class="panel-foot">
      <div class="foot-row">
        <span class="perm" :class="perm">{{ canUpload ? '可上传' : '只读' }}</span>
        <div class="foot-actions">
          <template v-if="pickedCount > 0">
            <button class="ghost" :disabled="downloading" @click="download(true)">另存为</button>
            <button class="primary" :disabled="downloading" @click="download(false)">
              下载（{{ pickedCount }}）
            </button>
          </template>
          <template v-else-if="canUpload">
            <button class="ghost" :disabled="uploading" @click="upload(true)">上传文件夹</button>
            <button class="primary" :disabled="uploading" @click="upload(false)">
              上传到 TA 的文件柜
            </button>
          </template>
          <span v-else class="foot-tip">勾选后可下载</span>
        </div>
      </div>
      <p v-if="canUpload" class="foot-note">{{ uploadHint }}</p>
    </footer>
  </aside>
</template>

<style scoped>
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 320px;
  border-left: 1px solid var(--line);
  background: var(--bg-window);
  box-shadow: -10px 0 28px rgba(0, 0, 0, 0.12);
  z-index: 26;
  display: flex;
  flex-direction: column;
  /* 顶部 40px 让出沉浸式拖拽带（同群信息面板，决议 #67） */
  padding: 40px 0 0;
}

.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
}

.panel-title {
  flex: 1;
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-2);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--line);
  color: var(--primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px 8px;
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
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 2px 4px;
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
}

.crumb.current {
  color: var(--text-1);
  cursor: default;
}

.crumb-sep {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 12px;
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-3);
}

.pick-all {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
}

.list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 12px;
  cursor: pointer;
}

.row:hover,
.row.picked {
  background: var(--bg-list);
}

.row-pick {
  flex-shrink: 0;
}

.row-icon {
  flex-shrink: 0;
  color: var(--text-2);
}

.row-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--text-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
}

.row-time {
  min-width: 66px;
  text-align: right;
}

.hint {
  padding: 16px 12px;
  font-size: 12px;
  color: var(--text-3);
  text-align: center;
}

.hint.small {
  padding: 10px 12px;
}

.hint.error {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  color: var(--text-2);
}

.retry,
.link {
  border: none;
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  cursor: pointer;
}

.progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
}

.bar {
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}

.bar-fill {
  display: block;
  height: 100%;
  background: var(--primary);
  transition: width 160ms linear;
}

.progress-text {
  flex-shrink: 0;
}

.panel.drag-active {
  outline: 2px dashed var(--primary);
  outline-offset: -6px;
}

.panel-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-top: 1px solid var(--line);
}

.foot-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.foot-tip,
.foot-note {
  font-size: 11px;
  color: var(--text-3);
}

.foot-note {
  margin: 0;
  line-height: 1.5;
}

.perm {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  background: var(--line);
  color: var(--text-2);
}

.perm.write {
  background: var(--primary-weak);
  color: var(--primary);
}

.foot-actions {
  flex: 1;
  min-width: 0;
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.primary,
.ghost {
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
  border: 1px solid transparent;
}

.primary {
  background: var(--primary);
  color: #fff;
}

.ghost {
  background: transparent;
  border-color: var(--line);
  color: var(--text-2);
}

.primary:disabled,
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}

@media (prefers-reduced-motion: reduce) {
  .bar-fill {
    transition: none;
  }
}
</style>
