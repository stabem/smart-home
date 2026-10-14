import { describe, expect, it, vi } from 'vitest'
import { startDiscoveryOrbit } from './discovery-orbit'

describe('discovery orbit frame lifetime', () => {
  it('schedules no frames while idle or in reduced motion and cancels on exit', () => {
    const element = { style: { transform: '' } } as HTMLElement
    const schedule = vi.fn(() => 7)
    const cancel = vi.fn()
    startDiscoveryOrbit(element, false, false, schedule, cancel)()
    startDiscoveryOrbit(element, true, true, schedule, cancel)()
    expect(schedule).not.toHaveBeenCalled()
    const stop = startDiscoveryOrbit(element, true, false, schedule, cancel)
    expect(schedule).toHaveBeenCalledTimes(1)
    stop()
    expect(cancel).toHaveBeenCalledWith(7)
  })
})
