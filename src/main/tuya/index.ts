import type { LightState } from '../../shared/types'
import { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
import { discoverLan } from './discovery'
import { probeTcp } from './probe'
import { isLanIp, TuyaLanClient, type Dps, type LanDevice, type TuyaVersion } from './protocol'

export { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
export { TuyaLanClient, type LanDevice, type TuyaVersion } from './protocol'

export interface LightPatch { on?: boolean; brightness?: number; temperature?: number; color?: string }
const versions: TuyaVersion[] = ['3.3', '3.4', '3.5']
function channel(id: string): { id: string; dp: number } {
  const match = /^(.*)::(\d+)$/.exec(id)
  return match ? { id: match[1], dp: Number(match[2]) } : { id, dp: 1 }
}
export class TuyaService {
  private readonly devices = new Map<string, LanDevice & { category: string }>()
  private session: SmartLifeSession | null = null
  private homes: SmartLifeHome[] = []
  private addressSink: ((homes: SmartLifeHome[]) => void) | null = null
  private timer: ReturnType<typeof setInterval> | null = null
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

  async discover(session: SmartLifeSession): Promise<SmartLifeHome[]> {
    this.session = session
    this.homes = await this.cloud.listHomes(session)
    for (const home of this.homes) for (const device of home.devices) device.ip = undefined
    await this.resolveAddresses()
    this.startRefresh()
    const homes = this.homes
    return homes
  }

  async restore(homes: SmartLifeHome[], session?: SmartLifeSession | null): Promise<void> {
    this.session = session ?? null
    this.homes = homes
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
  }

  private async resolveAddresses(): Promise<void> {
    if (this.refreshing) return
    this.refreshing = true
    try {
    const addresses = await this.scan().catch(() => new Map<string, { id: string; ip: string; version?: TuyaVersion }>())
    const missing = this.homes.flatMap(home => home.devices).filter(device => device.localKey && !isLanIp(addresses.get(device.id)?.ip ?? '') && !isLanIp(device.ip ?? ''))
    if (missing.length) {
      const candidates = await this.probe().catch(() => [])
      for (const ip of candidates) {
        for (const device of [...missing]) {
          const known = versions.includes(device.version as TuyaVersion) ? device.version as TuyaVersion : '3.3'
          for (const version of [known, ...versions.filter(value => value !== known)]) {
            try {
              const dps = await this.lan.request({ id: device.id, ip, localKey: device.localKey, version })
              if (!Object.values(dps).some(value => typeof value === 'boolean')) continue
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
      const version = lan?.version ?? device.version
      if (device.ip !== ip || device.version !== version) changed = true
      device.ip = ip
      device.version = version
      console.info(`Tuya id=${device.id} LAN ${ip ?? 'not found on LAN'}`)
      if (ip && device.localKey) {
        const entry = { id: device.id, ip, localKey: device.localKey, version: versions.includes(version as TuyaVersion) ? version as TuyaVersion : '3.3' as const, category: device.category }
        this.devices.set(device.id, entry)
        await this.populateChannels(device, entry)
      }
    }
    if (changed) this.addressSink?.(this.homes)
    } finally { this.refreshing = false }
  }

  async getState(id: string): Promise<LightState> {
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    if (device) {
      try { return this.toState(device.category, await this.requestWithFallback(device), selected.dp) }
      catch { /* Fall through to Smart Life. */ }
    }
    return this.cloudState(selected.id, selected.dp)
  }

  async setLight(id: string, patch: LightPatch): Promise<LightState> {
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    const cloudDevice = this.homes.flatMap(home => home.devices).find(value => value.id === selected.id)
    if (!cloudDevice) return { on: false, online: false }
    const dps: Dps = {}
    const light = cloudDevice.category === 'dj'
    if (!light && !['kg', 'cz'].includes(cloudDevice.category)) throw new Error('Unsupported Tuya light category')
    if (patch.on !== undefined) dps[String(selected.dp)] = patch.on
    if (patch.brightness !== undefined) {
      if (!light) throw new Error('Brightness unsupported by switch')
      dps['3'] = Math.round(Math.max(0, Math.min(100, patch.brightness)) * 10)
    }
    if (patch.temperature !== undefined) {
      if (!light) throw new Error('Temperature unsupported by switch')
      dps['4'] = Math.round(Math.max(0, Math.min(100, patch.temperature)) * 10)
    }
    if (patch.color !== undefined) {
      if (!light) throw new Error('Color unsupported by switch')
      dps['5'] = encodeHsv(patch.color)
      dps['2'] = 'colour'
    }
    if (!Object.keys(dps).length) return this.getState(id)
    if (device) {
      try { await this.requestWithFallback(device, dps); return this.getState(id) }
      catch { /* Fall through to Smart Life. */ }
    }
    if (!this.session) return { on: false, online: false }
    try {
      const commands = this.cloudCommands(cloudDevice, selected.dp, patch)
      await this.cloud.sendCommands(this.session, selected.id, commands)
      const state = await this.cloudState(selected.id, selected.dp)
      return state.online ? state : { on: patch.on ?? false, online: true, viaCloud: true }
    } catch { return { on: false, online: false } }
  }

  private async requestWithFallback(device: LanDevice, dps?: Dps): Promise<Dps> {
    const order = [device.version, ...versions.filter(version => version !== device.version)]
    let lastError: unknown
    for (const version of order) {
      try {
        const result = await this.lan.request({ ...device, version }, dps)
        device.version = version
        return result
      } catch (error) {
        lastError = error
      }
    }
    const cached = this.homes.flatMap(home => home.devices).find(value => value.id === device.id)
    if (cached?.ip === device.ip) {
      cached.ip = undefined
      this.devices.delete(device.id)
      this.addressSink?.(this.homes)
      void this.resolveAddresses().catch(() => {})
    }
    throw lastError
  }

  private cloudCommands(device: SmartLifeDevice, dp: number, patch: LightPatch): Array<{ code: string; value: unknown }> {
    const supported = new Set(device.cloudCodes ?? [])
    const choose = (...codes: string[]): string => codes.find(code => supported.has(code)) ?? codes[0]
    const commands: Array<{ code: string; value: unknown }> = []
    if (patch.on !== undefined) commands.push({ code: device.category === 'dj' ? choose('switch_led', 'switch_1') : choose(`switch_${dp}`, 'switch'), value: patch.on })
    if (patch.brightness !== undefined) commands.push({ code: choose('bright_value_v2', 'bright_value'), value: Math.round(patch.brightness * 10) })
    if (patch.temperature !== undefined) commands.push({ code: choose('temp_value_v2', 'temp_value'), value: Math.round(patch.temperature * 10) })
    if (patch.color !== undefined) throw new Error('Cloud color control unsupported')
    return commands
  }

  private async cloudState(id: string, dp: number): Promise<LightState> {
    if (!this.session) return { on: false, online: false }
    const device = this.homes.flatMap(home => home.devices).find(value => value.id === id)
    if (!device) return { on: false, online: false }
    try {
      const status = await this.cloud.deviceStatus(this.session, id)
      const on = device.category === 'dj' ? status.switch_led ?? status.switch_1 : status[`switch_${dp}`] ?? status.switch
      if (typeof on !== 'boolean') return { on: false, online: false }
      const state: LightState = { on, online: true, viaCloud: true }
      const brightness = status.bright_value_v2 ?? status.bright_value
      const temperature = status.temp_value_v2 ?? status.temp_value
      if (typeof brightness === 'number') state.brightness = Math.round(brightness / 10)
      if (typeof temperature === 'number') state.temperature = Math.round(temperature / 10)
      return state
    } catch { return { on: false, online: false } }
  }

  private async populateChannels(device: SmartLifeDevice, entry: LanDevice): Promise<void> {
    if (device.category === 'dj') return
    try {
      const dps = await this.requestWithFallback(entry)
      const discovered: number[] = []
      for (let dp = 1; typeof dps[String(dp)] === 'boolean'; dp++) discovered.push(dp)
      const names = new Map(device.channels?.map(item => [item.dp, item.name]) ?? [])
      for (const dp of discovered) if (!names.has(dp)) names.set(dp, dp === 1 ? device.name : `Canal ${dp}`)
      if (names.size) device.channels = [...names].map(([dp, name]) => ({ dp, name })).sort((a, b) => a.dp - b.dp)
    } catch { /* The device stays visible and getState will report offline after retries. */ }
  }

  private toState(category: string, dps: Dps, dp = 1): LightState {
    const on = dps[String(dp)]
    if (typeof on !== 'boolean') return { on: false, online: false }
    const state: LightState = { on, online: true }
    if (category === 'dj') {
      if (typeof dps['3'] === 'number') state.brightness = Math.round(dps['3'] / 10)
      if (typeof dps['4'] === 'number') state.temperature = Math.round(dps['4'] / 10)
      if (typeof dps['5'] === 'string') state.color = decodeHsv(dps['5'])
    }
    return state
  }
}

function encodeHsv(color: string): string {
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
  return [hue, sat * 1000, max * 1000].map((n, i) => Math.round(n).toString(16).padStart(i === 0 ? 4 : 4, '0')).join('')
}
function decodeHsv(value: string): string | undefined {
  if (!/^[0-9a-f]{12}$/i.test(value)) return undefined
  const h = parseInt(value.slice(0, 4), 16) / 60
  const s = parseInt(value.slice(4, 8), 16) / 1000
  const v = parseInt(value.slice(8, 12), 16) / 1000
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
    : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return '#' + [r, g, b].map(n => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('')
}
