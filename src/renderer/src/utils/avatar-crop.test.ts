import { describe, expect, it } from 'vitest'
import { avatarCoverScale, avatarCropSourceRect, clampAvatarOffset } from './avatar-crop'

describe('头像裁剪几何', () => {
  it('横图和竖图以居中覆盖作为最小缩放', () => {
    expect(avatarCoverScale(400, 200, 200)).toBe(1)
    expect(
      avatarCropSourceRect({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 100, y: 0, size: 200 })

    expect(avatarCoverScale(200, 400, 200)).toBe(1)
    expect(
      avatarCropSourceRect({
        imageWidth: 200,
        imageHeight: 400,
        viewportSize: 200,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 0, y: 100, size: 200 })
  })

  it('拖动边界始终填满裁剪区', () => {
    expect(
      clampAvatarOffset({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 1,
        offsetX: 999,
        offsetY: -999
      })
    ).toEqual({ x: 100, y: 0 })
  })

  it('缩放后按当前比例换算源图裁剪区域', () => {
    expect(
      avatarCropSourceRect({
        imageWidth: 400,
        imageHeight: 200,
        viewportSize: 200,
        zoom: 4,
        offsetX: 0,
        offsetY: 0
      })
    ).toEqual({ x: 175, y: 75, size: 50 })
  })
})
