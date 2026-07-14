<script setup lang="ts">
import { computed, ref } from 'vue'
import type { GroupPatch, GroupView } from '../../../shared/ipc'
import { CAPS, GROUP_MAX_MEMBERS } from '../../../shared/protocol'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import { useGroupsStore } from '../stores/groups'
import {
  canRemoveGroupMember,
  canRenameGroup,
  canSetGroupAdmin,
  prepareGroupAdminPatch,
  type GroupAdminAction
} from '../utils/group-admin'
import PantryIcon from './PantryIcon.vue'
import AvatarMark from './AvatarMark.vue'
import GroupInviteDialog from './GroupInviteDialog.vue'

// 群成员面板（ui-design §5）：角色徽标 / 任免管理员 / 移除 / 开放邀请 / 改名 / 退出。
// 角色权限与管理密码兼容规则统一遵循决议 #241。

const props = defineProps<{ group: GroupView; selfId: string }>()
const emit = defineEmits<{ close: [] }>()

const peersStore = usePeersStore()
const chatStore = useChatStore()
const groupsStore = useGroupsStore()
const renaming = ref(false)
const newName = ref('')
const showInviteDialog = ref(false)
const adminPassword = ref('')
const adminFeedback = ref('')
const adminBusy = ref(false)

const atMemberCap = computed(() => props.group.members.length >= GROUP_MAX_MEMBERS)
const canShowAdmin = computed(() => canRenameGroup(props.group))
const hasLegacyMembers = computed(() =>
  props.group.members.some(
    (id) => id !== props.selfId && !(peersStore.byId(id)?.caps ?? []).includes(CAPS.groupRoles)
  )
)
const adminTip = computed(() => {
  if (!props.group.amMember) return ''
  if (props.group.selfRole === 'owner') return '你是群主，可任免管理员并管理全部成员'
  if (props.group.selfRole === 'admin') return '你是管理员，可修改群名并移出普通成员'
  if (props.group.hasAdminPassword) {
    return props.group.adminHint
      ? `群管理需要管理密码；提示：${props.group.adminHint}`
      : '群管理需要管理密码'
  }
  return '所有成员均可邀请联系人加入群聊'
})

function nameOf(id: string): string {
  // 自己显示「昵称（我）」而非裸「我」（决议 #83）
  if (id === props.selfId) return chatStore.selfNick ? `${chatStore.selfNick}（我）` : '我'
  return peersStore.nameOf(id)
}
function avatarOf(id: string): number {
  // 自己不在 peersStore 里，头像取自己的真实设置（决议 #83）
  if (id === props.selfId) return chatStore.selfAvatar
  return peersStore.byId(id)?.avatar ?? -1
}

async function rename(): Promise<void> {
  const name = newName.value.trim()
  if (!name) {
    renaming.value = false
    return
  }
  const ok = await updateAdmin({ kind: 'rename', name })
  if (ok) renaming.value = false
}

async function removeMember(id: string): Promise<void> {
  if (adminBusy.value) return
  await updateAdmin({ kind: 'remove', memberIds: [id] })
}

async function toggleAdmin(id: string): Promise<void> {
  if (adminBusy.value) return
  const enabled = !props.group.adminIds.includes(id)
  await runUpdate(
    { kind: 'set-admin', memberId: id, enabled },
    enabled ? '设置管理员失败' : '取消管理员失败'
  )
}

async function leave(): Promise<void> {
  await window.pantry.leaveGroup(props.group.groupId)
  emit('close')
}

async function updateAdmin(patch: GroupAdminAction): Promise<boolean> {
  const prepared = prepareGroupAdminPatch(props.group, patch, adminPassword.value)
  if (!prepared.ok) {
    adminFeedback.value =
      prepared.reason === 'missing-password' ? '请输入管理密码' : '当前节点没有管理权限'
    return false
  }

  return runUpdate(prepared.patch, props.group.hasAdminPassword ? '密码不正确，请重新输入' : '当前节点没有管理权限')
}

async function runUpdate(patch: GroupPatch, failureMessage: string): Promise<boolean> {
  adminFeedback.value = ''
  adminBusy.value = true
  try {
    const updated = await window.pantry.updateGroup(props.group.groupId, patch)
    if (!updated) {
      if ('adminPassword' in patch) adminPassword.value = ''
      adminFeedback.value = failureMessage
      return false
    }
    groupsStore.byId[updated.groupId] = updated
    return true
  } finally {
    adminBusy.value = false
  }
}
</script>

<template>
  <aside class="panel">
    <div class="head">
      <template v-if="renaming">
        <input v-model="newName" class="rename" maxlength="32" @keydown.enter="rename" />
        <button class="mini" title="保存" :disabled="adminBusy" @click="rename">
          <PantryIcon name="check" :size="14" />
        </button>
      </template>
      <template v-else>
        <span class="title">{{ group.name }}</span>
        <button
          v-if="canShowAdmin"
          class="mini"
          title="改名"
          @click="((renaming = true), (newName = group.name))"
        >
          <PantryIcon name="edit" :size="14" />
        </button>
      </template>
      <span class="spacer"></span>
      <button class="mini" title="关闭" @click="emit('close')">
        <PantryIcon name="x" :size="14" />
      </button>
    </div>

    <div class="count">成员 {{ group.members.length }} / {{ GROUP_MAX_MEMBERS }}</div>
    <div v-if="adminTip" class="admin-tip">{{ adminTip }}</div>
    <div v-if="hasLegacyMembers" class="compat-tip">群内有旧版本成员，角色或邀请可能无法完整同步，请提醒升级</div>
    <div v-if="group.selfRole === 'member' && group.hasAdminPassword" class="admin-password">
      <input
        v-model="adminPassword"
        type="password"
        maxlength="64"
        placeholder="管理密码"
        :disabled="adminBusy"
        @keydown.enter="renaming ? rename() : undefined"
      />
    </div>
    <div v-if="adminFeedback" class="admin-feedback">{{ adminFeedback }}</div>
    <ul class="members">
      <li v-for="id in group.members" :key="id">
        <AvatarMark
          class="m-avatar"
          :avatar="avatarOf(id)"
          :name="nameOf(id)"
          :presence="id === selfId ? undefined : ((peersStore.byId(id)?.online ?? false) ? 'online' : 'offline')"
        />
        <span class="nm">{{ nameOf(id) }}</span>
        <span v-if="id === group.ownerId" class="role-badge owner">群主</span>
        <span v-else-if="group.adminIds.includes(id)" class="role-badge">管理员</span>
        <button
          v-if="canSetGroupAdmin(group, id)"
          class="mini admin-toggle"
          :class="{ active: group.adminIds.includes(id) }"
          :title="group.adminIds.includes(id) ? '取消管理员' : '设为管理员'"
          :disabled="adminBusy"
          @click="toggleAdmin(id)"
        >
          <PantryIcon name="shield" :size="13" />
        </button>
        <button
          v-if="canRemoveGroupMember(group, id, selfId)"
          class="mini danger"
          title="移出"
          :disabled="adminBusy"
          @click="removeMember(id)"
        >
          <PantryIcon name="x" :size="13" />
        </button>
      </li>
    </ul>

    <template v-if="group.amMember">
      <button
        class="add"
        :disabled="adminBusy || atMemberCap"
        :title="atMemberCap ? `最多 ${GROUP_MAX_MEMBERS} 人` : '添加成员'"
        @click="showInviteDialog = true"
      >
        <PantryIcon name="plus" :size="14" />{{ atMemberCap ? '已满员' : '添加成员' }}
      </button>
      <button class="leave" @click="leave">退出讨论组</button>
    </template>
    <p v-else class="left-tip">你已不在该讨论组（历史保留，无法发言）</p>

    <GroupInviteDialog
      v-if="showInviteDialog && group.amMember"
      :group="group"
      @close="showInviteDialog = false"
    />
  </aside>
</template>

<style scoped>
/* 覆盖右侧一整列（决议 #67）：绝对定位相对 .chat，从顶到底，盖在消息之上不挤压；
   顶部留 32px 让出沉浸式拖拽带 */
.panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 248px;
  border-left: 1px solid var(--line);
  background: var(--bg-window);
  box-shadow: -10px 0 28px rgba(0, 0, 0, 0.12);
  z-index: 26;
  display: flex;
  flex-direction: column;
  padding: 40px 12px 12px;
  gap: 8px;
}
.head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rename {
  flex: 1;
  height: 26px;
  border: 1px solid var(--primary);
  border-radius: 4px;
  padding: 0 6px;
  font-size: 13px;
  outline: none;
  user-select: text;
}
.spacer {
  flex: 1;
}
.mini {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-3);
  width: 24px;
  height: 24px;
  padding: 0;
  display: grid;
  place-items: center;
}
.mini:disabled {
  cursor: default;
  opacity: 0.45;
}
.mini.danger:hover {
  color: var(--danger);
}
.count {
  font-size: 11px;
  color: var(--text-3);
}
.admin-tip {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.4;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--bg-list);
}
.compat-tip {
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-2);
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: 4px;
  background: var(--bg-list);
}
.admin-password input {
  width: 100%;
  height: 28px;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 8px;
  font-size: 12px;
  color: var(--text-1);
  background: var(--bg-window);
  outline: none;
  user-select: text;
}
.admin-password input:focus {
  border-color: var(--primary);
}
.admin-password input:disabled {
  opacity: 0.65;
}
.admin-feedback {
  min-height: 16px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--danger);
}
.members {
  list-style: none;
  overflow-y: auto;
  flex: 1;
}
.members li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 2px;
  font-size: 13px;
}
.m-avatar {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  font-size: 12px;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.on {
  background: var(--online);
}
.dot.off {
  background: var(--offline);
}
.nm {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.role-badge {
  flex-shrink: 0;
  padding: 1px 5px;
  border: 1px solid var(--primary);
  border-radius: 999px;
  color: var(--primary);
  background: var(--primary-weak);
  font-size: 10px;
  line-height: 15px;
}
.role-badge.owner {
  color: var(--text-2);
  border-color: var(--line);
  background: var(--bg-list);
}
.admin-toggle.active {
  color: var(--primary);
}
.add {
  border: 1px dashed var(--line);
  background: transparent;
  border-radius: 4px;
  font-size: 12px;
  padding: 6px;
  cursor: pointer;
  color: var(--primary);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}
.add:disabled {
  cursor: default;
  opacity: 0.55;
}
.leave {
  margin-top: auto;
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 4px;
  font-size: 12px;
  padding: 7px;
  cursor: pointer;
  color: var(--danger);
}
.left-tip {
  font-size: 12px;
  color: var(--text-3);
  margin-top: auto;
}
</style>
