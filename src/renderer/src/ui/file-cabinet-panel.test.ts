import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const panelSource = readFileSync(
  new URL('../components/FileCabinetPanel.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

const chatSource = readFileSync(
  new URL('../components/ChatPane.vue', import.meta.url),
  'utf8'
).replace(/\r\n?/g, '\n')

describe('文件柜翻页失败不清空列表（决议 #278）', () => {
  it('首屏失败与翻页失败用两个独立状态', () => {
    expect(panelSource).toContain('const failReason = ref<ShareBrowseFailReason | null>(null)')
    expect(panelSource).toContain('const moreFailReason = ref<ShareBrowseFailReason | null>(null)')
  })

  it('loadMore 失败只写 moreFailReason，绝不碰整页错误态', () => {
    const body = panelSource.slice(
      panelSource.indexOf('async function loadMore()'),
      panelSource.indexOf('function onScroll(')
    )
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('moreFailReason.value = result.reason')
    // 整页错误态只属于首屏 load()，翻页写它就会把已加载条目整片替换掉
    expect(body).not.toContain('failReason.value = result.reason')
    // 快照失效仍按原样静默重来
    expect(body).toContain("if (result.reason === 'gone')")
  })

  it('翻页失败后停止自动续拉，交给用户点重试', () => {
    const body = panelSource.slice(
      panelSource.indexOf('function onScroll('),
      panelSource.indexOf('function open(')
    )
    expect(body).toContain('if (moreFailReason.value) return')
  })

  it('失败提示挂在列表末尾并带重试按钮', () => {
    expect(panelSource).toMatch(
      /v-else-if="moreFailReason"[\s\S]{0,200}\{\{ moreFailText \}\}[\s\S]{0,200}@click="loadMore"/
    )
  })

  it('重新载入目录会清掉翻页失败提示', () => {
    const body = panelSource.slice(
      panelSource.indexOf('async function load('),
      panelSource.indexOf('async function loadMore()')
    )
    expect(body).toContain('moreFailReason.value = null')
  })
})

describe('切换会话重置文件柜面板（决议 #278）', () => {
  it('会话切换的 watch 里与群成员面板一起收起', () => {
    const watchBody = chatSource.slice(
      chatSource.indexOf('  () => chatStore.activeConv?.peerId,'),
      chatSource.indexOf('{ immediate: true }')
    )
    expect(watchBody.length).toBeGreaterThan(0)
    expect(watchBody).toContain('showMembers.value = false')
    expect(watchBody).toContain('showCabinet.value = false')
  })
})
