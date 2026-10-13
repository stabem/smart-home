import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto'

const LOGIN_URL = 'https://apigw.iotbing.com'
const CLIENT_ID = 'HA_3y9q4ak7g4ephrvke'
const SCHEMA = 'haauthorize'

export interface SmartLifeSession {
  endpoint: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  uid: string
  terminalId: string
}
export interface SmartLifeDevice {
  id: string
  name: string
  category: string
  localKey: string
  homeId: string
  roomId?: string
  roomName?: string
  ip?: string
  version?: string
  channels?: Array<{ dp: number; name: string }>
  cloudCodes?: string[]
}
export interface SmartLifeHome { id: string; name: string; devices: SmartLifeDevice[] }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Smart Life response')
  return value as Record<string, unknown>
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Invalid Smart Life response')
  return value
}
function secretFor(rid: string, refreshToken: string): { hashKey: string; secret: Buffer } {
  const hashKey = createHash('md5').update(rid + refreshToken).digest('hex')
  const secret = createHmac('sha256', rid).update(hashKey).digest('hex').slice(0, 16)
  return { hashKey, secret: Buffer.from(secret) }
}
function encrypt(value: object, secret: Buffer): string {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-128-gcm', secret, nonce)
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()])
  return Buffer.from(nonce.toString('base64') + ciphertext.toString('base64')).toString('utf8')
}
function decrypt(value: string, secret: Buffer): unknown {
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length < 29) throw new Error('Invalid Smart Life encrypted response')
  const cipher = createDecipheriv('aes-128-gcm', secret, bytes.subarray(0, 12))
  cipher.setAuthTag(bytes.subarray(-16))
  const plain = Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8')
  try { return JSON.parse(plain) as unknown } catch { return plain }
}

export class SmartLifeCloud {
  private refreshInFlight: Promise<void> | null = null
  onSessionChanged?: () => void
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  private async publicRequest(path: string, method: 'GET' | 'POST'): Promise<Record<string, unknown>> {
    const response = await this.fetcher(LOGIN_URL + path, { method, signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('Smart Life login request failed')
    return record(await response.json())
  }

  async startLogin(userCode = process.env.USER_CODE_SMARTLIFE): Promise<{ token: string; qrUri: string }> {
    if (!userCode) throw new Error('Smart Life user code required')
    const params = new URLSearchParams({ clientid: CLIENT_ID, usercode: userCode, schema: SCHEMA })
    const result = await this.publicRequest(`/v1.0/m/life/home-assistant/qrcode/tokens?${params}`, 'POST')
    if (result.success !== true) throw new Error('Smart Life QR request failed')
    const token = string(record(result.result).qrcode)
    return { token, qrUri: `tuyaSmart--qrLogin?token=${encodeURIComponent(token)}` }
  }

  async pollLogin(token: string, userCode = process.env.USER_CODE_SMARTLIFE): Promise<SmartLifeSession | null> {
    if (!userCode) throw new Error('Smart Life user code required')
    const params = new URLSearchParams({ clientid: CLIENT_ID, usercode: userCode })
    const result = await this.publicRequest(`/v1.0/m/life/home-assistant/qrcode/tokens/${encodeURIComponent(token)}?${params}`, 'GET')
    if (result.success !== true) return null
    const info = record(result.result)
    const endpoint = string(info.endpoint)
    if (!endpoint.startsWith('https://')) throw new Error('Invalid Smart Life endpoint')
    return {
      endpoint, accessToken: string(info.access_token), refreshToken: string(info.refresh_token),
      expiresAt: Number(result.t) + Number(info.expire_time) * 1000,
      uid: string(info.uid), terminalId: string(info.terminal_id)
    }
  }

  private async request(session: SmartLifeSession, path: string, params?: Record<string, string>, body?: object, refreshing = false): Promise<unknown> {
    if (!refreshing) await this.refreshIfNeeded(session)
    const rid = randomUUID()
    const { hashKey, secret } = secretFor(rid, session.refreshToken)
    const encdata = params ? encrypt(params, secret) : ''
    const bodyData = body ? encrypt(body, secret) : ''
    const headers: Record<string, string> = {
      'X-appKey': CLIENT_ID, 'X-requestId': rid, 'X-sid': '', 'X-time': String(Date.now()), 'X-token': session.accessToken
    }
    if (body) headers['Content-Type'] = 'application/json'
    const signed = ['X-appKey', 'X-requestId', 'X-sid', 'X-time', 'X-token']
      .filter(name => headers[name]).map(name => `${name}=${headers[name]}`).join('||') + encdata + bodyData
    headers['X-sign'] = createHmac('sha256', hashKey).update(signed).digest('hex')
    const url = new URL(path, session.endpoint)
    if (encdata) url.searchParams.set('encdata', encdata)
    const response = await this.fetcher(url, { method: body ? 'POST' : 'GET', headers,
      body: body ? JSON.stringify({ encdata: bodyData }) : undefined, signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('Smart Life device request failed')
    const responseBody = record(await response.json())
    if (responseBody.success !== true) throw new Error(`Smart Life device request rejected code=${String(responseBody.code ?? '?')} msg=${String(responseBody.msg ?? '').slice(0, 80)}`)
    return typeof responseBody.result === 'string' && responseBody.result ? decrypt(responseBody.result, secret) : responseBody.result
  }

  async refreshIfNeeded(session: SmartLifeSession): Promise<void> {
    if (Date.now() < session.expiresAt - 5 * 60_000) return
    if (!this.refreshInFlight) this.refreshInFlight = this.refreshSession(session).finally(() => { this.refreshInFlight = null })
    await this.refreshInFlight
  }

  private async refreshSession(session: SmartLifeSession): Promise<void> {
    const result = record(await this.request(session, `/v1.0/m/token/${encodeURIComponent(session.refreshToken)}`, undefined, undefined, true))
    const accessToken = string(result.accessToken)
    const refreshToken = string(result.refreshToken)
    const expiresAt = Date.now() + Number(result.expireTime) * 1000
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('Invalid Smart Life token expiry')
    Object.assign(session, { accessToken, refreshToken, expiresAt })
    this.onSessionChanged?.()
  }

  async deviceStatus(session: SmartLifeSession, id: string): Promise<Record<string, unknown>> {
    const devices = await this.request(session, '/v1.0/m/life/ha/devices/detail', { devIds: id })
    if (!Array.isArray(devices) || devices.length !== 1) throw new Error('Invalid Smart Life device status')
    const status = record(devices[0]).status
    if (!Array.isArray(status)) throw new Error('Invalid Smart Life device status')
    return Object.fromEntries(status.map(value => {
      const item = record(value)
      return [string(item.code), item.value]
    }))
  }

  async sendCommands(session: SmartLifeSession, id: string, commands: Array<{ code: string; value: unknown }>): Promise<void> {
    await this.request(session, `/v1.1/m/thing/${encodeURIComponent(id)}/commands`, undefined, { commands })
  }

  async listHomes(session: SmartLifeSession): Promise<SmartLifeHome[]> {
    const homes = await this.request(session, '/v1.0/m/life/users/homes')
    if (!Array.isArray(homes)) throw new Error('Invalid Smart Life homes')
    return Promise.all(homes.map(async item => {
      const home = record(item)
      const id = String(home.ownerId)
      const devices = await this.request(session, '/v1.0/m/life/ha/home/devices', { homeId: id })
      if (!Array.isArray(devices)) throw new Error('Invalid Smart Life devices')
      const mapped = await Promise.all(devices.map(async value => {
        const device = record(value)
        const result: SmartLifeDevice = {
          id: string(device.id), name: string(device.name), category: string(device.category),
          localKey: string(device.local_key), homeId: id,
          ip: typeof device.ip === 'string' ? device.ip : undefined,
          version: typeof device.version === 'string' ? device.version : undefined
        }
        const entries = [device.status, device.functions].flatMap(value => Array.isArray(value) ? value :
          value && typeof value === 'object' ? Object.entries(value).map(([code, detail]) => ({ code, ...(detail && typeof detail === 'object' ? detail : {}) })) : [])
        result.cloudCodes = [...new Set(entries.filter(value => value && typeof value === 'object')
          .map(value => String((value as Record<string, unknown>).code ?? '')).filter(Boolean))]
        const channels = new Map<number, string>()
        for (const value of entries) {
          if (!value || typeof value !== 'object') continue
          const item = value as Record<string, unknown>
          const match = /^switch_(\d+)$/.exec(String(item.code ?? ''))
          if (match) {
            const dp = Number(match[1])
            const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : `Canal ${dp}`
            if (!channels.has(dp) || channels.get(dp) === `Canal ${dp}`) channels.set(dp, name)
          }
        }
        if (channels.size) result.channels = [...channels].map(([dp, name]) => ({ dp, name })).sort((a, b) => a.dp - b.dp)
        try {
          const room = record(await this.request(session, `/v1.0/m/thing/ha/${encodeURIComponent(result.id)}/room`))
          result.roomId = room.roomId === undefined ? undefined : String(room.roomId)
          result.roomName = typeof room.name === 'string' ? room.name : undefined
        } catch { /* Some devices have no room assignment. */ }
        return result
      }))
      return { id, name: string(home.name), devices: mapped }
    }))
  }
}
