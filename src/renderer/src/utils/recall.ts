export function recallRemainingMs(nowTs: number, msgTs: number, windowMs: number): number {
  return Math.max(0, windowMs - (nowTs - msgTs))
}

export function formatRecallButtonLabel(remainingMs: number, disabledReason = ''): string {
  if (disabledReason) return `撤回（${disabledReason}）`
  if (remainingMs <= 0) return '撤回（超时）'
  const totalSec = Math.ceil(remainingMs / 1000)
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0')
  const ss = String(totalSec % 60).padStart(2, '0')
  return `撤回（${mm}:${ss}）`
}

export function canRecallAt(
  nowTs: number,
  msgTs: number,
  windowMs: number,
  disabledReason = ''
): boolean {
  return disabledReason === '' && nowTs - msgTs <= windowMs
}
