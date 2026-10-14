import { afterEach, describe, expect, it, vi } from 'vitest'
import { HomeController } from './home'
import type { SavedSetup, SetupStore } from './store'
import { SmartLifeCloud, TuyaService, type SmartLifeHome, type SmartLifeSession } from './tuya'
import type { TuyaLanClient } from './tuya'
import type { LgClient } from './lg/client'

const inventory = vi.hoisted(() => ({ writes: [] as Array<[string, string]> }))
vi.mock('electron', () => ({ app: { getPath: () => 'C:/userData' }, safeStorage: { isEncryptionAvailable: () => false } }))
vi.mock('node:fs/promises', () => ({ writeFile: async (path: string, data: string) => { inventory.writes.push([path, data]) } }))

const homes: SmartLifeHome[] = [{ id: 'home-1', name: 'Casa', devices: [
  { id: 'light-1', name: 'Luz', category: 'dj', localKey: 'fake-key', homeId: 'home-1', roomId: 'r1', roomName: 'Sala de estar', version: '3.4', ip: '192.0.2.2' },
  { id: 'light-2', name: 'Luz office', category: 'kg', localKey: 'fake-key-2', homeId: 'home-1', roomId: 'r2', roomName: 'Office', version: '3.3', ip: '192.0.2.3' }
] }]
const session = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: 9999999999999, uid: 'fake', terminalId: 'fake' } as SmartLifeSession

function harness(initial: SavedSetup | null = null) {
  let saved = initial
  const store = { load: vi.fn(() => saved), save: vi.fn((value: SavedSetup) => { saved = value }) }
  const cloud = { startLogin: vi.fn(async () => ({ token: 'fake-qr', qrUri: 'tuyaSmart--qrLogin?token=fake-qr' })), pollLogin: vi.fn(async () => session) }
  const tuya = { discover: vi.fn(async () => homes), restore: vi.fn(async () => {}), getState: vi.fn(async (id: string) => ({ on: id === '', online: true })), setLight: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ on: !!id, online: true, ...patch })) }
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
  const trackHomes: SmartLifeHome[] = [{ id: 'home', name: 'Casa', devices: [1, 2, 3, 4].map(number => ({
    id: `bulb-${number}`, name: `Office_${number}`, category: 'dj', localKey: 'fixture-key', homeId: 'home',
    roomId: 'office', roomName: 'Office', version: '3.4', ip: `192.0.2.${number}`
  })) }]

  it('suggests one Office track and fans commands to all four members', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [] })
    const rooms = await home.rooms()
    expect(rooms[0].lights).toHaveLength(1)
    expect(rooms[0].lights[0]).toMatchObject({ name: 'Trilho do Office', memberIds: ['bulb-1', 'bulb-2', 'bulb-3', 'bulb-4'] })
    await home.command({ kind: 'light.brightness', deviceId: rooms[0].lights[0].id, brightness: 62 })
    expect(tuya.setLight).toHaveBeenCalledTimes(4)
    expect(tuya.setLight).toHaveBeenCalledWith('bulb-4', { brightness: 62 })
  })
  it('sends track members one at a time and retries one failed member once', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [] })
    Object.assign(tuya, { hasLan: (lightId: string) => lightId === 'bulb-3' })
    const id = home.groupSetup().groups[0].id
    const calls: string[] = []
    let active = 0
    let peak = 0
    tuya.setLight.mockImplementation(async (lightId: string) => {
      calls.push(lightId)
      active++
      peak = Math.max(peak, active)
      await Promise.resolve()
      active--
      if (lightId === 'bulb-2' && calls.filter(value => value === lightId).length === 1) throw new Error('timeout')
      return { on: true, online: true }
    })
    await home.command({ kind: 'light.power', deviceId: id, on: true })
    expect(calls).toEqual(['bulb-3', 'bulb-1', 'bulb-2', 'bulb-2', 'bulb-4'])
    expect(peak).toBe(1)
  })
  it('writes a secret-free inventory next to the encrypted setup', async () => {
    const { home } = harness({ homes: trackHomes, acs: [{ id: 'ac-1', name: 'Ar Office' }], acRoomIds: { 'ac-1': 'office' }, lgPat: 'secret-pat', smartLifeSession: session } as SavedSetup)
    await home.rooms()
    await new Promise(resolve => setTimeout(resolve, 0))
    const [path, text] = inventory.writes.at(-1) ?? ['', '']
    expect(path).toMatch(/inventario\.md$/)
    expect(text).toContain('Trilho do Office')
    expect(text).toMatch(/membro bulb-1 smartlife="Office_1" sala-smartlife="Office" (ligada|desligada) via (wifi|nuvem|offline)/)
    expect(text).toMatch(/\[ar\] id=ac-1 online via nuvem/)
    expect(text).not.toMatch(/fixture-key|secret-pat|fake/)
  })
  it('accepts quantized group read-backs without resending or reporting failure', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [] })
    const id = home.groupSetup().groups[0].id
    tuya.setLight.mockImplementation(async (_lightId: string, patch: Record<string, unknown>) => ({
      on: true, online: true, ...('brightness' in patch ? { brightness: 50 } : {}), ...('color' in patch ? { color: '#00025a' } : {})
    }))
    await home.command({ kind: 'light.brightness', deviceId: id, brightness: 51 })
    await home.command({ kind: 'light.color', deviceId: id, color: '#00015a' })
    expect(tuya.setLight).toHaveBeenCalledTimes(8)
  })

  it('names failed track members and reapplies the last desired state after drift', async () => {
    const { home, tuya, store } = harness({ homes: trackHomes, acs: [] })
    const id = (await home.rooms())[0].lights[0].id
    tuya.setLight.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await expect(home.command({ kind: 'light.power', deviceId: id, on: true })).rejects.toThrow('Office_1')
    expect(store.save).toHaveBeenCalled()
    tuya.getState.mockImplementation(async (lightId: string) => ({ on: lightId !== 'bulb-1', online: true }))
    tuya.setLight.mockClear()
    await home.rooms()
    expect(tuya.setLight).toHaveBeenCalledWith('bulb-1', { on: true })
    expect(tuya.setLight).toHaveBeenCalledTimes(1)
    home.setSyncGuard(false)
    tuya.setLight.mockClear()
    await home.rooms()
    expect(tuya.setLight).not.toHaveBeenCalled()
  })
  it('does not turn healthy group members off after one member has an unconfirmed off read', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [] })
    const id = home.groupSetup().groups[0].id
    await home.command({ kind: 'light.power', deviceId: id, on: true })
    tuya.getState.mockImplementation(async (lightId: string) => lightId === 'bulb-1'
      ? { on: false, online: false } : { on: true, online: true })
    tuya.setLight.mockClear()
    await home.rooms()
    expect(tuya.setLight).not.toHaveBeenCalled()
    tuya.getState.mockImplementation(async (lightId: string) => lightId === 'bulb-1'
      ? { on: false, online: true, stale: true } : { on: true, online: true })
    await home.rooms()
    expect(tuya.setLight).not.toHaveBeenCalled()
  })
  it('shows an offline track as without power and never syncs its 2001 member', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [], groupLastState: { 'group:office:Office': { on: true } } })
    tuya.getState.mockImplementation(async (id: string) => id === 'bulb-1'
      ? { on: false, online: false, reason: 'sem energia ou fora da rede' } : { on: true, online: true })
    const track = (await home.rooms())[0].lights[0]
    expect(track.state).toMatchObject({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(tuya.setLight).not.toHaveBeenCalledWith('bulb-1', expect.anything())
    tuya.setLight.mockImplementation(async (id: string) => id === 'bulb-1'
      ? { on: false, online: false, reason: 'sem energia ou fora da rede' } : { on: true, online: true })
    await expect(home.command({ kind: 'light.power', deviceId: track.id, on: true })).rejects.toThrow('Sem energia: Office_1')
    expect(tuya.setLight.mock.calls.filter(([id]) => id === 'bulb-1')).toHaveLength(1)
  })
  it('does not accept an unconfirmed off reply as a successful group on command', async () => {
    const { home, tuya } = harness({ homes: trackHomes, acs: [] })
    const id = home.groupSetup().groups[0].id
    tuya.setLight.mockImplementation(async (lightId: string) => lightId === 'bulb-1'
      ? { on: false, online: true } : { on: true, online: true })
    await expect(home.command({ kind: 'light.power', deviceId: id, on: true })).rejects.toThrow('Office_1')
    expect(tuya.setLight.mock.calls.filter(([lightId]) => lightId === 'bulb-1')).toHaveLength(2)
    expect(tuya.setLight).toHaveBeenCalledWith('bulb-4', { on: true })
  })

  it('persists edited track membership and rejects cross-room members', async () => {
    const { home, store } = harness({ homes: trackHomes, acs: [] })
    const { rooms, groups } = home.groupSetup()
    expect(groups[0].name).toBe('Trilho do Office')
    home.saveLightGroups([{ ...groups[0], name: 'Trilho principal', memberIds: ['bulb-1', 'bulb-2'] }])
    expect((await home.rooms())[0].lights.map(light => light.name)).toEqual(['Trilho principal', 'Office_3', 'Office_4'])
    expect(store.save).toHaveBeenCalled()
    expect(() => home.saveLightGroups([{ ...groups[0], memberIds: ['bulb-1', 'outside'] }])).toThrow('Invalid light group member')
    expect(rooms[0].lights).toHaveLength(4)
  })
  it('saves light names and room assignments without losing encrypted setup fields', async () => {
    const editedHomes = structuredClone(trackHomes)
    editedHomes[0].devices.push({ id: 'bedroom', name: 'Luz Quarto', category: 'dj', localKey: 'fixture-key', homeId: 'home', roomId: 'bedroom', roomName: 'Quarto' })
    const initial: SavedSetup = { homes: editedHomes, acs: [{ id: 'ac-1', name: 'Ar Office' }],
      smartLifeSession: session, smartLifeUserCode: 'code', syncGuard: false, groupLastState: { old: { on: true } } }
    const { home, store } = harness(initial)
    const before = home.groupSetup()
    const mapping = Object.fromEntries(before.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => [device.id, room.id])))
    mapping['bulb-1'] = before.rooms.find(room => room.name === 'Quarto')!.id
    home.saveHomeEdits(mapping, { 'bulb-1': 'Luz da mesa' }, [{ ...before.groups[0], name: 'Trilho principal', memberIds: ['bulb-2', 'bulb-3', 'bulb-4'] }])
    expect(home.groupSetup().rooms.find(room => room.name === 'Quarto')?.lights.some(light => light.name === 'Luz da mesa')).toBe(true)
    expect(home.groupSetup().groups[0].name).toBe('Trilho principal')
    expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ smartLifeSession: session, smartLifeUserCode: 'code', syncGuard: false }))
    expect(() => home.saveHomeEdits(mapping, { 'bulb-1': '' }, [])).toThrow('Invalid light name')
  })
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
    expect(home.status()).toEqual({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true, smartLifeUserCodeConfigured: true, smartLifeConnected: true, syncGuard: true })
  })

  it('routes known device commands and rejects an offline light', async () => {
    const initial = { homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] }
    const { home, tuya, lg } = harness(initial)
    await home.command({ kind: 'light.power', deviceId: 'light-1', on: true })
    expect(tuya.setLight).toHaveBeenCalledWith('light-1', { on: true })
    await expect(home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 22 })).resolves.toMatchObject({ ok: true, state: { on: false, online: true } })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { targetTemperature: 22 }, undefined)
    expect(lg.getAcState).toHaveBeenCalledWith('ac-1', undefined)
    await home.command({ kind: 'ac.mode', deviceId: 'ac-1', mode: 'Seco' })
    await home.command({ kind: 'ac.fan', deviceId: 'ac-1', fan: 'Média' })
    await home.command({ kind: 'ac.turbo', deviceId: 'ac-1', on: true })
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { mode: 'Seco' }, undefined)
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { fan: 'Média' }, undefined)
    expect(lg.setAc).toHaveBeenCalledWith('ac-1', { turbo: true }, undefined)
    tuya.setLight.mockResolvedValueOnce({ on: false, online: false })
    await expect(home.command({ kind: 'light.power', deviceId: 'light-1', on: true })).rejects.toThrow('offline')
    await expect(home.command({ kind: 'light.power', deviceId: 'unknown', on: true })).rejects.toThrow('not found')
  })

  it('logs an LG control error code without losing the failed command', async () => {
    const { home, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
    const log = vi.spyOn(console, 'info').mockImplementation(() => {})
    const secret = 'SENTINEL-LG-SECRET'
    lg.setAc.mockRejectedValueOnce(new Error(`LG API request failed (400): 2207: ${secret}`))
    await expect(home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })).resolves.toMatchObject({ ok: false, state: { on: false } })
    expect(log).toHaveBeenCalledWith('LG control result=failed kind=ac.power code=2207')
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret)
    log.mockRestore()
  })
  it('ends POWER_ON confirmation at one deadline when a state read never settles', async () => {
    vi.useFakeTimers()
    try {
      const { home, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
      lg.getAcState.mockImplementation(() => new Promise(() => {}))
      const pending = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(5999)
      let settled = false
      void pending.then(() => { settled = true })
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toMatchObject({ ok: true, state: { on: true } })
      expect(lg.getAcState).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers(); vi.restoreAllMocks() }
  })
  it('turns LG 2304 (POWER OFF) into a plain instruction, keeps optimistic ON and confirms in the background', async () => {
    vi.useFakeTimers()
    try {
      const { home, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
      vi.spyOn(console, 'error').mockImplementation(() => {})
      vi.spyOn(console, 'info').mockImplementation(() => {})
      lg.setAc.mockRejectedValueOnce(new Error('LG API request failed (400): 2304: Command not supported in POWER OFF'))
      await expect(home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 20 })).resolves.toMatchObject({ ok: false, error: 'O ar está desligado. Ligue primeiro.', state: { on: false } })
      lg.setAc.mockResolvedValueOnce(undefined)
      lg.getAcState.mockResolvedValueOnce({ on: false, targetTemperature: 23, online: true }).mockResolvedValueOnce({ on: true, targetTemperature: 23, online: true })
      const pending = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(4100)
      await expect(pending).resolves.toMatchObject({ ok: true, state: { on: true } })
      expect(lg.getAcState).toHaveBeenCalledTimes(2)
      expect(lg.getAcState).toHaveBeenCalledWith('ac-1', expect.any(AbortSignal))
      lg.setAc.mockResolvedValueOnce(undefined)
      lg.getAcState.mockResolvedValue({ on: false, targetTemperature: 23, online: true })
      const slow = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(6100)
      // Not confirmed within the IPC window: stays optimistic ON and keeps confirming in the background.
      await expect(slow).resolves.toMatchObject({ ok: true, state: { on: true } })
      // An immediate refresh while LG still lags (reads OFF) must keep the optimistic ON.
      expect((await home.rooms()).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(true)
      // Slow reads (4 s each) stretch the loop to ~56 s; the optimistic ON must hold until the loop itself ends.
      lg.getAcState.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ on: false, targetTemperature: 23, online: true }), 4000)))
      await vi.advanceTimersByTimeAsync(40000)
      const midway = home.rooms()
      await vi.advanceTimersByTimeAsync(4000)
      expect((await midway).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(true)
      await vi.advanceTimersByTimeAsync(30000)
      lg.getAcState.mockResolvedValue({ on: false, targetTemperature: 23, online: true })
      // A final read that FAILS must not reuse an older OFF: no off marker, state stays whatever the next read says.
      lg.setAc.mockResolvedValueOnce(undefined)
      let reads = 0
      lg.getAcState.mockImplementation(async () => { reads++; if (reads === 1) return { on: false, targetTemperature: 23, online: true }; throw new Error('LG API request failed (500)') })
      const flaky = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(6100)
      await flaky
      await vi.advanceTimersByTimeAsync(30000)
      lg.getAcState.mockResolvedValue({ on: true, targetTemperature: 23, online: true })
      expect((await home.rooms()).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(true)
      await vi.advanceTimersByTimeAsync(25000)
      const rooms = await home.rooms()
      expect(rooms.flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(false)
      // An authoritative ON read (turned on elsewhere) clears the off marker once the stale window has passed.
      lg.getAcState.mockResolvedValue({ on: true, targetTemperature: 23, online: true })
      await vi.advanceTimersByTimeAsync(16000)
      expect((await home.rooms()).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(true)
      // A superseded background loop must not mark the AC off after a newer press confirmed ON.
      lg.setAc.mockResolvedValue(undefined)
      lg.getAcState.mockResolvedValue({ on: false, targetTemperature: 23, online: true })
      const first = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(6100)
      await first
      lg.getAcState.mockResolvedValue({ on: true, targetTemperature: 23, online: true })
      const second = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(2100)
      await second
      await vi.advanceTimersByTimeAsync(30000)
      expect((await home.rooms()).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(true)
      // A newer command that gets 2304 OFF must also cancel an older slow POWER_ON loop, even if that loop later reads a stale ON.
      lg.setAc.mockResolvedValueOnce(undefined)
      lg.getAcState.mockResolvedValue({ on: false, targetTemperature: 23, online: true })
      const slowOn = home.command({ kind: 'ac.power', deviceId: 'ac-1', on: true })
      await vi.advanceTimersByTimeAsync(6100)
      await slowOn
      lg.setAc.mockRejectedValueOnce(new Error('LG API request failed (400): 2304: Command not supported in POWER OFF'))
      await expect(home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 21 })).resolves.toMatchObject({ ok: false, state: { on: false } })
      lg.getAcState.mockResolvedValue({ on: true, targetTemperature: 23, online: true })
      await vi.advanceTimersByTimeAsync(4000)
      expect((await home.rooms()).flatMap(room => room.acs).find(item => item.id === 'ac-1')?.state.on).toBe(false)
    } finally { vi.useRealTimers(); vi.restoreAllMocks() }
  })

  it('returns 2304 OFF before a delayed state read and keeps a stale ON read off', async () => {
    const { home, lg } = harness({ homes, acs: [{ id: 'ac-1', name: 'Ar Sala de estar' }] })
    lg.setAc.mockRejectedValueOnce(new Error('LG API request failed (400): 2304: Command not supported in POWER OFF'))
    let finishRead!: (state: { on: boolean; targetTemperature: number; online: boolean }) => void
    lg.getAcState.mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    const result = await home.command({ kind: 'ac.temperature', deviceId: 'ac-1', temperature: 20 })
    expect(result).toMatchObject({ ok: false, state: { on: false } })
    expect(lg.getAcState).not.toHaveBeenCalled()
    const rooms = home.rooms()
    await vi.waitFor(() => expect(lg.getAcState).toHaveBeenCalledOnce())
    finishRead({ on: true, targetTemperature: 23, online: true })
    expect((await rooms).flatMap(room => room.acs).find(ac => ac.id === 'ac-1')?.state.on).toBe(false)
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
    expect(found.find(room => room.name === 'Quarto')?.lights[0].name).toBe('Cortineiro do Quarto')
    await home.save({ 'switch::2': 'home-1:office' })
    expect(store.save.mock.calls[0][0].lightRoomIds).toEqual({ 'switch::2': 'home-1:office' })
    expect((await home.rooms()).find(room => room.name === 'Office')?.lights.map(light => light.id)).toEqual(['switch', 'switch::2'])
  })

  it('applies and persists house defaults from anonymized discovery without naming pending switches', async () => {
    const discovered: SmartLifeHome[] = [{ id: 'house', name: 'Casa', devices: [
      { id: 'living', name: 'Sala de Estar', category: 'kg', localKey: 'fixture-key', homeId: 'house',
        channels: [1, 2, 3, 4].map(dp => ({ dp, name: `Canal ${dp}` })) },
      { id: 'office-switch', name: 'Office', category: 'kg', localKey: 'fixture-key', homeId: 'house',
        roomId: 'office', roomName: 'Office', channels: [1, 2].map(dp => ({ dp, name: `Canal ${dp}` })) },
      { id: 'laundry', name: 'Luz', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'laundry', roomName: 'Lavandeira' },
      { id: 'bath', name: 'Luz', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'bath', roomName: 'banheiro suíte' },
      { id: 'kitchen', name: 'Cozinha', category: 'kg', localKey: 'fixture-key', homeId: 'house', roomId: 'kitchen', roomName: 'Cozinha',
        channels: [1, 2, 3].map(dp => ({ dp, name: `Canal ${dp}` })) },
      { id: 'kitchen-loose', name: 'Luz Cozinha', category: 'dj', localKey: 'fixture-key', homeId: 'house' },
      { id: 'hall', name: 'Corredor', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'kitchen', roomName: 'Cozinha' }
    ] }]
    const { home, tuya, lg, store } = harness()
    tuya.discover.mockResolvedValueOnce(discovered)
    lg.listAcs.mockResolvedValueOnce([{ id: 'living-ac', name: 'Ar Condicionado da Sala', state: { on: false, targetTemperature: 23, online: true } }])
    await home.beginLogin('test-code')
    const rooms = await home.discover()
    const inRoom = (name: string) => rooms.find(room => room.name === name)!
    expect(inRoom('Sala de estar').lights.map(light => light.name)).toEqual(['LED teto', 'Lustre', 'Cortineiro da sala'])
    expect(inRoom('Sala de estar').acs.map(ac => ac.id)).toEqual(['living-ac'])
    expect(inRoom('Mesa de jantar').lights.map(light => light.name)).toEqual(['LED sala de jantar', 'Lustre da sala de jantar'])
    expect(inRoom('Office').lights.map(light => light.name)).toEqual(['Cortineiro do Office'])
    expect(inRoom('Quarto').lights.map(light => light.name)).toEqual(['Cortineiro do Quarto'])
    expect(inRoom('Lavanderia').lights.map(light => light.id)).toEqual(['laundry'])
    expect(inRoom('Banheiro suíte').lights.map(light => light.id)).toEqual(['bath'])
    expect(inRoom('Entrada').lights.map(light => light.name)).toEqual(['Luz da entrada', 'Corredor'])
    expect(inRoom('Cozinha').lights.map(light => light.name)).toEqual(['Cozinha', 'Luz Cozinha'])
    await home.save()
    const saved = store.save.mock.lastCall![0]
    expect(saved.lightNames).toMatchObject({ living: 'LED teto', 'living::2': 'LED sala de jantar', 'living::3': 'Lustre',
      'living::4': 'Cortineiro da sala', 'office-switch': 'Cortineiro do Office', 'office-switch::2': 'Cortineiro do Quarto',
      kitchen: 'Luz da entrada', 'kitchen::2': 'Cozinha', 'kitchen::3': 'Lustre da sala de jantar' })
    expect(saved.lightRoomIds?.['living::2']).toBe('house:Mesa de jantar')
    expect(saved.lightRoomIds?.['office-switch::2']).toBe('house:Quarto')
    expect(saved.lightRoomIds).toMatchObject({ kitchen: 'house:Entrada', 'kitchen::2': 'house:kitchen',
      'kitchen::3': 'house:Mesa de jantar', hall: 'house:Entrada' })
    expect(saved.lightNames?.hall).toBeUndefined()
    expect(saved.lightRoomIds?.['kitchen-loose']).toBe('house:kitchen')
  })

  it('migrates Cozinha and Corredor defaults while keeping edited names and rooms', () => {
    const saved: SavedSetup = { homes: [{ id: 'house', name: 'Casa', devices: [
      { id: 'switch', name: 'Office', category: 'kg', localKey: 'fixture-key', homeId: 'house', roomId: 'office', roomName: 'Office',
        channels: [1, 2].map(dp => ({ dp, name: `Canal ${dp}` })) },
      { id: 'kitchen', name: 'Cozinha', category: 'kg', localKey: 'fixture-key', homeId: 'house', roomId: 'kitchen', roomName: 'Cozinha',
        channels: [1, 2, 3].map(dp => ({ dp, name: `Canal ${dp}` })) },
      { id: 'hall', name: 'Corredor', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'kitchen', roomName: 'Cozinha' },
      { id: 'hall-edited', name: 'Corredor', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'kitchen', roomName: 'Cozinha' },
      { id: 'other', name: 'Quarto', category: 'dj', localKey: 'fixture-key', homeId: 'house', roomId: 'bed', roomName: 'Quarto' }
    ] }], acs: [], lightNames: { switch: 'Meu cortineiro', 'switch::2': '', 'kitchen::2': '', 'hall-edited': 'Corredor favorito' },
    lightRoomIds: { switch: 'house:bed', 'switch::2': '', 'kitchen::2': '', 'hall-edited': 'house:bed' } }
    const { home, store } = harness(saved)
    expect(store.save).toHaveBeenCalledOnce()
    const migrated = store.save.mock.lastCall![0]
    expect(migrated.lightNames).toMatchObject({ switch: 'Meu cortineiro', 'switch::2': 'Cortineiro do Quarto',
      kitchen: 'Luz da entrada', 'kitchen::2': 'Cozinha', 'kitchen::3': 'Lustre da sala de jantar', 'hall-edited': 'Corredor favorito' })
    expect(migrated.lightNames?.hall).toBeUndefined()
    expect(migrated.lightRoomIds).toMatchObject({ switch: 'house:bed', 'switch::2': 'house:bed',
      kitchen: 'house:Entrada', 'kitchen::2': 'house:kitchen', 'kitchen::3': 'house:Mesa de jantar',
      hall: 'house:Entrada', 'hall-edited': 'house:bed' })
    expect(home.groupSetup().rooms.find(room => room.name === 'Entrada')?.lights.map(light => light.name)).toEqual(['Luz da entrada', 'Corredor'])
    expect(home.groupSetup().rooms.find(room => room.name === 'Quarto')?.lights.map(light => light.name)).toEqual(['Meu cortineiro', 'Cortineiro do Quarto', 'Corredor favorito', 'Quarto'])
    harness(migrated)
    expect(store.save).toHaveBeenCalledOnce()
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
    expect(home.status()).toEqual({ configured: true, lgTokenConfigured: true, tuyaKeysConfigured: true, smartLifeUserCodeConfigured: true, smartLifeConnected: true, syncGuard: true })
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
