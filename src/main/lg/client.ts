import { randomUUID } from 'node:crypto'
import type { AcState, AirConditioner } from '../../shared/types'

type Json = Record<string, unknown>
export type LgAcState = AcState & { powerSave?: boolean }
export type AcPatch = Partial<Pick<LgAcState, 'on' | 'targetTemperature' | 'mode' | 'fan' | 'turbo' | 'powerSave'>>

const modes: Record<string, string> = { Resfriar: 'COOL', Seco: 'AIR_DRY', Ventilar: 'FAN', Auto: 'AUTO' }
const fans: Record<string, string> = { Auto: 'AUTO', Baixa: 'LOW', Média: 'MID', Alta: 'HIGH' }
const modeNames: Record<string, string> = { COOL: 'Resfriar', AIR_DRY: 'Seco', FAN: 'Ventilar', AUTO: 'Auto', JET: 'Resfriar' }
const fanNames: Record<string, string> = { AUTO: 'Auto', NATURE: 'Auto', LOW: 'Baixa', MID: 'Média', HIGH: 'Alta' }

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

function fanKey(profile: Json): 'windStrengthDetail' | 'windStrength' {
  const airFlow = object(object(profile.property ?? profile).airFlow)
  return 'windStrengthDetail' in airFlow ? 'windStrengthDetail' : 'windStrength'
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
      signal: AbortSignal.timeout(4000)
    })
    const payload = object(await response.json().catch(() => ({})))
    if (!response.ok || payload.error) {
      const error = object(payload.error)
      const code = string(error.code)
      const message = string(error.message)
      const detail = [code, message].filter(Boolean).join(': ').replaceAll(this.token, '[redacted]').slice(0, 240)
      throw new Error(`LG API request failed (${response.status})${detail ? `: ${detail}` : ''}`)
    }
    if (!('response' in payload)) {
      if (body) return undefined
      throw new Error('LG API response missing')
    }
    return payload.response
  }

  async getAcProfile(id: string): Promise<Json> {
    return object(await this.request(`devices/${encodeURIComponent(id)}/profile`))
  }

  async getAcState(id: string): Promise<LgAcState> {
    const report = object(await this.request(`devices/${encodeURIComponent(id)}/state`))
    const celsius = Array.isArray(report.temperatureInUnits)
      ? report.temperatureInUnits.find(item => object(item).unit === 'C') : undefined
    const temp = celsius ? object(celsius) : object(report.temperature)
    const on = property(report, 'operation', 'airConOperationMode')
    const target = number(temp.targetTemperatureC ?? temp.targetTemperature)
    if (on !== 'POWER_ON' && on !== 'POWER_OFF') throw new Error('LG AC power state missing')
    if (target === undefined) throw new Error('LG AC target temperature missing')
    const mode = string(property(report, 'airConJobMode', 'currentJobMode'))
    const powerSave = property(report, 'powerSave', 'powerSaveEnabled')
    const profile = report.airFlow ? await this.getAcProfile(id).catch(() => null) : null
    const wind = profile ? string(property(report, 'airFlow', fanKey(profile))) : undefined
    return {
      on: on === 'POWER_ON',
      currentTemperature: number(temp.currentTemperatureC ?? temp.currentTemperature),
      targetTemperature: target,
      mode: mode ? modeNames[mode] ?? mode : undefined,
      fan: wind ? fanNames[wind] ?? wind : undefined,
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
      const state = await this.getAcState(id).catch((): AcState => ({ on: false, targetTemperature: 23, online: false }))
      return { id, name: string(info.alias) ?? string(info.modelName) ?? 'LG AC', state }
    }))
  }

  async setAc(id: string, patch: AcPatch): Promise<void> {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('LG AC patch value invalid')
    if (Object.keys(patch).length === 0) throw new Error('LG AC patch empty')
    for (const [key, value] of Object.entries(patch)) {
      const valid = key === 'targetTemperature' ? number(value) !== undefined
        : key === 'on' || key === 'turbo' || key === 'powerSave' ? typeof value === 'boolean'
          : key === 'mode' || key === 'fan' ? typeof value === 'string' : false
      if (!valid) throw new Error('LG AC patch value invalid')
    }
    const profile = await this.getAcProfile(id)
    const controls: Json[] = []
    const add = (group: string, key: string, value: string | number | boolean): void => {
      validateValue(capability(profile, group, key), value)
      controls.push({ [group]: { [key]: value } })
    }
    if (patch.on !== undefined) add('operation', 'airConOperationMode', patch.on ? 'POWER_ON' : 'POWER_OFF')
    if (patch.targetTemperature !== undefined) {
      const properties = object(profile.property ?? profile)
      const inUnits = properties.temperatureInUnits
      const celsius = Array.isArray(inUnits) ? inUnits.find(item => object(item).unit === 'C') : undefined
      if (celsius) {
        const entry = object(object(celsius).targetTemperature)
        if (!Array.isArray(entry.mode) || !entry.mode.includes('w')) throw new Error('LG AC control unavailable: temperature.targetTemperature')
        validateValue(entry, patch.targetTemperature)
      } else {
        const temperature = object(properties.temperature)
        const key = 'targetTemperatureC' in temperature ? 'targetTemperatureC' : 'targetTemperature'
        validateValue(capability(profile, 'temperature', key), patch.targetTemperature)
      }
      controls.push({ temperature: { targetTemperature: patch.targetTemperature, unit: 'C' } })
    }
    if (patch.mode !== undefined) {
      if (!modes[patch.mode]) throw new Error('LG AC mode invalid')
      add('airConJobMode', 'currentJobMode', modes[patch.mode])
    }
    if (patch.fan !== undefined) {
      if (!fans[patch.fan]) throw new Error('LG AC fan invalid')
      const key = fanKey(profile)
      const entry = capability(profile, 'airFlow', key)
      const supported = object(entry.value).w
      const value = patch.fan === 'Auto' && Array.isArray(supported) && !supported.includes('AUTO') && supported.includes('NATURE') ? 'NATURE' : fans[patch.fan]
      add('airFlow', key, value)
    }
    if (patch.turbo !== undefined) {
      if (patch.mode !== undefined) throw new Error('LG AC mode and turbo cannot be set together')
      add('airConJobMode', 'currentJobMode', patch.turbo ? 'JET' : 'COOL')
    }
    if (patch.powerSave !== undefined) add('powerSave', 'powerSaveEnabled', patch.powerSave)
    if (controls.length !== Object.keys(patch).length) throw new Error('LG AC patch has unsupported fields')
    for (const control of controls) await this.request(`devices/${encodeURIComponent(id)}/control`, control)
  }
}
