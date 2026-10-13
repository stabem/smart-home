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
})

describe('typed light service', () => {
  const session = {} as SmartLifeSession
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
    expect(warn).not.toHaveBeenCalled()
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
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
