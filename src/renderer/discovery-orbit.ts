export function startDiscoveryOrbit(
  element: HTMLElement | null,
  active: boolean,
  reducedMotion: boolean,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame
): () => void {
  if (!element || !active || reducedMotion) return () => undefined
  let frame = 0
  let stopped = false
  const start = performance.now()
  const tick = (now: number) => {
    if (stopped) return
    element.style.transform = `rotate(${(now - start) * .004}deg)`
    frame = schedule(tick)
  }
  frame = schedule(tick)
  return () => { stopped = true; cancel(frame) }
}
