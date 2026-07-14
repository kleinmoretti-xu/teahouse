import type { AppInfo } from '../../../shared/ipc'

type PerformanceProfile = Pick<AppInfo, 'softwareRendering'>

export function allowsAutomaticOcr(profile: PerformanceProfile): boolean {
  return !profile.softwareRendering
}

export function applyPerformanceProfile(
  profile: PerformanceProfile,
  root: HTMLElement = document.documentElement
): void {
  root.dataset.rendering = profile.softwareRendering ? 'software' : 'hardware'
}
