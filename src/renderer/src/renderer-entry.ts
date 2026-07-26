import type { Component } from 'vue'

export type RendererEntry = 'main' | 'settings' | 'cabinet' | 'capture' | 'image-viewer'

type RendererRootModule = { default: Component }

export function resolveRendererEntry(hash: string): RendererEntry {
  if (hash.startsWith('#/settings')) return 'settings'
  if (hash.startsWith('#/cabinet')) return 'cabinet'
  if (hash.startsWith('#/capture')) return 'capture'
  if (hash.startsWith('#/image-viewer')) return 'image-viewer'
  return 'main'
}

export function loadRendererRoot(entry: RendererEntry): Promise<RendererRootModule> {
  switch (entry) {
    case 'settings':
      return import('./SettingsApp.vue')
    case 'cabinet':
      return import('./CabinetApp.vue')
    case 'capture':
      return import('./CaptureApp.vue')
    case 'image-viewer':
      return import('./ImageViewerApp.vue')
    case 'main':
      return import('./App.vue')
  }
}
