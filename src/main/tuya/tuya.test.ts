import { EventEmitter } from 'node:events'
import { createCipheriv } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Socket as UdpSocket } from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import { SmartLifeCloud, type SmartLifeSession } from './cloud'
import { discoverLan } from './discovery'
import { localSubnets, probeTcp } from './probe'
import { TuyaService } from './index'
import { decodeBroadcast, packFrame, udpKey, unpackFrame, TuyaLanClient, type LanDevice } from './protocol'

const device: LanDevice = { id: 'light-1', ip: '192.168.1.20', localKey: 'abcdefghijklmnop', version: '3.3' }

describe('Tuya LAN', () => {
  it('contains a UDP error after bind instead of leaving an unhandled process error', async () => {
    class FakeUdpSocket extends EventEmitter {
      closed = false
      bind(_port: number, _host: string, callback: () => void): void { callback() }
      close(): void { this.closed = true }
    }
    const first = new FakeUdpSocket()
    const sockets = [first, new FakeUdpSocket(), new FakeUdpSocket()]
    const scan = discoverLan(10, () => sockets.shift() as unknown as UdpSocket)
    queueMicrotask(() => first.emit('error', new Error('UDP failed')))
    await expect(scan).resolves.toBeInstanceOf(Map)
    expect(first.closed).toBe(true)
  })

  it('reads legacy plaintext and authenticated 3.5 LAN announcements', () => {
    const announcement = Buffer.from('{"gwId":"light-1","ip":"192.168.1.20","version":"3.5"}')
    expect(decodeBroadcast(announcement)).toEqual({ id: 'light-1', ip: '192.168.1.20', version: '3.5' })
    expect(decodeBroadcast(packFrame('3.5', udpKey, 1, 19, announcement))).toEqual({ id: 'light-1', ip: '192.168.1.20', version: '3.5' })
  })

  it('decrypts a 3.3 broadcast and rejects a WAN address in a packet', () => {
    const announcement = Buffer.from('{"gwId":"light-1","ip":"192.168.15.9","version":"3.3"}')
    const cipher = createCipheriv('aes-128-ecb', udpKey, null)
    const encrypted = Buffer.concat([cipher.update(announcement), cipher.final()])
    expect(decodeBroadcast(encrypted)).toEqual({ id: 'light-1', ip: '192.168.15.9', version: '3.3' })
    expect(decodeBroadcast(Buffer.from('{"gwId":"light-1","ip":"177.197.79.210","version":"3.3"}'))).toBeUndefined()
  })

  it('listens on all three UDP ports and uses the packet source LAN address', async () => {
    class FakeUdpSocket extends EventEmitter {
      port = 0
      bind(port: number, _host: string, callback: () => void): void { this.port = port; callback() }
      close(): void {}
    }
    const sockets: FakeUdpSocket[] = []
    const pending = discoverLan(10, () => {
      const socket = new FakeUdpSocket()
      sockets.push(socket)
      return socket as unknown as UdpSocket
    })
    queueMicrotask(() => sockets[2].emit('message', packFrame('3.5', udpKey, 1, 19,
      Buffer.from('{"gwId":"light-1","ip":"192.168.15.99","version":"3.5"}')),
    { address: '192.168.15.9' }))
    expect([...((await pending).values())]).toEqual([{ id: 'light-1', ip: '192.168.15.9', version: '3.5' }])
    expect(sockets.map(socket => socket.port)).toEqual([6666, 6667, 7000])
  })

  it('solicits a silent 3.5 device on UDP 7000 and accepts its unicast reply', async () => {
    class FakeUdpSocket extends EventEmitter {
      port = 0
      bind(port: number, _host: string, callback: () => void): void { this.port = port; callback() }
      setBroadcast(): void {}
      send(packet: Buffer, port: number, target: string, callback: (error: Error | null) => void): void {
        expect(this.port).toBe(7000)
        expect(port).toBe(7000)
        expect(target).toBe('192.168.15.255')
        expect(unpackFrame('3.5', udpKey, packet)).toEqual({ cmd: 0x25, payload: Buffer.from('{"from":"app","ip":"192.168.15.40"}') })
        queueMicrotask(() => this.emit('message', packFrame('3.5', udpKey, 2, 0x25,
          Buffer.from('{"gwId":"light-1","ip":"192.168.15.9","version":"3.5"}')),
        { address: '192.168.15.9' }))
        callback(null)
      }
      close(): void {}
    }
    const sockets: FakeUdpSocket[] = []
    const interfaces = { wifi: [{ address: '192.168.15.40', family: 'IPv4', internal: false,
      netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.15.40/24' }] } as Parameters<typeof localSubnets>[0]
    const found = await discoverLan(1, () => {
      const socket = new FakeUdpSocket()
      sockets.push(socket)
      return socket as unknown as UdpSocket
    }, interfaces)
    expect(sockets).toHaveLength(3)
    expect([...found.values()]).toEqual([{ id: 'light-1', ip: '192.168.15.9', version: '3.5' }])
  })

  it('reports a Windows firewall hint when UDP binding is denied', async () => {
    class DeniedSocket extends EventEmitter {
      bind(): void { queueMicrotask(() => this.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' }))) }
      close(): void {}
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await discoverLan(1, () => new DeniedSocket() as unknown as UdpSocket)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Windows Firewall'))
    warn.mockRestore()
  })

  it('probes only preferred local /24 addresses with bounded fake sockets', async () => {
    const interfaces = {
      wifi: [{ address: '192.168.15.40', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:01', cidr: '192.168.15.40/24' }],
      virtual: [{ address: '172.20.0.1', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:02', cidr: '172.20.0.1/24' }]
    } as Parameters<typeof localSubnets>[0]
    expect(localSubnets(interfaces)).toEqual(['192.168.15'])
    const visited: string[] = []
    class FakeSocket extends EventEmitter {
      setTimeout(): this { return this }
      destroy(): this { return this }
    }
    const found = await probeTcp(['192.168.15'], ip => {
      visited.push(ip)
      const socket = new FakeSocket()
      queueMicrotask(() => socket.emit(ip === '192.168.15.9' ? 'connect' : 'error', new Error('closed')))
      return socket as unknown as Socket
    })
    expect(found).toEqual(['192.168.15.9'])
    expect(visited).toHaveLength(254)
    expect(visited.every(ip => ip.startsWith('192.168.15.'))).toBe(true)
  })

  it('rejects modified packets before decoding DPS', () => {
    const frame = packFrame('3.3', Buffer.from(device.localKey), 1, 7, Buffer.from('{"dps":{"1":true}}'))
    frame[22] ^= 1
    // The packet is rejected at the checksum layer, before any key or DPS data can be trusted.
    expect(() => unpackFrame('3.3', Buffer.from(device.localKey), frame)).toThrow('Invalid Tuya signature')
  })

  it('authenticates 3.4 HMAC and 3.5 GCM frames', () => {
    const key = Buffer.from(device.localKey)
    const encrypted34 = packFrame('3.4', key, 1, 13, Buffer.from('{"dps":{"1":true}}'))
    encrypted34[24] ^= 1
    expect(() => unpackFrame('3.4', key, encrypted34)).toThrow('Invalid Tuya signature')
    const encrypted35 = packFrame('3.5', key, 1, 13, Buffer.from('{"dps":{"1":true}}'))
    expect(unpackFrame('3.5', key, encrypted35).payload.toString()).toBe('{"dps":{"1":true}}')
    encrypted35[32] ^= 1
    expect(() => unpackFrame('3.5', key, encrypted35)).toThrow()
  })

  it('decodes TinyTuya tests.py 6699 vector and rejects its modified tag', () => {
    // TinyTuya tests.py uses LOCAL_KEY=0123456789abcdef, seq=1, cmd=16,
    // payload={"x":1}, and a twelve-byte zero IV for this GCM case.
    const frame = Buffer.from('00006699000000000001000000100000002300000000000000000000000039c05267c3bbf116fd97ec0e3cc6e3afcd9a9ba161236800009966', 'hex')
    expect(unpackFrame('3.5', Buffer.from('0123456789abcdef'), frame)).toEqual({ cmd: 16, payload: Buffer.from('{"x":1}') })
    frame[frame.length - 5] ^= 1
    expect(() => unpackFrame('3.5', Buffer.from('0123456789abcdef'), frame)).toThrow()
  })

  it('accepts a 3.5 reply return code and uses the TinyTuya nonce-derived session key', async () => {
    const key = Buffer.from('0123456789abcdef')
    const localNonce = Buffer.from('0123456789abcdef')
    const remoteNonce = Buffer.from('fedcba9876543210')
    const responseHmac = Buffer.from('fb5b26229c20b7ed866706a2fbfae67e3f404bb6abe77ff45063a459a42924a4', 'hex')
    const finishHmac = Buffer.from('0de373b876d33f8102b2a67aa43aaa88161b7606292f33f47db3b67fd5e2bf4e', 'hex')
    const sessionKey = Buffer.from('34165bab783422860c0c23b2d48cf7a5', 'hex')
    class FakeSocket extends EventEmitter {
      write(packet: Buffer): boolean {
        const cmd = packet.readUInt32BE(10)
        if (cmd === 3) {
          expect(unpackFrame('3.5', key, packet).payload).toEqual(localNonce)
          queueMicrotask(() => this.emit('data', packFrame('3.5', key, 2, 4,
            Buffer.concat([Buffer.alloc(4), remoteNonce, responseHmac]))))
        } else if (cmd === 5) {
          expect(unpackFrame('3.5', key, packet).payload).toEqual(finishHmac)
        } else {
          expect(cmd).toBe(16)
          expect(unpackFrame('3.5', sessionKey, packet).payload.toString()).toContain('"protocol":5')
          queueMicrotask(() => this.emit('data', packFrame('3.5', sessionKey, 3, 16,
            Buffer.concat([Buffer.alloc(4), Buffer.from('{"data":{"dps":{"1":true}}}')]))))
        }
        return true
      }
      destroy(error?: Error): this { if (error) this.emit('error', error); this.emit('close'); return this }
    }
    const client = new TuyaLanClient(() => new FakeSocket() as unknown as Socket, () => localNonce)
    await expect(client.request({ ...device, localKey: key.toString(), version: '3.5' })).resolves.toEqual({ '1': true })
  })

  it('returns an offline failure promptly when the socket fails', async () => {
    class FakeSocket extends EventEmitter {
      write(): boolean { return true }
      destroy(error?: Error): this { if (error) this.emit('error', error); this.emit('close'); return this }
    }
    const fake = new FakeSocket()
    const client = new TuyaLanClient(() => fake as unknown as Socket)
    const started = Date.now()
    const pending = client.request(device)
    queueMicrotask(() => fake.destroy(new Error('Tuya device offline')))
    await expect(pending).rejects.toThrow('Tuya device offline')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})

describe('Smart Life QR flow', () => {
  it('requests QR token and polls without exposing a credential in errors', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: { qrcode: 'qr-token' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: false, code: 'WAIT' }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const qr = await cloud.startLogin('test-user-code')
    expect(qr).toEqual({ token: 'qr-token', qrUri: 'tuyaSmart--qrLogin?token=qr-token' })
    expect(await cloud.pollLogin(qr.token, 'test-user-code')).toBeNull()
    expect(fetcher.mock.calls[0][0]).toContain('usercode=test-user-code')
  })
  it('refreshes an expired sharing session and posts an encrypted command body', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: { accessToken: 'new-token', refreshToken: 'new-refresh', expireTime: 3600 } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: null }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const changed = vi.fn()
    cloud.onSessionChanged = changed
    const expired: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'old-token', refreshToken: 'old-refresh',
      expiresAt: 0, uid: 'user', terminalId: 'terminal' }
    await cloud.sendCommands(expired, 'switch', [{ code: 'switch_1', value: true }])
    expect(fetcher.mock.calls[0][0].toString()).toContain('/v1.0/m/token/old-refresh')
    expect(fetcher.mock.calls[1][0].toString()).toContain('/v1.1/m/thing/switch/commands')
    expect(fetcher.mock.calls[1][1].method).toBe('POST')
    expect(fetcher.mock.calls[1][1].headers['X-token']).toBe('new-token')
    expect(fetcher.mock.calls[1][1].body).not.toContain('switch_1')
    expect(changed).toHaveBeenCalledOnce()
  })
  it('refreshes shortly before expiry and signals the encrypted store to persist new tokens', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true,
      result: { accessToken: 'new-token', refreshToken: 'new-refresh', expireTime: 3600 } }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const changed = vi.fn()
    cloud.onSessionChanged = changed
    const due: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'old-token', refreshToken: 'old-refresh',
      expiresAt: Date.now() + 4 * 60_000, uid: 'user', terminalId: 'terminal' }
    await cloud.refreshIfNeeded(due)
    expect(due.accessToken).toBe('new-token')
    expect(due.refreshToken).toBe('new-refresh')
    expect(changed).toHaveBeenCalledOnce()
    await cloud.refreshIfNeeded(due)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})

describe('typed light service', () => {
  const session = {} as SmartLifeSession
  it('logs each LAN version and cloud failure with device context but no key', async () => {
    const key = 'abcdefghijklmnop'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cloud = { deviceStatus: vi.fn().mockRejectedValue(new Error('cloud unavailable')),
        sendCommands: vi.fn().mockRejectedValue(new Error('cloud control unavailable')) }
      const lan = { request: vi.fn().mockRejectedValue(new Error(`bad key ${key}`)) }
      const home = [{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', localKey: key, homeId: 'home', ip: '192.168.1.20', version: '3.5' }
      ] }]
      const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
        vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: '192.168.1.20', version: '3.5' }]])))
      await service.restore(home, session)
      expect(await service.getState('light-1')).toEqual({ on: false, online: false })
      expect(await service.setLight('light-1', { on: true })).toEqual({ on: false, online: false })
      const lines = warn.mock.calls.map(call => String(call[0]))
      expect(lines.some(line => line.includes('id=light-1 ip=192.168.1.20 v=3.5 err=bad key [redacted]'))).toBe(true)
      expect(lines.some(line => line.includes('cloud unavailable'))).toBe(true)
      expect(lines.some(line => line.includes('cloud control unavailable'))).toBe(true)
      expect(lines.join('\n')).not.toContain(key)
    } finally { warn.mockRestore() }
  })
  it('ends a scan of slow open nonmatching hosts within the total deadline', async () => {
    vi.useFakeTimers()
    try {
      const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }
      ] }]) }
      const request = vi.fn().mockImplementation(() => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('not this device')), 1500)))
      const candidates = Array.from({ length: 254 }, (_, index) => `192.168.15.${index + 1}`)
      const service = new TuyaService(cloud as unknown as SmartLifeCloud, { request } as unknown as TuyaLanClient,
        vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue(candidates))
      let completed = false
      const pending = service.discover(session).then(() => { completed = true })
      await vi.advanceTimersByTimeAsync(8001)
      expect(completed).toBe(true)
      expect(request.mock.calls.length).toBeLessThan(20)
      await pending
      expect(await service.getState('light-1')).toEqual({ on: false, online: false })
    } finally { vi.useRealTimers() }
  })

  it('does not claim a cloud switch changed when status cannot confirm it', async () => {
    const cloud = {
      listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', homeId: 'home' }
      ] }]),
      sendCommands: vi.fn().mockResolvedValue(undefined),
      deviceStatus: vi.fn().mockRejectedValue(new Error('status unavailable'))
    }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, {} as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: false, online: false })
    expect(cloud.sendCommands).toHaveBeenCalledOnce()
  })
  it('ignores cloud WAN IP and uses a verified TCP probe candidate', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
      { id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', ip: '177.197.79.210' }
    ] }]) }
    const lan = { request: vi.fn().mockResolvedValue({ '1': true }) }
    const probe = vi.fn().mockResolvedValue(['192.168.15.9'])
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), probe)
    const homes = await service.discover(session)
    expect(homes[0].devices[0].ip).toBe('192.168.15.9')
    expect(lan.request.mock.calls.every(call => call[0].ip === '192.168.15.9')).toBe(true)
    expect(await service.getState('light-1')).toEqual({ on: true, online: true })
  })

  it('uses Smart Life status and commands when LAN is absent', async () => {
    const cloud = {
      listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'switch', name: 'Office', category: 'kg', localKey: device.localKey, homeId: 'home', ip: '179.119.114.249' }
      ] }]),
      deviceStatus: vi.fn().mockResolvedValue({ switch_1: true }),
      sendCommands: vi.fn().mockResolvedValue(undefined)
    }
    const lan = { request: vi.fn() }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    const homes = await service.discover(session)
    expect(homes[0].devices[0].ip).toBeUndefined()
    expect(await service.getState('switch')).toEqual({ on: true, online: true, viaCloud: true })
    expect(await service.setLight('switch', { on: true })).toEqual({ on: true, online: true, viaCloud: true })
    expect(cloud.sendCommands).toHaveBeenCalledWith(session, 'switch', [{ code: 'switch_1', value: true }])
    expect(lan.request).not.toHaveBeenCalled()
  })

  it('uses Smart Life when a discovered LAN device stops responding', async () => {
    const cloud = {
      listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }
      ] }]),
      deviceStatus: vi.fn().mockResolvedValue({ switch_led: true }),
      sendCommands: vi.fn().mockResolvedValue(undefined)
    }
    const lan = { request: vi.fn().mockRejectedValue(new Error('offline')) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: '192.168.15.9', version: '3.3' }]])),
      vi.fn().mockResolvedValue([]))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: true, online: true, viaCloud: true })
    expect(cloud.sendCommands).toHaveBeenCalledWith(session, 'light-1', [{ code: 'switch_led', value: true }])
    expect(lan.request).toHaveBeenCalledTimes(3)
  })

  it('scrubs a saved WAN IP and persists the corrected setup', async () => {
    const homes = [{ id: 'home', name: 'Casa', devices: [
      { id: 'switch', name: 'Office', category: 'kg', localKey: device.localKey, homeId: 'home', ip: '179.247.255.254' }
    ] }]
    const service = new TuyaService({} as SmartLifeCloud, { request: vi.fn() } as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    const persist = vi.fn()
    service.onAddressesChanged(persist)
    await service.restore(homes)
    expect(homes[0].devices[0].ip).toBeUndefined()
    expect(persist).toHaveBeenCalledWith(homes)
  })
  it('maps discovered LAN lights and keeps an unreachable light offline', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }] }]) }
    const lan = { request: vi.fn().mockRejectedValue(new Error('socket failed')) }
    const scan = vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]]))
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient, scan)
    const homes = await service.discover(session)
    expect(homes[0].devices[0].ip).toBe(device.ip)
    expect(await service.getState('light-1')).toEqual({ on: false, online: false })
    expect(lan.request.mock.calls.map(call => call[0].version)).toEqual(['3.3', '3.4', '3.5'])
  })

  it('sends light DPS and reads the resulting state', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }] }]) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '1': true, '3': 500 }) }
    const scan = vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]]))
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient, scan)
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 50 })).toEqual({ on: true, online: true, brightness: 50 })
    expect(lan.request.mock.calls[0][1]).toEqual({ '1': true, '3': 500 })
  })

  it('retries protocol versions and uses the matching gang DP', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'switch', name: 'Office', category: 'kg', localKey: device.localKey, homeId: 'home', channels: [{ dp: 1, name: 'Office' }, { dp: 2, name: 'Cortineiro' }] }] }]) }
    const lan = { request: vi.fn().mockRejectedValueOnce(new Error('bad version')).mockResolvedValue({ '1': false, '2': true }) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['switch', { id: 'switch', ip: device.ip, version: '3.3' }]])))
    const homes = await service.discover(session)
    expect(homes[0].devices[0].channels).toEqual([{ dp: 1, name: 'Office' }, { dp: 2, name: 'Cortineiro' }])
    expect(lan.request.mock.calls.slice(0, 2).map(call => call[0].version)).toEqual(['3.3', '3.4'])
    expect(warn).toHaveBeenCalledWith(`Tuya id=switch ip=${device.ip} v=3.3 err=bad version`)
    expect(await service.getState('switch::2')).toEqual({ on: true, online: true })
    await service.setLight('switch::2', { on: false })
    expect(lan.request.mock.calls.at(-2)?.[1]).toEqual({ '2': false })
    warn.mockRestore()
  })

  it('falls back from a failed 3.4 socket to a working 3.3 socket', async () => {
    let opened = 0
    class FakeSocket extends EventEmitter {
      closed = false
      write(frame: Buffer): boolean {
        if (opened === 1) queueMicrotask(() => this.destroy(new Error('protocol mismatch')))
        else {
          expect(frame.readUInt32BE(8)).toBe(10)
          const requestFrame = packFrame('3.3', Buffer.from(device.localKey), 1, 10, Buffer.from('{"dps":{"1":true}}'))
          const signed = Buffer.concat([requestFrame.subarray(0, 16), Buffer.alloc(4), requestFrame.subarray(16, -8)])
          signed.writeUInt32BE(requestFrame.readUInt32BE(12) + 4, 12)
          let crc = 0xffffffff
          for (const byte of signed) {
            crc ^= byte
            for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
          }
          const checksum = Buffer.alloc(4)
          checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
          const reply = Buffer.concat([signed, checksum, requestFrame.subarray(-4)])
          queueMicrotask(() => this.emit('data', reply))
        }
        return true
      }
      destroy(error?: Error): this {
        if (this.closed) return this
        this.closed = true
        if (error) this.emit('error', error)
        this.emit('close')
        return this
      }
    }
    const lan = new TuyaLanClient(() => { opened++; return new FakeSocket() as unknown as Socket })
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }] }]) }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.4' }]])))
    await service.discover(session)
    const state = await service.getState('light-1')
    expect(state).toEqual({ on: true, online: true })
    expect(opened).toBe(2)
    expect(warn).toHaveBeenCalledWith(`Tuya id=light-1 ip=${device.ip} v=3.4 err=protocol mismatch`)
    warn.mockRestore()
  })
})
