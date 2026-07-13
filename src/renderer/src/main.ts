import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { loadRendererRoot, resolveRendererEntry } from './renderer-entry'
import './styles/tokens.css'

async function bootstrap(): Promise<void> {
  const entry = resolveRendererEntry(location.hash)
  if (entry === 'capture') document.documentElement.dataset.window = 'capture'
  const root = await loadRendererRoot(entry)
  createApp(root.default).use(createPinia()).mount('#app')
}

void bootstrap().catch(() => {
  console.error('[renderer] 窗口入口加载失败')
})
