import type { GroupPatch, GroupView } from '../../../shared/ipc'

export type GroupAdminAction = Pick<GroupPatch, 'name' | 'add' | 'remove'>

export type GroupAdminPatchResult =
  | { ok: true; patch: GroupPatch }
  | { ok: false; reason: 'missing-password' | 'not-allowed' }

export function prepareGroupAdminPatch(
  group: GroupView,
  action: GroupAdminAction,
  rawPassword: string
): GroupAdminPatchResult {
  if (!group.canManage && !group.hasAdminPassword) return { ok: false, reason: 'not-allowed' }

  const patch: GroupPatch = { ...action }
  if (!group.hasAdminPassword) return { ok: true, patch }

  const adminPassword = rawPassword.trim()
  if (!adminPassword) return { ok: false, reason: 'missing-password' }
  patch.adminPassword = adminPassword
  return { ok: true, patch }
}
