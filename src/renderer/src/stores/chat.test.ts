import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationView, MessageView } from '../../../shared/ipc'
import { useChatStore } from './chat'

function msg(id: string, convId = 'single:node-bob'): MessageView {
  return {
    id,
    convId,
    senderId: 'node-self',
    isMine: true,
    kind: 'image',
    text: '[图片]',
    ts: Date.now(),
    seq: 1,
    status: 'sending'
  }
}

function conv(id = 'single:node-bob'): ConversationView {
  return {
    id,
    type: id.startsWith('group:') ? 'group' : 'single',
    peerId: id.startsWith('group:') ? id.slice(6) : id.slice(7),
    unread: 0,
    lastTs: Date.now(),
    preview: '',
    pinned: false,
    muted: false,
    mentioned: false
  }
}

describe('chat store 自己发送后的滚动意图', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('当前会话追加自己发送的媒体消息后请求定位到最新', () => {
    const store = useChatStore()
    store.activeConvId = 'single:node-bob'
    store.viewingHistory = true
    store.messages['single:node-bob'] = []

    expect(store.pushOwn(msg('img-1'))).toBe(true)

    expect(store.messages['single:node-bob'].map((item) => item.id)).toEqual(['img-1'])
    expect(store.viewingHistory).toBe(false)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })

  it('非当前会话的自己消息不抢当前滚动位置', () => {
    const store = useChatStore()
    store.activeConvId = 'single:node-alice'
    store.messages['single:node-bob'] = []

    expect(store.pushOwn(msg('img-2'))).toBe(true)

    expect(store.openScrollRun).toBe(0)
  })

  it('默认打开群会话时重载最新页并定位到底部', async () => {
    const latest = [msg('latest-1', 'group:team')]
    const pageMessages = vi.fn().mockResolvedValue(latest)
    const markRead = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      pantry: {
        pageMessages,
        markRead
      }
    })
    const store = useChatStore()
    store.messages['group:team'] = [msg('old-1', 'group:team')]
    store.scrollPositions['group:team'] = { top: 120, atBottom: false }

    await store.openConv('group:team')

    expect(pageMessages).toHaveBeenCalledWith('group:team', null, 50)
    expect(markRead).toHaveBeenCalledWith('group:team')
    expect(store.messages['group:team']).toEqual(latest)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })

  it('默认打开单聊会话时也按最新入口处理', async () => {
    const latest = [msg('latest-1', 'single:node-bob')]
    const pageMessages = vi.fn().mockResolvedValue(latest)
    const openConversation = vi.fn().mockResolvedValue(conv('single:node-bob'))
    vi.stubGlobal('window', {
      pantry: {
        openConversation,
        pageMessages
      }
    })
    const store = useChatStore()
    store.messages['single:node-bob'] = [msg('old-1')]
    store.scrollPositions['single:node-bob'] = { top: 240, atBottom: false }

    await store.openConv('single:node-bob')

    expect(openConversation).toHaveBeenCalledWith('node-bob')
    expect(pageMessages).toHaveBeenCalledWith('single:node-bob', null, 50)
    expect(store.messages['single:node-bob']).toEqual(latest)
    expect(store.openScrollMode).toBe('latest')
    expect(store.openScrollRun).toBe(1)
  })
})
