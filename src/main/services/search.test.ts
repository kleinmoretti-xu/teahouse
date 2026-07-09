import type DatabaseT from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { PeerRegistry } from '../net/peer-registry'
import { SearchService } from './search'

describe('SearchService 会话内搜索', () => {
  it('相同 SQL 形状复用 prepared statement', () => {
    let conversationPrepareCount = 0
    const db = {
      prepare(sql: string) {
        if (sql.includes('conv_id = @convId')) conversationPrepareCount += 1
        return {
          all: () => [],
          get: () => undefined
        }
      }
    } as unknown as DatabaseT.Database
    const search = new SearchService(db, new PeerRegistry('node-self'))

    search.conversation({ convId: 'single:node-bob', query: '会议', kind: 'all' })
    search.conversation({ convId: 'single:node-bob', query: '项目', kind: 'all' })

    expect(conversationPrepareCount).toBe(1)
  })
})
