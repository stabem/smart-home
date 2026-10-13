import type { LightState } from '../../shared/types'
import { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
import { discoverLan } from './discovery'
import { TuyaLanClient, type Dps, type LanDevice, type TuyaVersion } from './protocol'

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
  constructor(
    private readonly cloud = new SmartLifeCloud(),
    private readonly lan = new TuyaLanClient(),
    private readonly scan = discoverLan
  ) {}

  async discover(session: SmartLifeSession): Promise<SmartLifeHome[]> {
    const [homes, addresses] = await Promise.all([this.cloud.listHomes(session), this.scan().catch(() => new Map())])
    this.devices.clear()
    for (const home of homes) for (const device of home.devices) {
      const lan = addresses.get(device.id)
      const version = lan?.version ?? device.version
      if (!device.localKey) continue
      device.ip = lan?.ip ?? device.ip
      device.version = version
      if (device.ip) {
        const entry = { id: device.id, ip: device.ip, localKey: device.localKey, version: versions.includes(version as TuyaVersion) ? version as TuyaVersion : '3.3' as const, category: device.category }
        this.devices.set(device.id, entry)
        await this.populateChannels(device, entry)
      }
    }
    return homes
  }

  async restore(homes: SmartLifeHome[]): Promise<void> {
    const addresses = await this.scan().catch(() => new Map())
    this.devices.clear()
    for (const home of homes) for (const device of home.devices) {
      const ip = addresses.get(device.id)?.ip ?? device.ip
      const version = addresses.get(device.id)?.version ?? device.version
      if (ip && device.localKey) {
        const entry = { id: device.id, ip, localKey: device.localKey, version: versions.includes(version as TuyaVersion) ? version as TuyaVersion : '3.3' as const, category: device.category }
        this.devices.set(device.id, entry)
        await this.populateChannels(device, entry)
      }
    }
  }

  async getState(id: string): Promise<LightState> {
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    if (!device) return { on: false, online: false }
    try { return this.toState(device.category, await this.requestWithFallback(device), selected.dp) }
    catch { return { on: false, online: false } }
  }

  async setLight(id: string, patch: LightPatch): Promise<LightState> {
    const selected = channel(id)
    const device = this.devices.get(selected.id)
    if (!device) return { on: false, online: false }
    const dps: Dps = {}
    const light = device.category === 'dj'
    if (!light && !['kg', 'cz'].includes(device.category)) throw new Error('Unsupported Tuya light category')
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
    try {
      await this.requestWithFallback(device, dps)
      return this.getState(id)
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
        console.warn(`Tuya LAN failed id=${device.id} ip=${device.ip} version=${version} error=${error instanceof Error ? error.name : 'UnknownError'}`)
      }
    }
    throw lastError
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
