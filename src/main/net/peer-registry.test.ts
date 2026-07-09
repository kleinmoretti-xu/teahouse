import { describe, expect, it } from 'vitest'
import type { Profile } from '../../shared/protocol'
import { PeerRegistry } from './peer-registry'

function profile(nodeId: string, nick: string): Profile {
  return {
    nodeId,
    nick,
    company: '',
    dept: '',
    team: '',
    avatar: -1,
    profileRev: 1,
    host: `${nodeId}-host`,
    platform: 'linux',
    tcpPort: 18888,
    ver: '0.0.0-test',
    caps: []
  }
}

describe('PeerRegistry 列表投影', () => {
  it('values 保留插入顺序，list 保留展示排序', () => {
    const registry = new PeerRegistry('node-self')
    registry.touch('node-zhang', '127.0.0.1', 10001, profile('node-zhang', '张三'))
    registry.touch('node-a', '127.0.0.1', 10002, profile('node-a', '阿明'))
    registry.touch('node-offline', '127.0.0.1', 10003, profile('node-offline', '安安'))
    registry.markOffline('node-offline')

    expect(registry.values().map((record) => record.profile.nick)).toEqual([
      '张三',
      '阿明',
      '安安'
    ])
    expect(registry.list().map((record) => record.profile.nick)).toEqual([
      '阿明',
      '张三',
      '安安'
    ])
  })
})
