import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../components/PeerList.vue', import.meta.url), 'utf8')

describe('通讯录联系人在线状态', () => {
  it('只用绿灰状态点与灰显表达状态，不重复显示离线文字（决议 #252）', () => {
    expect(source).toContain('<span class="dot" :class="row.peer!.online ? \'on\' : \'off\'"></span>')
    expect(source).toContain(':class="{ dim: !row.peer!.online }"')
    expect(source).not.toContain('class="offline-tag"')
    expect(source).not.toContain('· 离线')
  })
})
