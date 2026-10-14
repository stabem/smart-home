export function fitWindowHeight(contentHeight: number, workAreaHeight: number): number {
  const available = Math.max(200, Math.floor(workAreaHeight) - 24)
  if (!Number.isFinite(contentHeight)) return Math.min(640, available)
  return Math.min(Math.max(640, Math.ceil(contentHeight) + 36), available)
}
