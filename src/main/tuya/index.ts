import type { LightState } from '../../shared/types'
import { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession } from './cloud'
import { discoverLan } from './discovery'
import { TuyaLanClient, type Dps, type LanDevice, type TuyaVersion } from './protocol'

export { SmartLifeCloud, type SmartLifeHome, type SmartLifeSession, type SmartLifeDevice } from './cloud'
export { TuyaLanClient, type LanDevice, type TuyaVersion } from './protocol'

export interface LightPatch { on?: boolean; brightness?: number; temperature?: number; color?: string }
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
      if (!device.localKey || !['3.3', '3.4', '3.5'].includes(version ?? '')) continue
      device.ip = lan?.ip ?? device.ip
      device.version = version
      if (device.ip) this.devices.set(device.id, { id: device.id, ip: device.ip, localKey: device.localKey, version: version as TuyaVersion, category: device.category })
    }
    return homes
  }

  async restore(homes: SmartLifeHome[]): Promise<void> {
    const addresses = await this.scan().catch(() => new Map())
    this.devices.clear()
    for (const home of homes) for (const device of home.devices) {
      const ip = addresses.get(device.id)?.ip ?? device.ip
      const version = addresses.get(device.id)?.version ?? device.version
      if (ip && device.localKey && ['3.3', '3.4', '3.5'].includes(version ?? '')) {
        this.devices.set(device.id, { id: device.id, ip, localKey: device.localKey, version: version as TuyaVersion, category: device.category })
      }
    }
  }

  async getState(id: string): Promise<LightState> {
    const device = this.devices.get(id)
    if (!device) return { on: false, online: false }
    try { return this.toState(device.category, await this.lan.request(device)) }
    catch { return { on: false, online: false } }
  }

  async setLight(id: string, patch: LightPatch): Promise<LightState> {
    const device = this.devices.get(id)
    if (!device) return { on: false, online: false }
    const dps: Dps = {}
    const light = device.category === 'dj'
    if (!light && !['kg', 'cz'].includes(device.category)) throw new Error('Unsupported Tuya light category')
    if (patch.on !== undefined) dps['1'] = patch.on
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
      await this.lan.request(device, dps)
      return this.getState(id)
    } catch { return { on: false, online: false } }
  }

  private toState(category: string, dps: Dps): LightState {
    const on = dps['1']
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
