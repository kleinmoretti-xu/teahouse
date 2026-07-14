import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const settingsSource = readFileSync(new URL('../SettingsApp.vue', import.meta.url), 'utf8')
const iconSource = readFileSync(new URL('../components/PantryIcon.vue', import.meta.url), 'utf8')

describe('设置二选一偏好滑块', () => {
  it('头像、主题和发送键共享同一双段滑块结构', () => {
    expect(settingsSource.match(/class="preference-segment/g)).toHaveLength(3)
    expect(settingsSource).not.toContain('NRadioGroup')
    expect(settingsSource).not.toContain('NRadioButton')
    expect(settingsSource).toContain("[data-second='true']::before")
    expect(settingsSource).toContain('transform: translateX(100%)')
  })

  it('主题用本地太阳与月亮图标并保留无障碍名称', () => {
    expect(settingsSource).toContain('name="sun"')
    expect(settingsSource).toContain('name="moon"')
    expect(settingsSource).toContain('aria-label="浅色主题"')
    expect(settingsSource).toContain('aria-label="深色主题"')
    expect(iconSource).toContain("name === 'sun'")
    expect(iconSource).toContain("name === 'moon'")
  })

  it('减少动态效果时取消滑块位移和按压缩放', () => {
    expect(settingsSource).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.preference-segment::before,[\s\S]*?transition: none;/
    )
    expect(settingsSource).toMatch(
      /\.preference-segment button:active \{[\s\S]*?transform: none;/
    )
  })

  it('发送键使用平台化本地键帽图标并保持紧凑', () => {
    expect(settingsSource).toContain("info.value?.platform === 'darwin'")
    expect(settingsSource).toContain("'Command + Enter 发送'")
    expect(settingsSource).toContain("'Control + Enter 发送'")
    expect(settingsSource).toContain('name="key-enter"')
    expect(settingsSource).toContain("'key-command' : 'key-control'")
    expect(settingsSource).toMatch(/\.send-key-segment \{\s*width: 134px;/)
    expect(settingsSource).not.toContain('Ctrl/Cmd+Enter')
    expect(iconSource).toContain("name === 'key-command'")
    expect(iconSource).toContain("name === 'key-control'")
    expect(iconSource).toContain("name === 'key-enter'")
  })

  it('关于页展示项目当前的 GPL v3 许可标识', () => {
    expect(settingsSource).toContain('<dd>GPL-3.0-only</dd>')
    expect(settingsSource).not.toContain('MIT 许可证')
  })
})
