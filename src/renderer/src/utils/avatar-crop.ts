import { AVATAR_MAX_BYTES, AVATAR_OUTPUT_SIZE } from '../../../shared/protocol'

export interface AvatarCropState {
  imageWidth: number
  imageHeight: number
  viewportSize: number
  zoom: number
  offsetX: number
  offsetY: number
}

export function avatarCoverScale(
  imageWidth: number,
  imageHeight: number,
  viewportSize: number
): number {
  return Math.max(viewportSize / imageWidth, viewportSize / imageHeight)
}

export function clampAvatarOffset(state: AvatarCropState): { x: number; y: number } {
  const scale = avatarCoverScale(state.imageWidth, state.imageHeight, state.viewportSize) * state.zoom
  const maxX = Math.max(0, (state.imageWidth * scale - state.viewportSize) / 2)
  const maxY = Math.max(0, (state.imageHeight * scale - state.viewportSize) / 2)
  return {
    x: maxX === 0 ? 0 : Math.max(-maxX, Math.min(maxX, state.offsetX)),
    y: maxY === 0 ? 0 : Math.max(-maxY, Math.min(maxY, state.offsetY))
  }
}

export function avatarCropSourceRect(state: AvatarCropState): {
  x: number
  y: number
  size: number
} {
  const scale = avatarCoverScale(state.imageWidth, state.imageHeight, state.viewportSize) * state.zoom
  const size = state.viewportSize / scale
  return {
    x: state.imageWidth / 2 - state.offsetX / scale - size / 2,
    y: state.imageHeight / 2 - state.offsetY / scale - size / 2,
    size
  }
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

export async function renderAvatarWebp(
  image: CanvasImageSource,
  state: AvatarCropState
): Promise<ArrayBuffer> {
  const canvas = document.createElement('canvas')
  canvas.width = AVATAR_OUTPUT_SIZE
  canvas.height = AVATAR_OUTPUT_SIZE
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建图片处理画布')
  const source = avatarCropSourceRect(state)
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(
    image,
    source.x,
    source.y,
    source.size,
    source.size,
    0,
    0,
    AVATAR_OUTPUT_SIZE,
    AVATAR_OUTPUT_SIZE
  )
  for (const quality of [0.86, 0.78, 0.68, 0.56, 0.44, 0.32]) {
    const blob = await canvasBlob(canvas, quality)
    if (blob && blob.size <= AVATAR_MAX_BYTES) return blob.arrayBuffer()
  }
  throw new Error('图片细节过多，请调整裁剪范围后重试')
}
