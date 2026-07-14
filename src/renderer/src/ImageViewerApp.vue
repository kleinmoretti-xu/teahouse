<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ImageViewer from './components/ImageViewer.vue'
import { allowsAutomaticOcr, applyPerformanceProfile } from './utils/performance-profile'

const params = computed(() => {
  const query = location.hash.includes('?') ? location.hash.slice(location.hash.indexOf('?') + 1) : ''
  return new URLSearchParams(query)
})

const transferId = computed(() => params.value.get('transferId') ?? '')
const src = computed(() => (transferId.value ? `pantry-img://${transferId.value}` : ''))
const runtimeReady = ref(false)
const automaticOcr = ref(false)

onMounted(async () => {
  try {
    const info = await window.pantry.getAppInfo()
    applyPerformanceProfile(info)
    automaticOcr.value = allowsAutomaticOcr(info)
  } finally {
    runtimeReady.value = true
  }
})

function closeViewer(): void {
  void window.pantry.closeWindow()
}
</script>

<template>
  <ImageViewer
    v-if="transferId && runtimeReady"
    :src="src"
    :transfer-id="transferId"
    :automatic-ocr="automaticOcr"
    @close="closeViewer"
  />
  <main v-else-if="!transferId" class="missing">
    <span>图片不可用</span>
  </main>
</template>

<style scoped>
.missing {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--text-2);
  background: var(--bg-chat);
  font-size: 13px;
}
</style>
