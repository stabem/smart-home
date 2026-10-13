import { describe, expect, it, vi } from 'vitest'
import { HomeController } from './home'
import type { SavedSetup, SetupStore } from './store'
import type { SmartLifeCloud, SmartLifeHome, SmartLifeSession, TuyaService } from './tuya'
import type { LgClient } from './lg/client'

const homes: SmartLifeHome[] = [{ id: 'home-1', name: 'Casa', devices: [
  { id: 'light-1', name: 'Luz', category: 'dj', localKey: 'fake-key', homeId: 'home-1', roomId: 'r1', roomName: 'Sala de estar', version: '3.4', ip: '192.0.2.2' },
  { id: 'light-2', name: 'Luz office', category: 'kg', localKey: 'fake-key-2', homeId: 'home-1', roomId: 'r2', roomName: 'Office', version: '3.3', ip: '192.0.2.3' }
] }]
const session = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: 9999999999999, uid: 'fake', terminalId: 'fake' } as SmartLifeSession

function harness(initial: SavedSetup | null = null) {
  let saved = initial
  const store = { load: vi.fn(() => saved), save: vi.fn((value: SavedSetup) => { saved = value }) }
  const cloud = { startLogin: vi.fn(async () => ({ token: 'fake-qr', qrUri: 'tuyaSmart--qrLogin?token=fake-qr' })), pollLogin: vi.fn(async () => session) }
  const tuya = { discover: vi.fn(async () => homes), restore: vi.fn(async () => {}), getState: vi.fn(async () => ({ on: false, online: true })), setLight: vi.fn(async () => ({ on: true, online: true })) }
  const lg = { listAcs: vi.fn(async () => [
    { id: 'ac-1', name: 'Ar Sala de estar', state: { on: false, targetTemperature: 23, online: true } },
    { id: 'ac-2', name: 'Ar Office', state: { on: false, targetTemperature: 23, online: true } },
    { id: 'ac-3', name: 'Ar Quarto', state: { on: false, targetTemperature: 23, online: true } }
  ]), getAcState: vi.fn(async () => ({ on: false, targetTemperature: 23, online: true })), setAc: vi.fn(async () => {}) }
  const home = new HomeController(store as unknown as SetupStore, cloud as unknown as SmartLifeCloud, tuya as unknown as TuyaService, lg as unknown as LgClient)
  return { home, store, cloud, tuya, lg }
}

describe('main process setup and control', () => {
  it('requires discovery before save and keeps local keys out of renderer rooms', async () => {
    const { home, store } = harness()
    expect(home.status().configured).toBe(false)
    await expect(home.save()).rejects.toThrow('Busque dispositivos')
    await home.beginLogin()
    const rooms = await home.discover()
    expect(rooms.map(room => room.name)).toEqual(['Sala de estar', 'Office', 'Quarto'])
    expect(rooms[0].ac?.id).toBe('ac-1')
    expect(JSON.stringify(rooms)).not.toContain('fake-key')
    await home.save()
    expect(store.save).toHaveBeenCalledOnce()
    expect(home.status()).toEqual({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true })
  })

  it('routes known device commands and rejects an offline light', async () => {
    const initial = { homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] }
    const { home, tuya, lg } = harness(initial)
    await home.command({ kind: 'light.power', deviceId: 'light-1', on: true })
    expect(tuya.setLight).toHaveBeenCalledWith('light-1', { on: true })
    await home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 22 })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { targetTemperature: 22 })
    tuya.setLight.mockResolvedValueOnce({ on: false, online: false })
    await expect(home.command({ kind: 'light.power', deviceId: 'light-1', on: true })).rejects.toThrow('offline')
    await expect(home.command({ kind: 'light.power', deviceId: 'unknown', on: true })).rejects.toThrow('not found')
  })
})
