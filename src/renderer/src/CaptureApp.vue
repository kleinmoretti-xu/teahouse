<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { mapCaptureRectToImage } from './utils/capture-crop'
import { placeCaptureToolbar } from './utils/capture-toolbar'

// 截图框选窗（F-CAP-1）：屏幕图像做背景 → 拖拽框选 → 发送/复制/取消。
// Esc 取消，Enter=发送。坐标按截图自然尺寸与实际视口分别映射（决议 #221）。

const snapshotUrl = ref('')
const snapshotEl = ref<HTMLImageElement | null>(null)
const dragging = ref(false)
const startX = ref(0)
const startY = ref(0)
const rect = ref<{ x: number; y: number; w: number; h: number } | null>(null)
const barEl = ref<HTMLElement | null>(null)
const toolbarSize = ref({ width: 560, height: 40 })
const viewportSize = ref({ width: window.innerWidth, height: window.innerHeight })
const toolbarPosition = computed(() => {
  const current = rect.value
  if (!current) return { left: 8, top: 8 }
  return placeCaptureToolbar(
    { x: current.x, y: current.y, width: current.w, height: current.h },
    toolbarSize.value,
    viewportSize.value
  )
})
type Tool = 'select' | 'rect' | 'arrow' | 'text' | 'mosaic'
interface Annotation {
  type: Exclude<Tool, 'select'>
  x: number
  y: number
  w: number
  h: number
  text?: string
}
const tool = ref<Tool>('select')
const annotations = ref<Annotation[]>([])
const drawingAnnotation = ref<number | null>(null)

let unsubscribe: (() => void) | null = null
let objectUrl = ''
let snapshotGeneration = 0
let unmounted = false
let moveFrame: number | null = null
let pendingPoint: { x: number; y: number } | null = null

onMounted(() => {
  unsubscribe = window.pantry.onCaptureInit((pngBytes) => {
    void prepareSnapshot(pngBytes)
  })
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', refreshToolbarLayout)
})
onBeforeUnmount(() => {
  unmounted = true
  snapshotGeneration += 1
  unsubscribe?.()
  if (moveFrame !== null) cancelAnimationFrame(moveFrame)
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', refreshToolbarLayout)
})

async function prepareSnapshot(pngBytes: ArrayBuffer): Promise<void> {
  const generation = ++snapshotGeneration
  const nextUrl = URL.createObjectURL(new Blob([pngBytes], { type: 'image/png' }))
  const image = new Image()
  image.src = nextUrl
  try {
    await image.decode()
  } catch {
    URL.revokeObjectURL(nextUrl)
    if (!unmounted && generation === snapshotGeneration) cancel()
    return
  }
  if (unmounted || generation !== snapshotGeneration) {
    URL.revokeObjectURL(nextUrl)
    return
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = nextUrl
  snapshotUrl.value = nextUrl
  rect.value = null
  annotations.value = []
  tool.value = 'select'
  await nextTick()
  await waitForPaint()
  if (!unmounted && generation === snapshotGeneration) await window.pantry.captureReady()
}

async function waitForPaint(): Promise<void> {
  await waitForFrame()
  await waitForFrame()
}

function waitForFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      resolve()
    }
    const timer = window.setTimeout(finish, 100)
    requestAnimationFrame(finish)
  })
}

function refreshToolbarLayout(): void {
  viewportSize.value = { width: window.innerWidth, height: window.innerHeight }
  const bar = barEl.value
  if (!bar) return
  const bounds = bar.getBoundingClientRect()
  if (bounds.width > 0 && bounds.height > 0) {
    toolbarSize.value = { width: bounds.width, height: bounds.height }
  }
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    cancel()
  } else if (event.key === 'Enter' && rect.value) {
    void confirm(true)
  }
}

function onMouseDown(event: MouseEvent): void {
  flushPendingPointerMove()
  if (rect.value && tool.value !== 'select' && inSelection(event.clientX, event.clientY)) {
    startAnnotation(event)
    return
  }
  dragging.value = true
  startX.value = event.clientX
  startY.value = event.clientY
  rect.value = { x: event.clientX, y: event.clientY, w: 0, h: 0 }
  annotations.value = []
}

function onMouseMove(event: MouseEvent): void {
  if (drawingAnnotation.value === null && !dragging.value) return
  pendingPoint = { x: event.clientX, y: event.clientY }
  if (moveFrame !== null) return
  moveFrame = requestAnimationFrame(() => {
    moveFrame = null
    applyPendingPointerMove()
  })
}

function applyPendingPointerMove(): void {
  const point = pendingPoint
  pendingPoint = null
  if (!point) return
  if (drawingAnnotation.value !== null && rect.value) {
    const ann = annotations.value[drawingAnnotation.value]
    ann.w = point.x - rect.value.x - ann.x
    ann.h = point.y - rect.value.y - ann.y
    return
  }
  if (!dragging.value) return
  rect.value = {
    x: Math.min(startX.value, point.x),
    y: Math.min(startY.value, point.y),
    w: Math.abs(point.x - startX.value),
    h: Math.abs(point.y - startY.value)
  }
}

function flushPendingPointerMove(): void {
  if (moveFrame !== null) {
    cancelAnimationFrame(moveFrame)
    moveFrame = null
  }
  applyPendingPointerMove()
}

async function onMouseUp(event: MouseEvent): Promise<void> {
  pendingPoint = { x: event.clientX, y: event.clientY }
  flushPendingPointerMove()
  if (drawingAnnotation.value !== null) {
    const ann = annotations.value[drawingAnnotation.value]
    if (ann && ann.type !== 'text' && Math.abs(ann.w) < 4 && Math.abs(ann.h) < 4) {
      annotations.value.splice(drawingAnnotation.value, 1)
    }
    drawingAnnotation.value = null
    return
  }
  dragging.value = false
  if (rect.value && (rect.value.w < 4 || rect.value.h < 4)) rect.value = null
  if (rect.value) {
    await nextTick()
    refreshToolbarLayout()
  }
}

function cancel(): void {
  void window.pantry.captureDone(new ArrayBuffer(0), false)
}

async function confirm(send: boolean): Promise<void> {
  const r = rect.value
  const img = snapshotEl.value
  if (!r || !img || img.naturalWidth <= 0 || img.naturalHeight <= 0) return
  const crop = mapCaptureRectToImage(
    r,
    { width: window.innerWidth, height: window.innerHeight },
    { width: img.naturalWidth, height: img.naturalHeight }
  )
  if (!crop) return
  const canvas = document.createElement('canvas')
  canvas.width = crop.width
  canvas.height = crop.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.drawImage(
    img,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height
  )
  drawAnnotations(ctx, crop.scaleX, crop.scaleY)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) return
  await window.pantry.captureDone(await blob.arrayBuffer(), send)
}

function inSelection(x: number, y: number): boolean {
  const r = rect.value
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h
}

function startAnnotation(event: MouseEvent): void {
  const r = rect.value
  if (!r) return
  const activeTool = tool.value
  if (activeTool === 'select') return
  const x = event.clientX - r.x
  const y = event.clientY - r.y
  if (activeTool === 'text') {
    const text = window.prompt('输入标注文字')?.trim()
    if (text) annotations.value.push({ type: 'text', x, y, w: 0, h: 0, text: text.slice(0, 80) })
    return
  }
  const ann: Annotation = { type: activeTool, x, y, w: 0, h: 0 }
  annotations.value.push(ann)
  drawingAnnotation.value = annotations.value.length - 1
}

function norm(ann: Annotation): { x: number; y: number; w: number; h: number } {
  return {
    x: Math.min(ann.x, ann.x + ann.w),
    y: Math.min(ann.y, ann.y + ann.h),
    w: Math.abs(ann.w),
    h: Math.abs(ann.h)
  }
}

function annStyle(ann: Annotation): Record<string, string> {
  if (ann.type === 'arrow') return arrowStyle(ann)
  const n = norm(ann)
  return { left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px` }
}

function arrowStyle(ann: Annotation): Record<string, string> {
  const len = Math.hypot(ann.w, ann.h)
  const deg = (Math.atan2(ann.h, ann.w) * 180) / Math.PI
  return {
    left: `${ann.x}px`,
    top: `${ann.y}px`,
    width: `${len}px`,
    transform: `rotate(${deg}deg)`
  }
}

function drawAnnotations(ctx: CanvasRenderingContext2D, scaleX: number, scaleY: number): void {
  const strokeScale = (scaleX + scaleY) / 2
  ctx.save()
  ctx.lineWidth = Math.max(2, 3 * strokeScale)
  ctx.strokeStyle = '#3d8b6b'
  ctx.fillStyle = '#3d8b6b'
  for (const ann of annotations.value) {
    if (ann.type === 'rect') {
      const n = norm(ann)
      ctx.strokeRect(n.x * scaleX, n.y * scaleY, n.w * scaleX, n.h * scaleY)
    } else if (ann.type === 'arrow') {
      drawArrow(
        ctx,
        ann.x * scaleX,
        ann.y * scaleY,
        (ann.x + ann.w) * scaleX,
        (ann.y + ann.h) * scaleY,
        strokeScale
      )
    } else if (ann.type === 'text' && ann.text) {
      ctx.font = `${Math.round(18 * scaleY)}px sans-serif`
      ctx.fillText(ann.text, ann.x * scaleX, ann.y * scaleY)
    } else if (ann.type === 'mosaic') {
      drawMosaic(ctx, norm(ann), scaleX, scaleY)
    }
  }
  ctx.restore()
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  scale: number
): void {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const head = 12 * scale
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - head * Math.cos(angle - Math.PI / 6), y2 - head * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(x2 - head * Math.cos(angle + Math.PI / 6), y2 - head * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function drawMosaic(
  ctx: CanvasRenderingContext2D,
  rect_: { x: number; y: number; w: number; h: number },
  scaleX: number,
  scaleY: number
): void {
  const x = Math.max(0, Math.round(rect_.x * scaleX))
  const y = Math.max(0, Math.round(rect_.y * scaleY))
  const right = Math.min(ctx.canvas.width, Math.round((rect_.x + rect_.w) * scaleX))
  const bottom = Math.min(ctx.canvas.height, Math.round((rect_.y + rect_.h) * scaleY))
  const w = right - x
  const h = bottom - y
  if (w <= 0 || h <= 0) return
  const block = Math.max(6, Math.round(10 * ((scaleX + scaleY) / 2)))
  const data = ctx.getImageData(x, y, w, h)
  for (let by = 0; by < h; by += block) {
    for (let bx = 0; bx < w; bx += block) {
      const idx = ((Math.min(by, h - 1) * w + Math.min(bx, w - 1)) * 4)
      ctx.fillStyle = `rgb(${data.data[idx]}, ${data.data[idx + 1]}, ${data.data[idx + 2]})`
      ctx.fillRect(x + bx, y + by, Math.min(block, w - bx), Math.min(block, h - by))
    }
  }
}
</script>

<template>
  <div
    class="stage"
    @mousedown="onMouseDown"
    @mousemove="onMouseMove"
    @mouseup="onMouseUp"
  >
    <img v-if="snapshotUrl" ref="snapshotEl" class="desktop" :src="snapshotUrl" alt="" />
    <div v-if="!rect" class="dim dim-full"></div>
    <template v-if="rect">
      <div class="dim dim-top" :style="{ height: `${rect.y}px` }"></div>
      <div
        class="dim dim-right"
        :style="{
          left: `${rect.x + rect.w}px`,
          top: `${rect.y}px`,
          height: `${rect.h}px`
        }"
      ></div>
      <div class="dim dim-bottom" :style="{ top: `${rect.y + rect.h}px` }"></div>
      <div
        class="dim dim-left"
        :style="{
          top: `${rect.y}px`,
          width: `${rect.x}px`,
          height: `${rect.h}px`
        }"
      ></div>
      <div
        class="sel"
        :class="{ annotating: tool !== 'select' }"
        :style="{
          left: `${rect.x}px`,
          top: `${rect.y}px`,
          width: `${rect.w}px`,
          height: `${rect.h}px`
        }"
      >
        <div
          v-for="(ann, idx) in annotations"
          :key="idx"
          class="ann"
          :class="ann.type"
          :style="annStyle(ann)"
        >
          <span v-if="ann.type === 'text'">{{ ann.text }}</span>
        </div>
      </div>
      <div
        v-if="!dragging"
        ref="barEl"
        class="bar"
        :style="{
          left: `${toolbarPosition.left}px`,
          top: `${toolbarPosition.top}px`
        }"
        @mousedown.stop
      >
        <span class="size">{{ Math.round(rect.w) }} × {{ Math.round(rect.h) }}</span>
        <button class="btn tool" :class="{ on: tool === 'select' }" @click="tool = 'select'">
          选择
        </button>
        <button class="btn tool" :class="{ on: tool === 'rect' }" @click="tool = 'rect'">
          矩形
        </button>
        <button class="btn tool" :class="{ on: tool === 'arrow' }" @click="tool = 'arrow'">
          箭头
        </button>
        <button class="btn tool" :class="{ on: tool === 'text' }" @click="tool = 'text'">
          文字
        </button>
        <button class="btn tool" :class="{ on: tool === 'mosaic' }" @click="tool = 'mosaic'">
          马赛克
        </button>
        <button class="btn primary" @click="confirm(true)">发送</button>
        <button class="btn" @click="confirm(false)">复制</button>
        <button class="btn" @click="cancel">取消</button>
      </div>
    </template>
    <div v-else class="hint">拖拽框选区域 · Esc 取消</div>
  </div>
</template>

<style scoped>
.stage {
  position: fixed;
  inset: 0;
  background-color: #000;
  cursor: crosshair;
  user-select: none;
  overflow: hidden;
}
.desktop {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  pointer-events: none;
}
.dim {
  position: absolute;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.dim-full,
.dim-top,
.dim-bottom {
  left: 0;
  right: 0;
}
.dim-full {
  top: 0;
  bottom: 0;
}
.dim-top {
  top: 0;
}
.dim-bottom {
  bottom: 0;
}
.dim-left {
  left: 0;
}
.dim-right {
  right: 0;
}
.sel {
  position: absolute;
  border: 2px solid #3d8b6b;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
  pointer-events: none;
  overflow: hidden;
}
.ann {
  position: absolute;
  pointer-events: none;
}
.ann.rect {
  border: 3px solid #3d8b6b;
}
.ann.mosaic {
  background:
    linear-gradient(45deg, rgba(61, 139, 107, 0.35) 25%, transparent 25%) 0 0 / 12px 12px,
    linear-gradient(45deg, transparent 75%, rgba(61, 139, 107, 0.35) 75%) 0 0 / 12px 12px,
    rgba(255, 255, 255, 0.2);
}
.ann.arrow {
  height: 3px;
  background: #3d8b6b;
  transform-origin: 0 50%;
}
.ann.arrow::after {
  content: '';
  position: absolute;
  right: -1px;
  top: -5px;
  border-left: 12px solid #3d8b6b;
  border-top: 6px solid transparent;
  border-bottom: 6px solid transparent;
}
.ann.text {
  color: #3d8b6b;
  font-size: 18px;
  font-weight: 700;
  text-shadow: 0 1px 2px rgba(255, 255, 255, 0.85);
}
.bar {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(28, 28, 28, 0.92);
  border-radius: 6px;
  padding: 6px 10px;
}
.size {
  color: #bbb;
  font-size: 12px;
  margin-right: 4px;
}
.btn {
  border: none;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.14);
  color: #eee;
  font-size: 12px;
  padding: 5px 12px;
  cursor: pointer;
}
.btn.primary {
  background: #3d8b6b;
  color: #fff;
}
.btn.tool.on {
  background: rgba(61, 139, 107, 0.85);
  color: #fff;
}
.hint {
  position: absolute;
  top: 24px;
  left: 50%;
  transform: translateX(-50%);
  color: rgba(255, 255, 255, 0.85);
  background: rgba(0, 0, 0, 0.5);
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 14px;
  pointer-events: none;
}
</style>
