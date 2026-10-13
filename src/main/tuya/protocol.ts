import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { connect, isIP, type Socket } from 'node:net'

export type TuyaVersion = '3.3' | '3.4' | '3.5'
export type Dps = Record<string, unknown>
export interface LanDevice { id: string; ip: string; localKey: string; version: TuyaVersion }

const PREFIX_55 = 0x55aa
const PREFIX_66 = 0x6699
const MAX_FRAME = 65536
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function ecb(data: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
function unecb(data: Buffer, key: Buffer): Buffer {
  const cipher = createDecipheriv('aes-128-ecb', key, null)
  return Buffer.concat([cipher.update(data), cipher.final()])
}
function gcm(data: Buffer, key: Buffer, iv: Buffer, aad: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-gcm', key, iv)
  cipher.setAAD(aad)
  return Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()])
}
function ungcm(data: Buffer, key: Buffer, iv: Buffer, aad: Buffer): Buffer {
  const cipher = createDecipheriv('aes-128-gcm', key, iv)
  cipher.setAAD(aad)
  cipher.setAuthTag(data.subarray(-16))
  return Buffer.concat([cipher.update(data.subarray(0, -16)), cipher.final()])
}
const mac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest()
const versionHeader = (v: TuyaVersion): Buffer => Buffer.concat([Buffer.from(v), Buffer.alloc(12)])

export function packFrame(version: TuyaVersion, key: Buffer, seq: number, cmd: number, plain: Buffer, nonce?: Buffer): Buffer {
  if (version === '3.5') {
    const iv = nonce ?? randomBytes(12)
    if (iv.length !== 12) throw new Error('Invalid Tuya GCM nonce')
    const header = Buffer.alloc(18)
    header.writeUInt32BE(PREFIX_66, 0)
    header.writeUInt32BE(seq, 6)
    header.writeUInt32BE(cmd, 10)
    header.writeUInt32BE(12 + plain.length + 16, 14)
    const body = gcm(plain, key, iv, header.subarray(4))
    const footer = Buffer.alloc(4); footer.writeUInt32BE(0x9966)
    return Buffer.concat([header, iv, body, footer])
  }
  const encrypted = ecb(plain, key)
  const payload = version === '3.3' && ![10, 16, 3, 5].includes(cmd)
    ? Buffer.concat([versionHeader(version), encrypted]) : encrypted
  const trailerSize = version === '3.4' ? 32 : 4
  const header = Buffer.alloc(16)
  header.writeUInt32BE(PREFIX_55, 0)
  header.writeUInt32BE(seq, 4)
  header.writeUInt32BE(cmd, 8)
  header.writeUInt32BE(payload.length + trailerSize + 4, 12)
  const signed = Buffer.concat([header, payload])
  const trailer = version === '3.4' ? mac(key, signed) : Buffer.alloc(4)
  if (version === '3.3') trailer.writeUInt32BE(crc32(signed))
  const footer = Buffer.alloc(4); footer.writeUInt32BE(0xaa55)
  return Buffer.concat([signed, trailer, footer])
}

export interface Frame { cmd: number; payload: Buffer }
export function unpackFrame(version: TuyaVersion, key: Buffer, frame: Buffer): Frame {
  const prefix = frame.readUInt32BE(0)
  if (prefix !== (version === '3.5' ? PREFIX_66 : PREFIX_55)) throw new Error('Invalid Tuya frame')
  const length = frame.readUInt32BE(version === '3.5' ? 14 : 12)
  const expected = (version === '3.5' ? 18 : 16) + length + (version === '3.5' ? 4 : 0)
  if (length > MAX_FRAME || frame.length !== expected) throw new Error('Invalid Tuya frame length')
  const cmd = frame.readUInt32BE(version === '3.5' ? 10 : 8)
  if (version === '3.5') {
    if (frame.readUInt32BE(frame.length - 4) !== 0x9966) throw new Error('Invalid Tuya footer')
    const iv = frame.subarray(18, 30)
    return { cmd, payload: ungcm(frame.subarray(30, -4), key, iv, frame.subarray(4, 18)) }
  }
  if (frame.readUInt32BE(frame.length - 4) !== 0xaa55) throw new Error('Invalid Tuya footer')
  const trailerSize = version === '3.4' ? 32 : 4
  const signed = frame.subarray(0, -trailerSize - 4)
  const signature = frame.subarray(-trailerSize - 4, -4)
  const expectedSignature = version === '3.4' ? mac(key, signed) : Buffer.alloc(4)
  if (version === '3.3') expectedSignature.writeUInt32BE(crc32(signed))
  if (!timingSafeEqual(signature, expectedSignature)) throw new Error('Invalid Tuya signature')
  // Device replies carry a four-byte return code before the payload.
  const body = frame.subarray(16, -trailerSize - 4)
  const code = body.length >= 4 ? body.readUInt32BE(0) : 0
  if (code !== 0) throw new Error('Tuya device rejected command')
  let payload = body.subarray(4)
  if (version === '3.3' && payload.subarray(0, 3).toString() === version) payload = payload.subarray(15)
  if (payload.length) payload = unecb(payload, key)
  return { cmd, payload }
}

function jsonPayload(version: TuyaVersion, cmd: number, data: object): Buffer {
  const body = Buffer.from(JSON.stringify(data))
  return version !== '3.3' && cmd !== 3 && cmd !== 5 && cmd !== 10 && cmd !== 16
    ? Buffer.concat([versionHeader(version), body]) : body
}
function parseDps(version: TuyaVersion, payload: Buffer): Dps {
  let data = payload
  if (version === '3.5') {
    if (data.length < 4 || data.readUInt32BE(0) !== 0) throw new Error('Tuya device rejected command')
    data = data.subarray(4)
  }
  if (data.subarray(0, 3).toString() === version) data = data.subarray(15)
  if (!data.length) return {}
  const result: unknown = JSON.parse(data.toString('utf8'))
  if (typeof result !== 'object' || result === null) throw new Error('Invalid Tuya status')
  const object = result as { dps?: Dps; data?: { dps?: Dps } }
  return object.dps ?? object.data?.dps ?? {}
}

export class TuyaLanClient {
  constructor(private readonly socketFactory: (ip: string) => Socket = ip => connect(6668, ip),
    private readonly nonceFactory: () => Buffer = () => randomBytes(16)) {}

  async request(device: LanDevice, dps?: Dps): Promise<Dps> {
    const key = Buffer.from(device.localKey, 'utf8')
    if (key.length !== 16) throw new Error('Invalid Tuya local key length')
    const socket = this.socketFactory(device.ip)
    let pending: Buffer = Buffer.alloc(0)
    const frames: Frame[] = []
    const waiters: Array<{ cmds: number[]; resolve: (frame: Frame) => void; reject: (error: Error) => void }> = []
    let session: Buffer = key
    let seq = 0
    const timeout = setTimeout(() => socket.destroy(new Error('Tuya device offline')), 1500)
    const fail = (error: Error): void => { for (const waiter of waiters.splice(0)) waiter.reject(error) }
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('Tuya device offline')))
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      try {
        while (pending.length >= 18) {
          const prefix = pending.readUInt32BE(0)
          const base = prefix === PREFIX_66 ? 18 : prefix === PREFIX_55 ? 16 : 0
          if (!base) throw new Error('Invalid Tuya frame')
          const length = pending.readUInt32BE(base - 4)
          const total = base + length + (base === 18 ? 4 : 0)
          if (length > MAX_FRAME) throw new Error('Invalid Tuya frame length')
          if (pending.length < total) break
          const frame = unpackFrame(device.version, session, pending.subarray(0, total))
          pending = pending.subarray(total)
          const index = waiters.findIndex(waiter => waiter.cmds.includes(frame.cmd))
          if (index < 0) frames.push(frame)
          else waiters.splice(index, 1)[0].resolve(frame)
        }
      } catch (error) { socket.destroy(error as Error) }
    })
    const receive = (...cmds: number[]): Promise<Frame> => {
      const index = frames.findIndex(frame => cmds.includes(frame.cmd))
      if (index >= 0) return Promise.resolve(frames.splice(index, 1)[0])
      return new Promise((resolve, reject) => waiters.push({ cmds, resolve, reject }))
    }
    const send = (cmd: number, data: Buffer): void => { socket.write(packFrame(device.version, session, ++seq, cmd, data)) }
    try {
      if (device.version !== '3.3') {
        const localNonce = this.nonceFactory()
        if (localNonce.length !== 16) throw new Error('Invalid Tuya nonce length')
        send(3, localNonce)
        const encryptedResponse = (await receive(4)).payload
        // TinyTuya's 6699 unpack_message removes the encrypted return code before
        // _negotiate_session_key_generate_step_3 sees the device nonce.
        const response = device.version === '3.5' && encryptedResponse.length === 52
          ? encryptedResponse.subarray(4) : encryptedResponse
        if (device.version === '3.5' && encryptedResponse.length === 52 && encryptedResponse.readUInt32BE(0) !== 0) {
          throw new Error('Tuya session authentication failed')
        }
        if (response.length < 48 || !timingSafeEqual(response.subarray(16, 48), mac(key, localNonce))) {
          throw new Error('Tuya session authentication failed')
        }
        const remoteNonce = response.subarray(0, 16)
        send(5, mac(key, remoteNonce))
        const xor = Buffer.from(localNonce.map((byte, i) => byte ^ remoteNonce[i]))
        session = device.version === '3.4'
          ? (() => { const cipher = createCipheriv('aes-128-ecb', key, null); cipher.setAutoPadding(false); return Buffer.concat([cipher.update(xor), cipher.final()]) })()
          : gcm(xor, key, localNonce.subarray(0, 12), Buffer.alloc(0)).subarray(0, 16)
      }
      const cmd = dps ? device.version === '3.3' ? 7 : 13 : device.version === '3.3' ? 10 : 16
      const payload = dps ? device.version === '3.3'
        ? { devId: device.id, uid: device.id, t: String(Math.floor(Date.now() / 1000)), dps }
        : { protocol: 5, t: Math.floor(Date.now() / 1000), data: { dps } }
        : device.version === '3.3' ? { gwId: device.id, devId: device.id } : { protocol: 5, t: Math.floor(Date.now() / 1000), data: {} }
      send(cmd, jsonPayload(device.version, cmd, payload))
      return parseDps(device.version, (await receive(cmd, 8)).payload)
    } finally {
      clearTimeout(timeout)
      socket.destroy()
    }
  }
}

export const udpKey = createHash('md5').update('yGAdlopoPVldABfn').digest()
export function isLanIp(ip: string): boolean {
  if (isIP(ip) !== 4) return false
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}
export function decodeBroadcast(data: Buffer): { id: string; ip: string; version?: TuyaVersion } | undefined {
  try {
    let payload = data
    if (data.length >= 18 && data.readUInt32BE(0) === PREFIX_66) payload = unpackFrame('3.5', udpKey, data).payload
    else if (data.length >= 16 && data.readUInt32BE(0) === PREFIX_55) {
      try { payload = unpackFrame('3.3', udpKey, data).payload }
      catch {
        if (data.length < 24 || data.readUInt32BE(data.length - 8) !== crc32(data.subarray(0, -8))) return undefined
        payload = data.subarray(16, -8)
        if (payload.subarray(0, 3).toString().startsWith('3.')) payload = payload.subarray(15)
        if (payload.length >= 4 && payload.readUInt32BE(0) === 0) payload = payload.subarray(4)
        try { payload = unecb(payload, udpKey) } catch { /* plaintext legacy broadcast */ }
      }
    } else if (data[0] !== 123) payload = unecb(data, udpKey)
    if (payload.length >= 4 && payload[0] === 0 && payload[1] === 0 && payload[2] === 0) payload = payload.subarray(4)
    if (payload.subarray(0, 3).toString().startsWith('3.')) payload = payload.subarray(15)
    const entry = JSON.parse(payload.toString('utf8').replace(/\0+$/, '')) as { gwId?: string; devId?: string; ip?: string; version?: string }
    if (!entry.ip || !isLanIp(entry.ip) || !(entry.gwId || entry.devId)) return undefined
    return { id: entry.gwId ?? entry.devId!, ip: entry.ip, version: ['3.3', '3.4', '3.5'].includes(entry.version ?? '') ? entry.version as TuyaVersion : undefined }
  } catch { return undefined }
}
