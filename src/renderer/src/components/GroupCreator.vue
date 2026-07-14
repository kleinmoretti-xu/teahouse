<script setup lang="ts">
import { computed, ref } from 'vue'
import { NButton, NInput } from 'naive-ui'
import type { PeerView } from '../../../shared/ipc'
import { GROUP_MAX_MEMBERS } from '../../../shared/protocol'
import { usePeersStore } from '../stores/peers'
import { useChatStore } from '../stores/chat'
import PantryIcon from './PantryIcon.vue'

// 发起讨论组（ui-design §7.1）：搜索选人 → 下一步设置组名 / 管理密码 / 密码提示。

const props = defineProps<{ preselect?: string[] }>()
const emit = defineEmits<{ close: [] }>()

const peersStore = usePeersStore()
const chatStore = useChatStore()
const step = ref<'members' | 'settings'>('members')
const query = ref('')
const name = ref('')
const adminPassword = ref('')
const adminPasswordConfirm = ref('')
const adminHint = ref('')
const picked = ref(new Set<string>(props.preselect ?? []))
const creating = ref(false)

const selectedPeers = computed(() =>
  [...picked.value]
    .map((id) => peersStore.byId(id))
    .filter((peer): peer is PeerView => !!peer)
)

const fallbackName = computed(() => {
  const names = selectedPeers.value.slice(0, 3).map((peer) => displayName(peer))
  return names.length > 0 ? `${names.join('、')} 的讨论组` : '讨论组'
})

const filteredPeers = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  if (!keyword) return peersStore.peers
  return peersStore.peers.filter((peer) =>
    [
      peer.remark,
      peer.nick,
      peer.company,
      peer.dept,
      peer.team,
      peer.ip,
      peer.host
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(keyword)
  )
})

const passwordError = computed(() => {
  const password = adminPassword.value.trim()
  const confirm = adminPasswordConfirm.value.trim()
  if (!password && !confirm) {
    return adminHint.value.trim() ? '密码提示需要先设置管理密码' : ''
  }
  if (!password || !confirm) return '请完整输入两次管理密码'
  if (password !== confirm) return '两次输入的管理密码不一致'
  return ''
})

// 建群时本机会自动入组，可选他人最多 GROUP_MAX_MEMBERS - 1
const maxPickOthers = GROUP_MAX_MEMBERS - 1
const canNext = computed(() => picked.value.size >= 1)
const canCreate = computed(() => canNext.value && !passwordError.value && !creating.value)
const atPickCap = computed(() => picked.value.size >= maxPickOthers)

function displayName(peer: PeerView): string {
  return peer.remark || peer.nick
}

function toggle(nodeId: string): void {
  const next = new Set(picked.value)
  if (next.has(nodeId)) next.delete(nodeId)
  else if (next.size >= maxPickOthers) return
  else next.add(nodeId)
  picked.value = next
}

function removePicked(nodeId: string): void {
  const next = new Set(picked.value)
  next.delete(nodeId)
  picked.value = next
  if (picked.value.size === 0) step.value = 'members'
}

function nextStep(): void {
  if (!canNext.value) return
  if (!name.value.trim()) name.value = fallbackName.value
  step.value = 'settings'
}

async function create(): Promise<void> {
  if (!canCreate.value) return
  creating.value = true
  const group = await window.pantry.createGroup(
    name.value.trim() || fallbackName.value,
    [...picked.value],
    adminPassword.value.trim(),
    adminHint.value.trim()
  )
  creating.value = false
  if (group) {
    await chatStore.openConv(`group:${group.groupId}`)
    emit('close')
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <header class="head">
        <h3>发起讨论组</h3>
        <div class="steps">
          <span :class="{ active: step === 'members' }">选人</span>
          <span :class="{ active: step === 'settings' }">设置</span>
        </div>
      </header>

      <section v-if="step === 'members'" class="page">
        <NInput
          v-model:value="query"
          class="search"
          size="small"
          maxlength="40"
          autofocus
          placeholder="搜索联系人、部门、团队或 IP"
          :input-props="{ 'aria-label': '搜索讨论组成员' }"
        />
        <div class="pick-list">
          <label
            v-for="p in filteredPeers"
            :key="p.nodeId"
            class="pick"
            :class="{ disabled: atPickCap && !picked.has(p.nodeId) }"
          >
            <input
              type="checkbox"
              :checked="picked.has(p.nodeId)"
              :disabled="atPickCap && !picked.has(p.nodeId)"
              @change="toggle(p.nodeId)"
            />
            <span class="dot" :class="p.online ? 'on' : 'off'"></span>
            <span class="person">
              <span class="nm">{{ displayName(p) }}</span>
              <span class="meta">{{ [p.company, p.dept, p.team].filter(Boolean).join(' / ') }}</span>
            </span>
            <em v-if="!p.online" class="off-tag">离线</em>
          </label>
          <p v-if="peersStore.peers.length === 0" class="empty">还没有发现任何节点</p>
          <p v-else-if="filteredPeers.length === 0" class="empty">没有匹配的联系人</p>
        </div>
      </section>

      <section v-else class="page">
        <div class="field">
          <label for="group-name">组名</label>
          <NInput
            v-model:value="name"
            class="form-input"
            maxlength="32"
            :placeholder="fallbackName"
            :input-props="{ id: 'group-name' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-password">管理密码</label>
          <NInput
            v-model:value="adminPassword"
            class="form-input"
            maxlength="64"
            type="password"
            placeholder="选填；留空仅创建 IP 可管理"
            :input-props="{ id: 'group-admin-password' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-password-confirm">确认密码</label>
          <NInput
            v-model:value="adminPasswordConfirm"
            class="form-input"
            maxlength="64"
            type="password"
            placeholder="再次输入管理密码"
            :input-props="{ id: 'group-admin-password-confirm' }"
          />
        </div>
        <div class="field">
          <label for="group-admin-hint">密码提示</label>
          <NInput
            v-model:value="adminHint"
            class="form-input"
            maxlength="40"
            placeholder="选填；成员输入密码时显示"
            :input-props="{ id: 'group-admin-hint' }"
          />
        </div>
        <p v-if="passwordError" class="error">{{ passwordError }}</p>
        <p v-else class="hint">管理密码不会保存明文；提示只用于帮成员回忆密码。</p>
      </section>

      <div v-if="selectedPeers.length > 0" class="picked-bar">
        <span class="count">
          已选 {{ selectedPeers.length }} 人（+你，最多 {{ GROUP_MAX_MEMBERS }}）
        </span>
        <button
          v-for="peer in selectedPeers.slice(0, 5)"
          :key="peer.nodeId"
          class="chip"
          @click="removePicked(peer.nodeId)"
        >
          <span>{{ displayName(peer) }}</span>
          <PantryIcon name="x" :size="12" />
        </button>
        <span v-if="selectedPeers.length > 5" class="more">+{{ selectedPeers.length - 5 }}</span>
      </div>

      <div class="foot">
        <NButton
          size="small"
          secondary
          @click="step === 'settings' ? (step = 'members') : emit('close')"
        >
          {{ step === 'settings' ? '上一步' : '取消' }}
        </NButton>
        <NButton
          v-if="step === 'members'"
          type="primary"
          size="small"
          :disabled="!canNext"
          @click="nextStep"
        >
          下一步
        </NButton>
        <NButton
          v-else
          type="primary"
          size="small"
          :disabled="!canCreate"
          :loading="creating"
          @click="create"
        >
          {{ creating ? '创建中' : '创建' }}
        </NButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: grid;
  place-items: center;
  z-index: 15;
}
.dialog {
  width: 460px;
  background: var(--bg-window);
  border-radius: 8px;
  padding: 18px 20px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.16);
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
h3 {
  font-size: 15px;
  flex: 1;
}
.steps {
  display: flex;
  gap: 6px;
  color: var(--text-3);
  font-size: 12px;
}
.steps span {
  border-radius: 4px;
  padding: 2px 7px;
}
.steps .active {
  color: var(--primary);
  background: var(--primary-weak);
}
.page {
  min-height: 318px;
}
.search {
  width: 100%;
  margin-bottom: 10px;
}
.pick-list {
  max-height: 274px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px;
}
.pick {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 6px 8px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 4px;
}
.pick:hover {
  background: var(--line);
}
.pick.disabled {
  opacity: 0.45;
  cursor: default;
}
.pick.disabled:hover {
  background: transparent;
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
.person {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.nm,
.meta {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.meta {
  font-size: 11px;
  color: var(--text-3);
  min-height: 14px;
}
.off-tag {
  font-style: normal;
  font-size: 11px;
  color: var(--text-3);
}
.empty {
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  padding: 16px 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--text-2);
}
.form-input {
  width: 100%;
}
.hint,
.error {
  font-size: 12px;
  line-height: 1.5;
}
.hint {
  color: var(--text-3);
}
.error {
  color: var(--danger);
}
.picked-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  border-top: 1px solid var(--line);
  padding-top: 10px;
  margin-top: 10px;
}
.count {
  color: var(--text-3);
  font-size: 12px;
  flex: 0 0 auto;
  margin-right: 2px;
}
.chip {
  max-width: 76px;
  height: 24px;
  border: none;
  border-radius: 4px;
  padding: 0 6px;
  background: var(--primary-weak);
  color: var(--primary);
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
}
.chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more {
  color: var(--text-3);
  font-size: 12px;
}
.foot {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}
</style>
