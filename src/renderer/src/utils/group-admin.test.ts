import { describe, expect, it } from 'vitest'
import type { GroupView } from '../../../shared/ipc'
import { prepareGroupAdminPatch } from './group-admin'

function group(overrides: Partial<GroupView> = {}): GroupView {
  return {
    groupId: 'group-1',
    name: '项目组',
    members: ['node-self', 'node-a'],
    rev: 1,
    amMember: true,
    creatorIp: '10.0.0.1',
    hasAdminPassword: false,
    adminHint: '',
    canManage: true,
    ...overrides
  }
}

describe('group admin helpers', () => {
  it('密码组没有输入密码时阻止管理操作', () => {
    const result = prepareGroupAdminPatch(
      group({ hasAdminPassword: true, canManage: false }),
      { name: '新群名' },
      '   '
    )

    expect(result).toEqual({ ok: false, reason: 'missing-password' })
  })

  it('密码组把显式输入的密码写入 group:update payload', () => {
    const result = prepareGroupAdminPatch(
      group({ hasAdminPassword: true, canManage: false }),
      { name: '新群名' },
      '  s3cret  '
    )

    expect(result).toEqual({
      ok: true,
      patch: { name: '新群名', adminPassword: 's3cret' }
    })
  })

  it('无密码且当前节点有权限时不附带管理密码', () => {
    const result = prepareGroupAdminPatch(group(), { remove: ['node-a'] }, '')

    expect(result).toEqual({
      ok: true,
      patch: { remove: ['node-a'] }
    })
  })
})
