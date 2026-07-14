import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const crop = readFileSync(new URL('../components/AvatarCropDialog.vue', import.meta.url), 'utf8')
const settings = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')
const groupPanel = readFileSync(new URL('../components/GroupPanel.vue', import.meta.url), 'utf8')
const convList = readFileSync(new URL('../components/ConvList.vue', import.meta.url), 'utf8')
const chatPane = readFileSync(new URL('../components/ChatPane.vue', import.meta.url), 'utf8')

describe('自定义头像渲染入口', () => {
  it('裁剪弹窗挂到 body 并具备模态、Esc、拖动、滚轮和忙碌态', () => {
    expect(crop).toContain('<Teleport to="body">')
    expect(crop).toContain('role="dialog"')
    expect(crop).toContain('aria-modal="true"')
    expect(crop).toContain("event.key === 'Escape'")
    expect(crop).toContain('@pointerdown="startDrag"')
    expect(crop).toContain('@wheel.prevent=')
    expect(crop).toContain("busy ? '正在保存…' : '应用头像'")
    expect(crop).toContain('returnFocus?.focus()')
  })

  it('设置页仅保留一个初次图片入口，并支持更换、恢复和失败保留裁剪状态', () => {
    expect(settings).toContain('图片头像')
    expect(settings).toContain('@click="pickCustomAvatar"')
    expect(settings).toContain('<div v-if="avatarHash" class="avatar-picture-actions">')
    expect(settings).not.toContain("avatarHash ? '更换图片' : '选择图片'")
    expect(settings).not.toContain('选择图片')
    expect(settings).toContain('更换图片')
    expect(settings).toContain('恢复默认')
    expect(settings).toContain('pickAvatarSource')
    expect(settings).toContain("setProfileAvatar({ kind: 'custom', bytes })")
    expect(settings).toContain("setProfileAvatar({ kind: 'preset', avatar: avatar.value })")
    expect(settings).toContain("avatarError.value = '保存头像失败，请稍后重试'")
  })

  it('群头像覆盖会话列表、聊天顶部和成员面板并提供管理入口', () => {
    expect(convList).toContain('<GroupAvatar')
    expect(chatPane).toContain('class="group-head-avatar"')
    expect(groupPanel).toContain('class="group-avatar-large"')
    expect(groupPanel).toContain('setGroupAvatar')
    expect(groupPanel).toContain('恢复默认')
  })
})
