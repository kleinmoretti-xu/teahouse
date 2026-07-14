import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const crop = readFileSync(new URL('../components/AvatarCropDialog.vue', import.meta.url), 'utf8')
const avatarMark = readFileSync(new URL('../components/AvatarMark.vue', import.meta.url), 'utf8')
const groupAvatar = readFileSync(new URL('../components/GroupAvatar.vue', import.meta.url), 'utf8')
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
    expect(crop).toContain("window.addEventListener('pointermove', moveDrag)")
    expect(crop).toContain('@lostpointercapture="lostPointerCapture"')
    expect(crop).toContain('@wheel.prevent=')
    expect(crop).toContain("busy ? '正在保存…' : '应用头像'")
    expect(crop).toContain('returnFocus?.focus()')
  })

  it('用户与群头像共用短主机名加哈希路径的受管地址', () => {
    expect(avatarMark).toContain("import { avatarImageUrl } from '../../../shared/avatar-url'")
    expect(groupAvatar).toContain("import { avatarImageUrl } from '../../../shared/avatar-url'")
    expect(avatarMark).not.toContain('`pantry-avatar://${')
    expect(groupAvatar).not.toContain('`pantry-avatar://${')
  })

  it('设置页按动物、首字和自定义模式分别展示对应选项', () => {
    expect(settings).toContain('动物表情')
    expect(settings).toContain('昵称首字')
    expect(settings).toContain('自定义头像')
    expect(settings).toContain("v-if=\"avatarMode !== 'custom'\"")
    expect(settings).toContain("v-if=\"avatarMode === 'animal'\"")
    expect(settings).toContain('背景颜色')
    expect(settings).toContain('上传图片')
    expect(settings).toContain('@click="pickCustomAvatar"')
    expect(settings).toContain("avatarMode.value === 'initial'")
    expect(settings).toContain('initialAvatarValue(index)')
    expect(settings).toContain('keepPendingCustomMode')
    expect(settings).not.toContain('图标头像')
    expect(settings).not.toContain('图片头像')
    expect(settings).not.toContain('选择图片')
    expect(settings).not.toContain('更换图片')
    expect(settings).toContain('pickAvatarSource')
    expect(settings).toContain("setProfileAvatar({ kind: 'custom', bytes })")
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
