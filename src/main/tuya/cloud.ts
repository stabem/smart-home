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

export class SmartLifeRateLimitError extends Error {}

export class SmartLifeRequestQueue {
  private tail: Promise<void> = Promise.resolve()
  private lastStart = -500
  private pausedUntil = 0
  private failures = 0
  constructor(private readonly now = Date.now, private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly random = Math.random) {}

  coolingDown(): boolean { return this.now() < this.pausedUntil }

  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>(resolve => { release = resolve })
    await previous
    try {
      const wait = Math.max(0, this.lastStart + 500 - this.now(), this.pausedUntil - this.now())
      if (wait) await this.sleep(wait)
      this.lastStart = this.now()
      const result = await work()
      this.failures = 0
      return result
    } catch (error) {
      if (error instanceof SmartLifeRateLimitError) {
        const delay = Math.min(60_000, 2_000 * 2 ** this.failures * (1 + this.random() * 0.25))
        this.pausedUntil = this.now() + delay
        this.failures++
      }
      throw error
    } finally { release() }
  }
}

// Shared across login and device clients. Serial work also keeps each device at one in-flight request.
const sharedQueue = new SmartLifeRequestQueue()

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
  private readonly deviceHomes = new Map<string, string>()
  private readonly statusCache = new Map<string, { status: Record<string, unknown>; expiresAt: number }>()
  private readonly statusBatches = new Map<string, Promise<void>>()
  onSessionChanged?: () => void
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly queue = sharedQueue) {}

  isRateLimited(): boolean { return this.queue.coolingDown() }

  registerHomes(homes: SmartLifeHome[]): void {
    this.deviceHomes.clear()
    for (const home of homes) for (const device of home.devices) this.deviceHomes.set(device.id, home.id)
  }

  private statusEntries(status: unknown): Record<string, unknown> | undefined {
    if (!Array.isArray(status)) return undefined
    return Object.fromEntries(status.map(value => { const item = record(value); return [string(item.code), item.value] }))
  }

  private rememberStatus(id: string, status: unknown): void {
    const values = this.statusEntries(status)
    if (values) this.statusCache.set(id, { status: values, expiresAt: Date.now() + 10_000 })
  }

  private async publicRequest(path: string, method: 'GET' | 'POST'): Promise<Record<string, unknown>> {
    return this.queue.run(async () => {
      const response = await this.fetcher(LOGIN_URL + path, { method, signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('Smart Life login request failed')
      const result = record(await response.json())
      if (String(result.code) === '-9999999') throw new SmartLifeRateLimitError('Smart Life rate limited code=-9999999')
      return result
    })
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
    return this.queue.run(async () => {
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
      const payload = record(await response.json())
      if (payload.success !== true && String(payload.code) === '-9999999') throw new SmartLifeRateLimitError('Smart Life rate limited code=-9999999')
      if (!response.ok) throw new Error(`Smart Life device request failed HTTP ${response.status}`)
      if (payload.success !== true) throw new Error(`Smart Life device request rejected code=${String(payload.code ?? '?')} msg=${String(payload.msg ?? '').slice(0, 80)}`)
      return typeof payload.result === 'string' && payload.result ? decrypt(payload.result, secret) : payload.result
    })
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
    const cached = this.statusCache.get(id)
    if (cached && cached.expiresAt > Date.now()) return cached.status
    if (this.queue.coolingDown()) throw new SmartLifeRateLimitError('Smart Life rate limited code=-9999999')
    const homeId = this.deviceHomes.get(id)
    if (!homeId) throw new Error('Smart Life home for device missing')
    let batch = this.statusBatches.get(homeId)
    if (!batch) {
      batch = (async () => {
        const devices = await this.request(session, '/v1.0/m/life/ha/home/devices', { homeId })
        if (!Array.isArray(devices)) throw new Error('Invalid Smart Life batched status')
        for (const device of devices) {
          const entry = record(device)
          this.rememberStatus(string(entry.id), entry.status)
        }
      })().finally(() => { this.statusBatches.delete(homeId) })
      this.statusBatches.set(homeId, batch)
    }
    await batch
    const refreshed = this.statusCache.get(id)
    if (!refreshed) throw new Error('Smart Life batched status missing device')
    return refreshed.status
  }

  async sendCommands(session: SmartLifeSession, id: string, commands: Array<{ code: string; value: unknown }>): Promise<void> {
    await this.request(session, `/v1.1/m/thing/${encodeURIComponent(id)}/commands`, undefined, { commands })
    this.statusCache.delete(id)
  }

  async listHomes(session: SmartLifeSession): Promise<SmartLifeHome[]> {
    const homes = await this.request(session, '/v1.0/m/life/users/homes')
    if (!Array.isArray(homes)) throw new Error('Invalid Smart Life homes')
    const mappedHomes = await Promise.all(homes.map(async item => {
      const home = record(item)
      const id = String(home.ownerId)
      const devices = await this.request(session, '/v1.0/m/life/ha/home/devices', { homeId: id })
      if (!Array.isArray(devices)) throw new Error('Invalid Smart Life devices')
      for (const value of devices) {
        const entry = record(value)
        this.rememberStatus(string(entry.id), entry.status)
      }
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
            const name = typeof item.name === 'string' && item.name.trim() && !/^Canal \d+$/i.test(item.name.trim())
              ? item.name.trim() : `${result.name} ${dp}`
            if (!channels.has(dp) || channels.get(dp) === `${result.name} ${dp}`) channels.set(dp, name)
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
    this.registerHomes(mappedHomes)
    return mappedHomes
  }
}
