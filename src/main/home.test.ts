import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeController } from './home'
import type { SavedSetup, SetupStore } from './store'
import { SmartLifeCloud, TuyaService, type SmartLifeHome, type SmartLifeSession } from './tuya'
import type { TuyaLanClient } from './tuya'
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
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  it('requires discovery before save and keeps local keys out of renderer rooms', async () => {
    const { home, store } = harness()
    expect(home.status().configured).toBe(false)
    await expect(home.save()).rejects.toThrow('Busque dispositivos')
    await home.beginLogin('test-code')
    const rooms = await home.discover()
    expect(rooms.map(room => room.name)).toEqual(['Sala de estar', 'Office', 'Quarto'])
    expect(rooms[0].acs[0]?.id).toBe('ac-1')
    expect(JSON.stringify(rooms)).not.toContain('fake-key')
    await home.save()
    expect(store.save).toHaveBeenCalledOnce()
    expect(home.status()).toEqual({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true, smartLifeUserCodeConfigured: true, smartLifeConnected: true })
  })

  it('routes known device commands and rejects an offline light', async () => {
    const initial = { homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] }
    const { home, tuya, lg } = harness(initial)
    await home.command({ kind: 'light.power', deviceId: 'light-1', on: true })
    expect(tuya.setLight).toHaveBeenCalledWith('light-1', { on: true })
    await home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 22 })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { targetTemperature: 22 })
    await home.command({ kind: 'ac.mode', deviceId: 'ac-1', mode: 'Seco' })
    await home.command({ kind: 'ac.fan', deviceId: 'ac-1', fan: 'Média' })
    await home.command({ kind: 'ac.turbo', deviceId: 'ac-1', on: true })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { mode: 'Seco' })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { fan: 'Média' })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { turbo: true })
    tuya.setLight.mockResolvedValueOnce({ on: false, online: false })
    await expect(home.command({ kind: 'light.power', deviceId: 'light-1', on: true })).rejects.toThrow('offline')
    await expect(home.command({ kind: 'light.power', deviceId: 'unknown', on: true })).rejects.toThrow('not found')
  })

  it('logs an LG control error code without losing the failed command', async () => {
    const { home, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    lg.setAc.mockRejectedValueOnce(new Error('LG API request failed (400): 2207: Invalid command'))
    await expect(home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })).rejects.toThrow('2207')
    expect(log).toHaveBeenCalledWith('LG AC control failed id=ac-1: LG API request failed (400): 2207: Invalid command')
    log.mockRestore()
  })

  it('keeps every unmatched AC in Sem cômodo and saves the chosen room mapping', async () => {
    const { home, lg, store } = harness()
    lg.listAcs.mockResolvedValueOnce([
      { id: 'ac-4', name: 'Bedroom AC', state: { on: false, targetTemperature: 23, online: true } },
      { id: 'ac-5', name: 'Guest AC', state: { on: false, targetTemperature: 23, online: true } }
    ])
    await home.beginLogin('test-code')
    const discovered = await home.discover()
    expect(discovered.find(room => room.name === 'Sem cômodo')?.acs.map(ac => ac.id)).toEqual(['ac-4', 'ac-5'])
    const office = discovered.find(room => room.name === 'Office')!
    await home.save({ 'ac-4': office.id })
    expect(store.save.mock.calls[0][0].acRoomIds).toEqual({ 'ac-4': office.id })
    expect((await home.rooms()).find(room => room.name === 'Office')?.acs.map(ac => ac.id)).toEqual(['ac-4'])
    expect((await home.rooms()).find(room => room.name === 'Sem cômodo')?.acs.map(ac => ac.id)).toEqual(['ac-5'])
    const reloaded = harness(store.save.mock.calls[0][0]).home
    expect((await reloaded.rooms()).find(room => room.name === 'Office')?.acs.map(ac => ac.id)).toEqual(['ac-4'])
  })

  it('splits switch gangs and persists the Quarto assignment without moving Office bulbs', async () => {
    const twoGang: SmartLifeHome[] = [{ id: 'home-1', name: 'Casa', devices: [
      { id: 'switch', name: 'Office wall switch', category: 'kg', localKey: 'fake-key', homeId: 'home-1', roomId: 'office', roomName: 'Office',
        channels: [{ dp: 1, name: 'Luz Office' }, { dp: 2, name: 'Cortineiro' }] },
      { id: 'bulb', name: 'Lâmpada Office', category: 'dj', localKey: 'fake-key', homeId: 'home-1', roomId: 'office', roomName: 'Office' },
      { id: 'bedroom', name: 'Luz Quarto', category: 'dj', localKey: 'fake-key', homeId: 'home-1', roomId: 'bedroom', roomName: 'Quarto' }
    ] }]
    const initial: SavedSetup = { homes: twoGang, acs: [], lightRoomIds: { 'switch::2': 'home-1:bedroom' } }
    const { home, tuya } = harness(initial)
    const rooms = await home.rooms()
    expect(rooms.find(room => room.name === 'Office')?.lights.map(light => light.name)).toEqual(['Luz Office', 'Lâmpada Office'])
    expect(rooms.find(room => room.name === 'Quarto')?.lights.map(light => light.name)).toEqual(['Cortineiro', 'Luz Quarto'])
    expect(rooms.find(room => room.name === 'Quarto')?.lights[0].switchOnly).toBe(true)
    await home.command({ kind: 'light.power', deviceId: 'switch::2', on: true })
    expect(tuya.setLight).toHaveBeenCalledWith('switch::2', { on: true })
  })

  it('saves a changed gang room in the encrypted setup payload', async () => {
    const { home, tuya, store } = harness()
    tuya.discover.mockResolvedValueOnce([{ id: 'home-1', name: 'Casa', devices: [
      { id: 'switch', name: 'Office', category: 'kg', localKey: 'fake-key', homeId: 'home-1', roomId: 'office', roomName: 'Office',
        channels: [{ dp: 1, name: 'Office' }, { dp: 2, name: 'Canal 2' }] },
      { id: 'bedroom', name: 'Luz Quarto', category: 'dj', localKey: 'fake-key', homeId: 'home-1', roomId: 'bedroom', roomName: 'Quarto' }
    ] }])
    await home.beginLogin('test-code')
    const found = await home.discover()
    expect(found.find(room => room.name === 'Quarto')?.lights[0].name).toBe('Cortineiro')
    await home.save({ 'switch::2': 'home-1:office' })
    expect(store.save.mock.calls[0][0].lightRoomIds).toEqual({ 'switch::2': 'home-1:office' })
    expect((await home.rooms()).find(room => room.name === 'Office')?.lights.map(light => light.id)).toEqual(['switch', 'switch::2'])
  })

  it('rejects malformed IPC commands before any device call', async () => {
    const { home, tuya, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
    const invalid = [
      { kind: 'light.power', deviceId: 'light-1', on: 'false' },
      { kind: 'light.brightness', deviceId: 'light-1', brightness: 101 },
      { kind: 'light.temperature', deviceId: 'light-1', temperature: -1 },
      { kind: 'light.color', deviceId: 'light-1', color: 'red' },
      { kind: 'ac.power', deviceId: 'ac-1', on: 1 },
      { kind: 'ac.temperature', deviceId: 'ac-1', temperature: 31 },
      { kind: 'ac.mode', deviceId: 'ac-1', mode: 'Heat' },
      { kind: 'ac.fan', deviceId: 'ac-1', fan: 'Turbo' },
      { kind: 'ac.turbo', deviceId: 'ac-1', on: 'true' },
      { kind: 'ac.temperature', deviceId: '', temperature: 22 },
      { kind: 'unknown', deviceId: 'light-1' }
    ]
    for (const command of invalid) await expect(home.command(command)).rejects.toThrow('Invalid device command')
    expect(tuya.setLight).not.toHaveBeenCalled()
    expect(lg.setAc).not.toHaveBeenCalled()
  })

  it('uses the optional User Code input or the main-process environment fallback for both QR and polling', async () => {
    vi.stubEnv('USER_CODE_SMARTLIFE', 'fallback-code')
    const { home, cloud } = harness()
    expect(home.status().smartLifeUserCodeConfigured).toBe(true)
    await home.beginLogin('')
    await home.discover()
    expect(cloud.startLogin).toHaveBeenCalledWith('fallback-code')
    expect(cloud.pollLogin).toHaveBeenCalledWith('fake-qr', 'fallback-code')
    await home.beginLogin('typed-code')
    await home.discover()
    expect(cloud.startLogin).toHaveBeenLastCalledWith('typed-code')
    expect(cloud.pollLogin).toHaveBeenLastCalledWith('fake-qr', 'typed-code')
    expect(JSON.stringify(home.status())).not.toContain('fallback-code')
  })

  it('saves LG and Smart Life credentials after discovery without returning them to the renderer', async () => {
    vi.stubEnv('LG_PAT', 'fake-lg-pat')
    vi.stubEnv('LG_COUNTRY', 'US')
    const { home, store } = harness()
    await home.beginLogin('fake-user-code')
    const discovered = await home.discover()
    await home.save()
    expect(store.save.mock.calls[0][0]).toMatchObject({ lgPat: 'fake-lg-pat', lgCountry: 'US',
      smartLifeUserCode: 'fake-user-code', smartLifeSession: session })
    for (const secret of ['fake-lg-pat', 'fake-user-code', session.accessToken, session.refreshToken]) {
      expect(JSON.stringify(discovered)).not.toContain(secret)
      expect(JSON.stringify(home.status())).not.toContain(secret)
    }
  })

  it('reconnects a missing or expired Smart Life session without changing saved assignments', async () => {
    const initial: SavedSetup = { homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }],
      acRoomIds: { 'ac-1': 'home-1:r2' }, lightRoomIds: { 'light-1': 'home-1:r2' },
      smartLifeUserCode: 'saved-code', smartLifeSession: { ...session, expiresAt: 0 } }
    const { home, store, cloud, tuya } = harness(initial)
    expect(home.status().smartLifeConnected).toBe(false)
    await home.beginLogin()
    await expect(home.reconnectSmartLife()).resolves.toBeUndefined()
    expect(cloud.pollLogin).toHaveBeenCalledWith('fake-qr', 'saved-code')
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      homes, acRoomIds: initial.acRoomIds, lightRoomIds: initial.lightRoomIds, smartLifeSession: session
    }))
    expect(tuya.restore).toHaveBeenLastCalledWith(homes, session)
    expect(home.status().smartLifeConnected).toBe(true)
    expect((await home.rooms()).find(room => room.name === 'Office')?.lights.map(light => light.id)).toContain('light-1')
  })

  it('persists a sharing token refreshed before expiry in the saved setup', async () => {
    const due = { ...session, accessToken: 'old-token', refreshToken: 'old-refresh', expiresAt: Date.now() + 4 * 60_000 }
    const { store, cloud, lg } = harness({ homes: [], acs: [], smartLifeSession: due })
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true,
      result: { accessToken: 'new-token', refreshToken: 'new-refresh', expireTime: 3600 } }) })
    const tuya = new TuyaService(new SmartLifeCloud(fetcher as unknown as typeof fetch), {} as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()))
    new HomeController(store as unknown as SetupStore, cloud as unknown as SmartLifeCloud, tuya, lg as unknown as LgClient)
    await vi.waitFor(() => expect(store.save).toHaveBeenCalledWith(expect.objectContaining({
      smartLifeSession: expect.objectContaining({ accessToken: 'new-token', refreshToken: 'new-refresh' })
    })))
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('starts with saved credentials without environment and reads old files with environment fallback', async () => {
    vi.stubEnv('LG_PAT', '')
    vi.stubEnv('LG_COUNTRY', '')
    vi.stubEnv('USER_CODE_SMARTLIFE', '')
    const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
      expect(url).toContain('/state')
      expect(options).toBeDefined()
      return { ok: true, json: async () => ({ response: {
        operation: { airConOperationMode: 'POWER_OFF' }, temperature: { targetTemperatureC: 23 }
      } }) }
    })
    vi.stubGlobal('fetch', fetcher)
    const setup: SavedSetup = { homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }],
      lgPat: 'saved-lg-pat', lgCountry: 'US', smartLifeUserCode: 'saved-user-code', smartLifeSession: session }
    const { store, cloud, tuya } = harness(setup)
    const home = new HomeController(store as unknown as SetupStore, cloud as unknown as SmartLifeCloud, tuya as unknown as TuyaService)
    expect(home.status()).toEqual({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true, smartLifeUserCodeConfigured: true, smartLifeConnected: true })
    await home.rooms()
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer saved-lg-pat', 'x-country': 'US' })
    await home.beginLogin()
    expect(cloud.startLogin).toHaveBeenCalledWith('saved-user-code')
    vi.stubEnv('LG_PAT', 'dev-lg-pat')
    vi.stubEnv('LG_COUNTRY', 'BR')
    vi.stubEnv('USER_CODE_SMARTLIFE', 'dev-user-code')
    const savedFirst = new HomeController(store as unknown as SetupStore, cloud as unknown as SmartLifeCloud,
      tuya as unknown as TuyaService)
    await savedFirst.rooms()
    expect(fetcher.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer saved-lg-pat', 'x-country': 'US' })
    await savedFirst.beginLogin()
    expect(cloud.startLogin).toHaveBeenLastCalledWith('saved-user-code')
    vi.stubEnv('LG_PAT', 'legacy-lg-pat')
    vi.stubEnv('USER_CODE_SMARTLIFE', 'legacy-user-code')
    const legacy = harness({ homes, acs: [] })
    const oldHome = new HomeController(legacy.store as unknown as SetupStore, legacy.cloud as unknown as SmartLifeCloud,
      legacy.tuya as unknown as TuyaService)
    expect(oldHome.status().lgTokenConfigured).toBe(true)
    await oldHome.beginLogin()
    expect(legacy.cloud.startLogin).toHaveBeenCalledWith('legacy-user-code')
  })
})
