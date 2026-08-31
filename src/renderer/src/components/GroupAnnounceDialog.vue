<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import type { GroupView } from '../../../shared/ipc'
import PantryIcon from './PantryIcon.vue'

const props = defineProps<{ group: GroupView }>()
const emit = defineEmits<{ close: [] }>()

const announce = ref('')
const saving = ref(false)
const feedback = ref('')

const charCount = computed(() => announce.value.length)
const canSave = computed(() => !saving.value && announce.value.trim().length > 0)
const isOwnerOrAdmin = computed(() => props.group.canManage)

onMounted(() => {
  announce.value = props.group.announce ?? ''
  void nextTick(() => {
    const el = document.querySelector('#group-announce-input') as HTMLTextAreaElement | null
    el?.focus()
  })
})

async function save(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  feedback.value = ''
  try {
    const updated = await window.pantry.updateGroup(props.group.groupId, {
      kind: 'set-announce',
      announce: announce.value.trim()
    })
    if (!updated) {
      feedback.value = isOwnerOrAdmin.value ? '保存群公告失败，请重试' : '无权限操作'
      return
    }
    emit('close')
  } catch {
    feedback.value = '保存群公告失败，请稍后重试'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="mask" @mousedown.self="emit('close')">
      <section class="dialog" role="dialog" aria-modal="true" tabindex="-1">
        <div class="header">
          <h3>设置群公告</h3>
          <button class="close-btn" title="关闭" @click="emit('close')">
            <PantryIcon name="x" :size="16" />
          </button>
        </div>
        <div class="body">
          <p class="hint">群公告将在群聊顶部展示，最多 1024 字</p>
          <textarea
            id="group-announce-input"
            v-model="announce"
            maxlength="1024"
            rows="6"
            class="textarea"
            placeholder="请输入群公告（1-1024字）"
          ></textarea>
          <div class="char-count">{{ charCount }} / 1024</div>
          <div v-if="feedback" class="feedback">{{ feedback }}</div>
        </div>
        <div class="footer">
          <button class="ghost" :disabled="saving" @click="emit('close')">取消</button>
          <button class="primary" :disabled="!canSave || saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(18, 31, 25, 0.45);
  display: grid;
  place-items: center;
  z-index: 1200;
  animation: mask-in 140ms ease-out;
}
.dialog {
  width: min(460px, calc(100vw - 32px));
  background: var(--bg-window);
  border: 1px solid var(--line);
  border-radius: 12px;
  box-shadow: var(--shadow-float);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  animation: dialog-in 180ms cubic-bezier(0.16, 1, 0.3, 1);
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px 10px;
  border-bottom: 1px solid var(--line);
}
.header h3 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.close-btn {
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-3);
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  border-radius: 6px;
}
.close-btn:hover {
  background: var(--bg-list);
  color: var(--text-1);
}
.body {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.hint {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
}
.textarea {
  width: 100%;
  min-height: 120px;
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-1);
  background: var(--bg-input);
  resize: vertical;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
}
.textarea:focus {
  border-color: var(--primary);
}
.char-count {
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
}
.feedback {
  font-size: 12px;
  color: var(--danger);
}
.footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 10px 16px;
  border-top: 1px solid var(--line);
}
.ghost {
  border: 1px solid var(--line);
  background: transparent;
  border-radius: 8px;
  font-size: 13px;
  padding: 6px 16px;
  cursor: pointer;
  color: var(--text-2);
}
.ghost:disabled {
  opacity: 0.5;
  cursor: default;
}
.primary {
  border: none;
  background: var(--primary);
  color: #fff;
  font-size: 13px;
  padding: 6px 18px;
  border-radius: 8px;
  cursor: pointer;
}
.primary:disabled {
  opacity: 0.4;
  cursor: default;
}
@keyframes mask-in {
  from { opacity: 0; }
}
@keyframes dialog-in {
  from { opacity: 0; transform: translateY(6px) scale(0.985); }
}
@media (prefers-reduced-motion: reduce) {
  .mask, .dialog { animation: none; }
}
</style>
