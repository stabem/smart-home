import { randomUUID } from 'node:crypto'
import type { AcState, AirConditioner } from '../../shared/types'

type Json = Record<string, unknown>
export type LgAcState = AcState & { powerSave?: boolean }
export type AcPatch = Partial<Pick<LgAcState, 'on' | 'targetTemperature' | 'mode' | 'fan' | 'turbo' | 'powerSave'>>

const API_KEY = 'v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3' // LG's published ThinQ Connect client key
const ASIA = new Set(['AU', 'BD', 'CN', 'HK', 'ID', 'IN', 'JP', 'KH', 'KR', 'LA', 'LK', 'MM', 'MY', 'NP', 'NZ', 'PH', 'SG', 'TH', 'TW', 'VN'])
const AMERICAS = new Set(['AG', 'AR', 'AW', 'BB', 'BO', 'BR', 'BS', 'BZ', 'CA', 'CL', 'CO', 'CR', 'CU', 'DM', 'DO', 'EC', 'GD', 'GT', 'GY', 'HN', 'HT', 'JM', 'KN', 'LC', 'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SR', 'SV', 'TT', 'US', 'UY', 'VC', 'VE'])

function object(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}
}

function property(value: unknown, group: string, key: string): unknown {
  return object(object(value)[group])[key]
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function region(country: string): string {
  if (ASIA.has(country)) return 'kic'
  if (AMERICAS.has(country)) return 'aic'
  if (/^[A-Z]{2}$/.test(country)) return 'eic'
  throw new Error('Invalid LG_COUNTRY')
}

function messageId(): string {
  return Buffer.from(randomUUID().replace(/-/g, ''), 'hex').toString('base64url')
}

function capability(profile: Json, group: string, key: string): Json {
  const entry = object(property(object(profile.property ?? profile), group, key))
  if (!entry.mode || !Array.isArray(entry.mode) || !entry.mode.includes('w')) {
    throw new Error(`LG AC control unavailable: ${group}.${key}`)
  }
  return entry
}

function validateValue(entry: Json, value: string | number | boolean): void {
  const writable = object(entry.value).w
  if (Array.isArray(writable) && !writable.includes(value)) throw new Error('LG AC value unsupported by profile')
  if (typeof value === 'number' && writable && !Array.isArray(writable)) {
    const range = object(writable)
    const min = number(range.min)
    const max = number(range.max)
    const step = number(range.step)
    if ((min !== undefined && value < min) || (max !== undefined && value > max) ||
      (step !== undefined && min !== undefined && Math.abs((value - min) / step - Math.round((value - min) / step)) > 1e-8)) {
      throw new Error('LG AC value unsupported by profile')
    }
  }
}

export class LgClient {
  private readonly baseUrl: string
  private readonly clientId = `smart-home-tray-${randomUUID()}`

  constructor(
    private readonly token: string = process.env.LG_PAT ?? '',
    private readonly country: string = process.env.LG_COUNTRY ?? 'BR',
    private readonly fetcher: typeof fetch = fetch
  ) {
    if (!token) throw new Error('LG_PAT is required')
    this.baseUrl = `https://api-${region(country)}.lgthinq.com`
  }

  private async request(path: string, body?: Json): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${this.token}`,
        'x-country': this.country,
        'x-message-id': messageId(),
        'x-client-id': this.clientId,
        'x-api-key': API_KEY,
        'x-service-phase': 'OP',
        ...(body ? { 'content-type': 'application/json', 'x-conditional-control': 'true' } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000)
    })
    // Never include the response body or request headers in errors: they may contain account data.
    if (!response.ok) throw new Error(`LG API request failed (${response.status})`)
    const payload = object(await response.json())
    if (payload.error) throw new Error('LG API request failed')
    if (!('response' in payload)) throw new Error('LG API response missing')
    return payload.response
  }

  async getAcProfile(id: string): Promise<Json> {
    return object(await this.request(`devices/${encodeURIComponent(id)}/profile`))
  }

  async getAcState(id: string): Promise<LgAcState> {
    const report = object(await this.request(`devices/${encodeURIComponent(id)}/state`))
    const temp = object(report.temperature)
    const on = property(report, 'operation', 'airConOperationMode')
    const target = number(temp.targetTemperatureC ?? temp.targetTemperature)
    if (on !== 'POWER_ON' && on !== 'POWER_OFF') throw new Error('LG AC power state missing')
    if (target === undefined) throw new Error('LG AC target temperature missing')
    const mode = string(property(report, 'airConJobMode', 'currentJobMode'))
    const powerSave = property(report, 'powerSave', 'powerSaveEnabled')
    return {
      on: on === 'POWER_ON',
      currentTemperature: number(temp.currentTemperatureC ?? temp.currentTemperature),
      targetTemperature: target,
      mode,
      fan: string(property(report, 'airFlow', 'windStrength')),
      turbo: mode === undefined ? undefined : mode === 'JET',
      powerSave: typeof powerSave === 'boolean' ? powerSave : undefined,
      online: true,
      updatedAt: new Date().toISOString()
    }
  }

  async listAcs(): Promise<AirConditioner[]> {
    const devices = await this.request('devices')
    if (!Array.isArray(devices)) throw new Error('LG device list invalid')
    const acs = devices.filter((item) => object(object(item).deviceInfo).deviceType === 'DEVICE_AIR_CONDITIONER')
    return Promise.all(acs.map(async (item) => {
      const device = object(item)
      const id = string(device.deviceId)
      if (!id) throw new Error('LG AC id missing')
      const info = object(device.deviceInfo)
      return { id, name: string(info.alias) ?? string(info.modelName) ?? 'LG AC', state: await this.getAcState(id) }
    }))
  }

  async setAc(id: string, patch: AcPatch): Promise<void> {
    if (Object.keys(patch).length === 0) throw new Error('LG AC patch empty')
    const profile = await this.getAcProfile(id)
    const controls: Json[] = []
    const add = (group: string, key: string, value: string | number | boolean): void => {
      validateValue(capability(profile, group, key), value)
      controls.push({ [group]: { [key]: value } })
    }
    if (patch.on !== undefined) add('operation', 'airConOperationMode', patch.on ? 'POWER_ON' : 'POWER_OFF')
    if (patch.targetTemperature !== undefined) {
      const temperature = object(object(profile.property ?? profile).temperature)
      const key = 'targetTemperatureC' in temperature ? 'targetTemperatureC' : 'targetTemperature'
      add('temperature', key, patch.targetTemperature)
    }
    if (patch.mode !== undefined) add('airConJobMode', 'currentJobMode', patch.mode)
    if (patch.fan !== undefined) add('airFlow', 'windStrength', patch.fan)
    if (patch.turbo !== undefined) {
      if (patch.mode !== undefined) throw new Error('LG AC mode and turbo cannot be set together')
      if (!patch.turbo) throw new Error('LG AC turbo off requires a mode')
      add('airConJobMode', 'currentJobMode', 'JET')
    }
    if (patch.powerSave !== undefined) add('powerSave', 'powerSaveEnabled', patch.powerSave)
    if (controls.length !== Object.keys(patch).length) throw new Error('LG AC patch has unsupported fields')
    for (const control of controls) await this.request(`devices/${encodeURIComponent(id)}/control`, control)
  }
}
