import type { LightState } from '../../shared/types'
import { SmartLifeCloud, SmartLifeRateLimitError, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
import { discoverLan } from './discovery'
import { probeTcp } from './probe'
import { isLanIp, TuyaLanClient, type Dps, type LanDevice, type TuyaVersion } from './protocol'

export { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
export { TuyaLanClient, type LanDevice, type TuyaVersion } from './protocol'

export interface LightPatch { on?: boolean; brightness?: number; temperature?: number; color?: string }
const versions: TuyaVersion[] = ['3.3', '3.4', '3.5']
const legacy = { switch_led: 1, work_mode: 2, bright_value: 3, temp_value: 4, colour_data: 5 }
const modern = { switch_led: 20, work_mode: 21, bright_value_v2: 22, temp_value_v2: 23, colour_data_v2: 24 }
function lightMap(device: SmartLifeDevice, dps?: Dps): Record<string, number> {
  return { ...(dps?.['20'] !== undefined || device.dpMap?.switch_led === 20 ? modern : legacy), ...device.dpMap }
}
function point(map: Record<string, number>, ...codes: string[]): { code: string; dp: number } | undefined {
  const code = codes.find(value => Number.isInteger(map[value]) && map[value] > 0)
  return code ? { code, dp: map[code] } : undefined
}
function scale(value: number, code: string, encode: boolean): number {
  const [min, max] = code === 'bright_value_v2' ? [10, 1000] : code === 'bright_value' ? [25, 255]
    : code === 'temp_value_v2' ? [0, 1000] : [0, 255]
  return encode ? Math.round(min + Math.max(0, Math.min(100, value)) * (max - min) / 100)
    : Math.round((value - min) * 100 / (max - min))
}
export function confirms(state: LightState, patch: LightPatch): boolean {
  return state.online && !state.stale && !state.unconfirmed && Object.entries(patch).every(([key, value]) => {
    if (key === 'brightness' || key === 'temperature') {
      const actual = state[key]
      return typeof actual === 'number' && typeof value === 'number' && Math.abs(actual - value) <= 1
    }
    if (key === 'color' && typeof value === 'string') {
      const actual = state.color
      if (actual?.toLowerCase() === value.toLowerCase()) return true
      const canonical = decodeHsv(encodeHsv(value))
      if (!canonical || !actual || !/^#[0-9a-f]{6}$/i.test(actual)) return false
      return [1, 3, 5].every(i => Math.abs(parseInt(actual.slice(i, i + 2), 16) - parseInt(canonical.slice(i, i + 2), 16)) <= 1)
    }
    return state[key as keyof LightState] === value
  })
}
function channel(id: string): { id: string; dp: number } {
  const match = /^(.*)::(\d+)$/.exec(id)
  return match ? { id: match[1], dp: Number(match[2]) } : { id, dp: 1 }
}
export class TuyaService {
  private readonly devices = new Map<string, LanDevice & { category: string }>()
  private readonly lastStates = new Map<string, LightState>()
  private readonly observedMaps = new Map<string, Record<string, number>>()
  private readonly workingVersions = new Map<string, TuyaVersion>()
  private readonly lanFailures = new Map<string, { count: number; retryAt: number }>()
  private readonly lanTails = new Map<string, Promise<void>>()
  private readonly offlineIds = new Set<string>()
  private session: SmartLifeSession | null = null
  private homes: SmartLifeHome[] = []
  private addressSink: ((homes: SmartLifeHome[]) => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private refreshing = false
  constructor(
    private readonly cloud = new SmartLifeCloud(),
    private readonly lan = new TuyaLanClient(),
    private readonly scan = discoverLan,
    private readonly probe = probeTcp
  ) {}

  onAddressesChanged(sink: (homes: SmartLifeHome[]) => void): void {
    this.addressSink = sink
    this.cloud.onSessionChanged = () => sink(this.homes)
  }

  hasLan(id: string): boolean { return this.devices.has(channel(id).id) }

  async discover(session: SmartLifeSession): Promise<SmartLifeHome[]> {
    this.session = session
    this.homes = await this.cloud.listHomes(session)
    this.observedMaps.clear()
    this.offlineIds.clear()
    for (const home of this.homes) for (const device of home.devices) if (device.online === false) this.offlineIds.add(device.id)
    for (const home of this.homes) for (const device of home.devices) device.ip = undefined
    await this.resolveAddresses()
    this.startRefresh()
    const homes = this.homes
    return homes
  }

  async restore(homes: SmartLifeHome[], session?: SmartLifeSession | null): Promise<void> {
    this.session = session ?? null
    this.homes = homes
    this.observedMaps.clear()
    this.offlineIds.clear()
    for (const home of homes) for (const device of home.devices) if (device.online === false) this.offlineIds.add(device.id)
    this.cloud.registerHomes?.(homes)
    let scrubbed = false
    for (const home of homes) for (const device of home.devices) if (device.ip && !isLanIp(device.ip)) {
      device.ip = undefined
      scrubbed = true
    }
    await this.resolveAddresses()
    if (scrubbed) this.addressSink?.(homes)
    this.startRefresh()
  }

  private startRefresh(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => { void this.resolveAddresses().catch(() => {}) }, 5 * 60_000)
    this.timer.unref?.()
    const refreshSession = (): void => {
      if (this.session && Number.isFinite(this.session.expiresAt)) {
        void this.cloud.refreshIfNeeded(this.session).catch(error => this.logFailure('session', undefined, error))
      }
    }
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = setInterval(refreshSession, 60_000)
    this.refreshTimer.unref?.()
    refreshSession()
  }

  private logFailure(id: string, device: LanDevice | undefined, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    const secrets = [device?.localKey, this.session?.accessToken, this.session?.refreshToken,
      ...this.homes.flatMap(home => home.devices.map(item => item.localKey))].filter((value): value is string => !!value)
    const safe = secrets.reduce((value, secret) => value.replaceAll(secret, '[redacted]'), message).replace(/[\r\n]+/g, ' ')
    console.warn(`Tuya id=${id} ip=${device?.ip ?? 'unknown'} v=${device?.version ?? 'unknown'} err=${safe}`)
  }

  private offlineState(): LightState { return { on: false, online: false, reason: 'sem energia ou fora da rede' } }

  private isOfflineError(error: unknown): boolean {
    return error instanceof Error && /code=2001(?:\s|$)/.test(error.message)
  }

  private async cloudOnline(id: string): Promise<boolean | undefined> {
    if (!this.session || !this.cloud.deviceStatus) return this.offlineIds.has(id) || this.cloud.deviceOnline?.(id) === false ? false : undefined
    try {
      await this.cloud.deviceStatus(this.session, id)
      const online = this.cloud.deviceOnline?.(id)
      if (online === false) this.offlineIds.add(id)
      if (online === true) this.offlineIds.delete(id)
      const stored = this.homes.flatMap(home => home.devices).find(device => device.id === id)
      if (stored && typeof online === 'boolean') stored.online = online
      return online ?? (this.offlineIds.has(id) ? false : undefined)
    } catch (error) {
      if (this.isOfflineError(error)) { this.offlineIds.add(id); return false }
      if (this.cloud.deviceOnline?.(id) === false) this.offlineIds.add(id)
      return this.offlineIds.has(id) ? false : undefined
    }
  }

  private async lanRequest(device: LanDevice, dps?: Dps): Promise<Dps> {
    const previous = this.lanTails.get(device.id) ?? Promise.resolve()
    let release!: () => void
    const tail = new Promise<void>(resolve => { release = resolve })
    this.lanTails.set(device.id, tail)
    await previous
    try { return await this.lan.request(device, dps) }
    finally { release(); if (this.lanTails.get(device.id) === tail) this.lanTails.delete(device.id) }
  }

  private canTryLan(id: string): boolean { return Date.now() >= (this.lanFailures.get(id)?.retryAt ?? 0) && !this.offlineIds.has(id) }
  private failedLan(id: string): void {
    const count = (this.lanFailures.get(id)?.count ?? 0) + 1
    this.lanFailures.set(id, { count, retryAt: Date.now() + Math.min(300_000, 5_000 * 2 ** (count - 1)) })
  }
  private succeededLan(id: string, version: TuyaVersion): void {
    this.workingVersions.set(id, version)
    this.lanFailures.delete(id)
  }

  private async resolveAddresses(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
    for (const device of this.homes.flatMap(home => home.devices).filter(device => device.online === false)) await this.cloudOnline(device.id)
    const deadline = Date.now() + 8000
    const withinDeadline = async <T>(work: Promise<T>): Promise<T | undefined> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) return undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      try { return await Promise.race([work, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), remaining) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
    const addresses = await withinDeadline(this.scan().catch(() => new Map<string, { id: string; ip: string; version?: TuyaVersion }>()))
      ?? new Map<string, { id: string; ip: string; version?: TuyaVersion }>()
    const missing = this.homes.flatMap(home => home.devices).filter(device => device.localKey && device.online !== false && this.canTryLan(device.id) && !isLanIp(addresses.get(device.id)?.ip ?? '') && !isLanIp(device.ip ?? ''))
    if (missing.length) {
      const candidates = await withinDeadline(this.probe(undefined, undefined, undefined, deadline).catch(() => [])) ?? []
      for (const ip of candidates) {
        if (Date.now() >= deadline) break
        for (const device of [...missing]) {
          if (Date.now() >= deadline) break
          const known = versions.includes(device.version as TuyaVersion) ? device.version as TuyaVersion : '3.3'
          for (const version of this.workingVersions.has(device.id) ? [this.workingVersions.get(device.id)!] : [known, ...versions.filter(value => value !== known)]) {
            if (Date.now() >= deadline) break
            try {
              const dps = await withinDeadline(this.lanRequest({ id: device.id, ip, localKey: device.localKey, version }))
              if (!dps || !Object.values(dps).some(value => typeof value === 'boolean')) continue
              this.succeededLan(device.id, version)
              addresses.set(device.id, { id: device.id, ip, version })
              missing.splice(missing.indexOf(device), 1)
              break
            } catch { /* Another device or protocol version. */ }
          }
        }
        if (!missing.length) break
      }
    }
    let changed = false
    this.devices.clear()
    for (const home of this.homes) for (const device of home.devices) {
      const announced = addresses.get(device.id)
      const lan = announced && isLanIp(announced.ip) ? announced : undefined
      const ip = lan?.ip ?? (isLanIp(device.ip ?? '') ? device.ip : undefined)
      const version = this.workingVersions.get(device.id) ?? lan?.version ?? device.version
      if (device.ip !== ip || device.version !== version) changed = true
      device.ip = ip
      device.version = version
      console.info(`Tuya id=${device.id} LAN ${ip ?? 'not found on LAN'}`)
      if (ip && device.localKey) {
        const entry = { id: device.id, ip, localKey: device.localKey, version: versions.includes(version as TuyaVersion) ? version as TuyaVersion : '3.3' as const, category: device.category }
        this.devices.set(device.id, entry)
        if (device.online !== false && this.canTryLan(device.id) && Date.now() < deadline) await withinDeadline(this.populateChannels(device, entry))
      }
    }
    if (changed) this.addressSink?.(this.homes)
    } finally { this.refreshing = false }
  }

  async getState(id: string): Promise<LightState> {
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    const cloudDevice = this.homes.flatMap(home => home.devices).find(value => value.id === selected.id)
    if (device && await this.cloudOnline(selected.id) === false) return this.offlineState()
    if (device && this.canTryLan(selected.id)) {
      try {
        const dps = await this.requestWithFallback(device)
        const map = cloudDevice?.category === 'dj' ? lightMap(cloudDevice, dps) : undefined
        if (map) this.observedMaps.set(selected.id, map)
        const state = this.toState(device.category, dps, selected.dp, map)
        if (state.online) this.lastStates.set(id, state)
        return state
      }
      catch { /* Fall through to Smart Life. */ }
    }
    return this.cloudState(selected.id, selected.dp)
  }

  async setLight(id: string, patch: LightPatch): Promise<LightState> {
    patch = patch.on === false ? { on: false } : patch
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    const cloudDevice = this.homes.flatMap(home => home.devices).find(value => value.id === selected.id)
    if (!cloudDevice) return { on: false, online: false }
    if (await this.cloudOnline(selected.id) === false) return this.offlineState()
    const dps: Dps = {}
    const light = cloudDevice.category === 'dj'
    if (!light && !['kg', 'cz'].includes(cloudDevice.category)) throw new Error('Unsupported Tuya light category')
    let map = this.observedMaps.get(selected.id) ?? lightMap(cloudDevice)
    if (device && this.canTryLan(selected.id) && light && !cloudDevice.dpMap && !this.observedMaps.has(selected.id)) {
      try { map = lightMap(cloudDevice, await this.requestWithFallback(device)); this.observedMaps.set(selected.id, map) }
      catch { /* Use cloud control after the LAN attempt. */ }
    }
    if (patch.on !== undefined) dps[String(light ? (point(map, 'switch_led')?.dp ?? selected.dp) : selected.dp)] = patch.on
    if (patch.brightness !== undefined) {
      if (!light) throw new Error('Brightness unsupported by switch')
      const target = point(map, 'bright_value_v2', 'bright_value')
      if (!target) throw new Error('Brightness DP unavailable')
      dps[String(target.dp)] = scale(patch.brightness, target.code, true)
    }
    if (patch.temperature !== undefined) {
      if (!light) throw new Error('Temperature unsupported by switch')
      const target = point(map, 'temp_value_v2', 'temp_value')
      if (!target) throw new Error('Temperature DP unavailable')
      dps[String(target.dp)] = scale(patch.temperature, target.code, true)
    }
    if (patch.color !== undefined) {
      if (!light) throw new Error('Color unsupported by switch')
      const target = point(map, 'colour_data_v2', 'colour_data')
      if (!target) throw new Error('Color DP unavailable')
      dps[String(target.dp)] = encodeHsv(patch.color, target.code === 'colour_data')
      const mode = point(map, 'work_mode')
      if (mode) dps[String(mode.dp)] = 'colour'
    }
    if (!Object.keys(dps).length) return this.getState(id)
    if (device && this.canTryLan(selected.id)) {
      try {
        try { await this.lanRequest(device, dps); this.succeededLan(device.id, device.version) }
        catch (error) {
          // A reset invalidates the negotiated 3.5 session. A new request gets a new socket and handshake.
          if (device.version !== '3.5' || !(error instanceof Error) || !/ECONNRESET|socket hang up/i.test(error.message)) throw error
          await this.lanRequest(device, dps); this.succeededLan(device.id, device.version)
        }
        const state = await this.getState(id)
        if (confirms(state, patch)) return state
        throw new Error('LAN set was not confirmed by status')
      }
      catch (error) { this.failedLan(selected.id); this.logFailure(`${selected.id} step=lan-set`, device, error) }
    }
    if (!this.session) { this.logFailure(`${selected.id} step=cloud-set`, device, 'no-session'); return { on: false, online: false } }
    try {
      const commands = this.cloudCommands(cloudDevice, selected.dp, patch)
      try { await this.cloud.sendCommands(this.session, selected.id, commands) }
      catch (error) {
        if (commands.length < 2 || this.isOfflineError(error)) throw error
        this.logFailure(`${selected.id} step=cloud-bundle`, device, error)
        for (const command of commands) await this.cloud.sendCommands(this.session, selected.id, [command])
      }
      let state = await this.cloudState(selected.id, selected.dp)
      if (!confirms(state, patch)) {
        // Tuya's status often lags the accepted command by a moment; read once more, bypassing the cache, before judging.
        await new Promise(resolve => setTimeout(resolve, 800))
        this.cloud.invalidateStatus?.(selected.id)
        state = await this.cloudState(selected.id, selected.dp)
      }
      if (confirms(state, patch)) return state
      // Status could not be read at all: we do not know, so do not claim the change.
      if (!state.online) return { on: false, online: false }
      // Status reads fine but still lags the accepted command: report the requested state as unconfirmed, never as 'did not respond'.
      console.info(`Tuya id=${selected.id} step=cloud-confirm result=lag`)
      return { ...state, ...patch, online: true, viaCloud: true, unconfirmed: true }
    } catch (error) {
      this.logFailure(`${selected.id} step=cloud-set`, device, error)
      if (this.isOfflineError(error)) { this.offlineIds.add(selected.id); return this.offlineState() }
      if (error instanceof SmartLifeRateLimitError) throw error
      return { on: false, online: false }
    }
  }

  private async requestWithFallback(device: LanDevice, dps?: Dps): Promise<Dps> {
    if (!this.canTryLan(device.id)) throw new Error('Tuya LAN cooling down')
    const known = this.workingVersions.get(device.id)
    const order = known ? [known] : [device.version, ...versions.filter(version => version !== device.version)]
    let lastError: unknown
    for (const version of order) {
      if (!this.canTryLan(device.id)) throw new Error('Tuya LAN cooling down')
      try {
        const result = await this.lanRequest({ ...device, version }, dps)
        device.version = version
        this.succeededLan(device.id, version)
        return result
      } catch (error) {
        lastError = error
        this.logFailure(device.id, { ...device, version }, error)
      }
    }
    this.failedLan(device.id)
    throw lastError
  }

  private cloudCommands(device: SmartLifeDevice, dp: number, patch: LightPatch): Array<{ code: string; value: unknown }> {
    const supported = new Set(device.cloudCodes ?? [])
    const choose = (...codes: string[]): string => {
      const found = codes.find(code => supported.has(code))
      if (found) return found
      if (supported.size) throw new Error(`Smart Life function unavailable: ${codes.join('/')}`)
      return codes[0]
    }
    const commands: Array<{ code: string; value: unknown }> = []
    if (patch.on !== undefined) commands.push({ code: device.category === 'dj' ? choose('switch_led', 'switch_1') : choose(`switch_${dp}`, 'switch'), value: patch.on })
    if (patch.brightness !== undefined) {
      const code = choose('bright_value_v2', 'bright_value')
      commands.push({ code, value: scale(patch.brightness, code, true) })
    }
    if (patch.temperature !== undefined) {
      const code = choose('temp_value_v2', 'temp_value')
      commands.push({ code, value: scale(patch.temperature, code, true) })
    }
    if (patch.color !== undefined) {
      const code = choose('colour_data_v2', 'colour_data')
      const hex = encodeHsv(patch.color)
      const factor = code === 'colour_data_v2' ? 1 : 255 / 1000
      if (!supported.size || supported.has('work_mode')) commands.push({ code: 'work_mode', value: 'colour' })
      commands.push({ code, value: JSON.stringify({
        h: parseInt(hex.slice(0, 4), 16), s: Math.round(parseInt(hex.slice(4, 8), 16) * factor),
        v: Math.round(parseInt(hex.slice(8, 12), 16) * factor) }) })
    }
    return commands
  }

  private async cloudState(id: string, dp: number): Promise<LightState> {
    if (!this.session) { this.logFailure(id, this.devices.get(id), 'no-session'); return { on: false, online: false } }
    const device = this.homes.flatMap(home => home.devices).find(value => value.id === id)
    if (!device) return { on: false, online: false }
    try {
      const status = await this.cloud.deviceStatus(this.session, id)
      const online = this.cloud.deviceOnline?.(id)
      if (online === false) this.offlineIds.add(id)
      if (online === true) this.offlineIds.delete(id)
      if (online === false || this.offlineIds.has(id)) return this.offlineState()
      const on = device.category === 'dj' ? status.switch_led ?? status.switch_1 : status[`switch_${dp}`] ?? status.switch
      if (typeof on !== 'boolean') return { on: false, online: false }
      const state: LightState = { on, online: true, viaCloud: true }
      const brightness = status.bright_value_v2 ?? status.bright_value
      const temperature = status.temp_value_v2 ?? status.temp_value
      if (typeof brightness === 'number') state.brightness = scale(brightness, status.bright_value_v2 !== undefined ? 'bright_value_v2' : 'bright_value', false)
      if (typeof temperature === 'number') state.temperature = scale(temperature, status.temp_value_v2 !== undefined ? 'temp_value_v2' : 'temp_value', false)
      let colour = status.colour_data_v2 ?? status.colour_data
      if (typeof colour === 'string') {
        try { colour = JSON.parse(colour) as unknown } catch { /* Invalid device color is ignored. */ }
      }
      if (colour && typeof colour === 'object' && !Array.isArray(colour)) {
        const hsv = colour as Record<string, unknown>
        if (['h', 's', 'v'].every(key => typeof hsv[key] === 'number')) {
          const factor = status.colour_data_v2 !== undefined ? 1 : 1000 / 255
          state.color = decodeHsv([Number(hsv.h), Number(hsv.s) * factor, Number(hsv.v) * factor]
            .map(value => Math.round(value).toString(16).padStart(4, '0')).join(''))
        }
      }
      this.lastStates.set(dp === 1 ? id : `${id}::${dp}`, state)
      return state
    } catch (error) {
      this.logFailure(`${id} step=cloud-read`, this.devices.get(id), error)
      if (this.isOfflineError(error)) { this.offlineIds.add(id); return this.offlineState() }
      if (this.offlineIds.has(id) || this.cloud.deviceOnline?.(id) === false) return this.offlineState()
      if (error instanceof SmartLifeRateLimitError || this.cloud.isRateLimited?.()) {
        const cached = this.lastStates.get(dp === 1 ? id : `${id}::${dp}`)
        return { ...(cached ?? { on: false, online: false }), stale: true }
      }
      return { on: false, online: false }
    }
  }

  private async populateChannels(device: SmartLifeDevice, entry: LanDevice): Promise<void> {
    if (device.category === 'dj') return
    try {
      const dps = await this.requestWithFallback(entry)
      const discovered: number[] = []
      for (let dp = 1; typeof dps[String(dp)] === 'boolean'; dp++) discovered.push(dp)
      const names = new Map(device.channels?.map(item => [item.dp, item.name]) ?? [])
      for (const dp of discovered) if (!names.has(dp)) names.set(dp, `${device.name} ${dp}`)
      if (names.size) device.channels = [...names].map(([dp, name]) => ({ dp, name })).sort((a, b) => a.dp - b.dp)
    } catch { /* The device stays visible and getState will report offline after retries. */ }
  }

  private toState(category: string, dps: Dps, dp = 1, map?: Record<string, number>): LightState {
    const on = dps[String(category === 'dj' ? (point(map ?? legacy, 'switch_led')?.dp ?? dp) : dp)]
    if (typeof on !== 'boolean') return { on: false, online: false }
    const state: LightState = { on, online: true }
    if (category === 'dj') {
      const brightness = point(map ?? legacy, 'bright_value_v2', 'bright_value')
      const temperature = point(map ?? legacy, 'temp_value_v2', 'temp_value')
      const color = point(map ?? legacy, 'colour_data_v2', 'colour_data')
      if (brightness && typeof dps[String(brightness.dp)] === 'number') state.brightness = scale(dps[String(brightness.dp)] as number, brightness.code, false)
      if (temperature && typeof dps[String(temperature.dp)] === 'number') state.temperature = scale(dps[String(temperature.dp)] as number, temperature.code, false)
      if (color && typeof dps[String(color.dp)] === 'string') state.color = decodeHsv(dps[String(color.dp)] as string)
    }
    return state
  }
}

function encodeHsv(color: string, legacyColor = false): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color)
  if (!match) throw new Error('Color must be #RRGGBB')
  const rgb = [0, 2, 4].map(i => parseInt(match[1].slice(i, i + 2), 16) / 255)
  const max = Math.max(...rgb), min = Math.min(...rgb), delta = max - min
  let hue = 0
  if (delta) {
    const index = rgb.indexOf(max)
    hue = index === 0 ? ((rgb[1] - rgb[2]) / delta) % 6
      : index === 1 ? (rgb[2] - rgb[0]) / delta + 2 : (rgb[0] - rgb[1]) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  const sat = max ? delta / max : 0
  const hsv = [hue, sat * (legacyColor ? 255 : 1000), max * (legacyColor ? 255 : 1000)]
    .map((n, i) => Math.round(n).toString(16).padStart(legacyColor && i > 0 ? 2 : 4, '0')).join('')
  return legacyColor ? match[1].toLowerCase() + hsv : hsv
}
function decodeHsv(value: string): string | undefined {
  if (/^[0-9a-f]{14}$/i.test(value)) return '#' + value.slice(0, 6).toLowerCase()
  if (!/^[0-9a-f]{12}$/i.test(value)) return undefined
  const h = parseInt(value.slice(0, 4), 16) / 60
  const s = parseInt(value.slice(4, 8), 16) / 1000
  const v = parseInt(value.slice(8, 12), 16) / 1000
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('')
}
