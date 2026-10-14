import { EventEmitter } from 'node:events'
import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto'
import type { Socket } from 'node:net'
import type { Socket as UdpSocket } from 'node:dgram'
import { describe, expect, it, vi } from 'vitest'
import { SmartLifeCloud, SmartLifeRateLimitError, SmartLifeRequestQueue, type SmartLifeSession } from './cloud'
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

  it('packs TinyTuya 3.5 CONTROL_NEW with encrypted version header, sequence and session key', () => {
    // TinyTuya XenonDevice.generate_payload(CONTROL) overrides to 0x0d;
    // message_helper.pack_message uses the 6699 header as GCM AAD.
    // The fixed bytes were calculated independently with Python cryptography AESGCM.
    const plain = Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12),
      Buffer.from('{"protocol":5,"t":1,"data":{"dps":{"1":true}}}')])
    const frame = packFrame('3.5', Buffer.from('0123456789abcdef'), 7, 13, plain, Buffer.alloc(12))
    expect(frame.toString('hex')).toBe('000066990000000000070000000d0000005900000000000000000000000071cc1f45f98a8cc38f5691b0a5ac38f99c99ccd14744d62183b17e08757cabe93f81d8a1250291be283d1b61ff940868da8d239255c08965d162d9a89fce91ff6d33845b6fcd620ed1e68d15e700009966')
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
          expect([13, 16]).toContain(cmd)
          const plain = unpackFrame('3.5', sessionKey, packet).payload
          if (cmd === 13) {
            expect(plain.subarray(0, 15)).toEqual(Buffer.concat([Buffer.from('3.5'), Buffer.alloc(12)]))
            expect(JSON.parse(plain.subarray(15).toString())).toMatchObject({ protocol: 5, data: { dps: { '1': true } } })
          } else expect(plain.toString()).toContain('"protocol":5')
          queueMicrotask(() => this.emit('data', packFrame('3.5', sessionKey, 3, cmd,
            Buffer.concat([Buffer.alloc(4), Buffer.from('{"data":{"dps":{"1":true}}}')]))))
        }
        return true
      }
      destroy(error?: Error): this { if (error) this.emit('error', error); this.emit('close'); return this }
    }
    const client = new TuyaLanClient(() => new FakeSocket() as unknown as Socket, () => localNonce)
    await expect(client.request({ ...device, localKey: key.toString(), version: '3.5' })).resolves.toEqual({ '1': true })
    await expect(client.request({ ...device, localKey: key.toString(), version: '3.5' }, { '1': true })).resolves.toEqual({ '1': true })
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
  it('reopens a socket after ECONNRESET before the reply waiter is installed', async () => {
    let opened = 0
    class ResetSocket extends EventEmitter {
      write(): boolean { this.emit('error', new Error('read ECONNRESET')); return true }
      destroy(): this { this.emit('close'); return this }
    }
    const client = new TuyaLanClient(() => { opened++; return new ResetSocket() as unknown as Socket })
    await expect(client.request(device)).rejects.toThrow('ECONNRESET')
    await expect(client.request(device)).rejects.toThrow('ECONNRESET')
    expect(opened).toBe(2)
  })
})

describe('Smart Life QR flow', () => {
  it('starts four distinct device commands within 360 ms and caps in-flight work at four', async () => {
    let now = 10_000
    const starts: number[] = []
    const releases: Array<() => void> = []
    const queue = new SmartLifeRequestQueue(() => now, async ms => { now += ms }, () => 0)
    const commands = [1, 2, 3, 4, 5].map(id => queue.run(async () => {
      starts.push(now)
      await new Promise<void>(resolve => { releases.push(resolve) })
    }, 'command', String(id)))
    await vi.waitFor(() => expect(starts).toHaveLength(4))
    expect(starts).toEqual([10_000, 10_120, 10_240, 10_360])
    releases[0]()
    await vi.waitFor(() => expect(starts).toHaveLength(5))
    expect(starts[4]).toBe(10_480)
    releases.slice(1).forEach(release => release())
    await Promise.all(commands)
  })

  it('keeps commands for one device serial and pauses both lanes after a command rate limit', async () => {
    let now = 10_000
    const starts: number[] = []
    const queue = new SmartLifeRequestQueue(() => now, async ms => { now += ms }, () => 0)
    let release!: () => void
    const first = queue.run(async () => { starts.push(now); await new Promise<void>(resolve => { release = resolve }) }, 'command', 'one')
    const second = queue.run(async () => { starts.push(now); throw new SmartLifeRateLimitError('code=-9999999') }, 'command', 'one')
    await vi.waitFor(() => expect(starts).toHaveLength(1))
    release()
    await first
    await expect(second).rejects.toBeInstanceOf(SmartLifeRateLimitError)
    expect(starts).toEqual([10_000, 10_120])
    await queue.run(async () => { starts.push(now) })
    await queue.run(async () => { starts.push(now) }, 'command', 'two')
    expect(starts).toEqual([10_000, 10_120, 12_120, 12_120])
  })

  it('shares a two-per-second queue and backs off exponentially on the sharing limit', async () => {
    let now = 10_000
    const starts: number[] = []
    const queue = new SmartLifeRequestQueue(() => now, async ms => { now += ms }, () => 0)
    const work = async () => { starts.push(now); return true }
    await Promise.all([queue.run(work), queue.run(work)])
    expect(starts).toEqual([10_000, 10_500])
    await expect(queue.run(async () => { starts.push(now); throw new SmartLifeRateLimitError('code=-9999999') })).rejects.toThrow('-9999999')
    expect(queue.coolingDown()).toBe(true)
    await expect(queue.run(async () => { starts.push(now); throw new SmartLifeRateLimitError('code=-9999999') })).rejects.toThrow('-9999999')
    await queue.run(work)
    expect(starts).toEqual([10_000, 10_500, 11_000, 13_000, 17_000])
    expect(queue.coolingDown()).toBe(false)
  })

  it('reads status for two devices in one queued home request and caches it', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: [
      { id: 'one', status: [{ code: 'switch_led', value: true }] },
      { id: 'two', status: [{ code: 'switch_1', value: false }] }
    ] }) })
    let clock = 10_000
    const queue = new SmartLifeRequestQueue(() => clock, async ms => { clock += ms }, () => 0)
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch, queue)
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [
      { id: 'one', name: 'One', category: 'dj', localKey: '', homeId: 'home' },
      { id: 'two', name: 'Two', category: 'kg', localKey: '', homeId: 'home' }
    ] }])
    expect(await Promise.all([cloud.deviceStatus(session, 'one'), cloud.deviceStatus(session, 'two')])).toEqual([{ switch_led: true }, { switch_1: false }])
    expect(await cloud.deviceStatus(session, 'one')).toEqual({ switch_led: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(String(fetcher.mock.calls[0][0])).toContain('/v1.0/m/life/ha/home/devices')
  })
  it('never confirms a command from a status batch that started before the command, even for four channels of one device', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const old = [{ id: 'sw', status: [1, 2, 3, 4].map(dp => ({ code: `switch_${dp}`, value: false })) }]
    const fresh = [{ id: 'sw', status: [1, 2, 3, 4].map(dp => ({ code: `switch_${dp}`, value: true })) }]
    let statusCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/commands')) return { ok: true, json: async () => ({ success: true, result: true }) }
      statusCalls++
      if (statusCalls === 1) { await gate; return { ok: true, json: async () => ({ success: true, result: old }) } }
      return { ok: true, json: async () => ({ success: true, result: fresh }) }
    })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [{ id: 'sw', name: 'Cozinha', category: 'kg', localKey: '', homeId: 'home' }] }])
    const early = cloud.deviceStatus(session, 'sw')            // batch starts BEFORE the commands and is held open
    await new Promise(resolve => setTimeout(resolve, 20))
    await Promise.all([1, 2, 3, 4].map(dp => cloud.sendCommands(session, 'sw', [{ code: `switch_${dp}`, value: true }])))
    await new Promise(resolve => setTimeout(resolve, 5))
    const confirmations = [1, 2, 3, 4].map(() => cloud.deviceStatus(session, 'sw'))
    release()                                                    // the old batch resolves AFTER the commands, with OLD data
    expect(await early).toMatchObject({ switch_1: false })
    const results = await Promise.all(confirmations)
    results.forEach(status => expect(status).toMatchObject({ switch_1: true, switch_2: true, switch_3: true, switch_4: true }))
    expect(statusCalls).toBeGreaterThanOrEqual(2)
  })
  it('fails confirmation when the fresh batch omits the device instead of reusing the pre-command entry', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let statusCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/commands')) return { ok: true, json: async () => ({ success: true, result: true }) }
      statusCalls++
      if (statusCalls === 1) { await gate; return { ok: true, json: async () => ({ success: true, result: [{ id: 'sw', status: [{ code: 'switch_1', value: true }] }] }) } }
      return { ok: true, json: async () => ({ success: true, result: [] }) }
    })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [{ id: 'sw', name: 'Cozinha', category: 'kg', localKey: '', homeId: 'home' }] }])
    const early = cloud.deviceStatus(session, 'sw')
    await new Promise(resolve => setTimeout(resolve, 20))
    await cloud.sendCommands(session, 'sw', [{ code: 'switch_1', value: true }])
    await new Promise(resolve => setTimeout(resolve, 5))
    const confirmation = cloud.deviceStatus(session, 'sw')
    release()
    expect(await early).toMatchObject({ switch_1: true })
    await expect(confirmation).rejects.toThrow('missing device')
  })
  it('does not return an expired post-command entry when the new batch omits the device', async () => {
    let now = 100_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      let statusCalls = 0
      const fetcher = vi.fn(async (url: string) => {
        if (String(url).includes('/commands')) return { ok: true, json: async () => ({ success: true, result: true }) }
        statusCalls++
        return { ok: true, json: async () => ({ success: true, result: statusCalls === 1 ? [{ id: 'sw', status: [{ code: 'switch_1', value: true }] }] : [] }) }
      })
      const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch, new SmartLifeRequestQueue(() => now, async () => {}, () => 0))
      const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: now + 3600000, uid: 'u', terminalId: 't' }
      cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [{ id: 'sw', name: 'Cozinha', category: 'kg', localKey: '', homeId: 'home' }] }])
      await cloud.sendCommands(session, 'sw', [{ code: 'switch_1', value: true }])
      now += 1000
      expect(await cloud.deviceStatus(session, 'sw')).toEqual({ switch_1: true })
      now += 11_000                                              // the entry expires
      await expect(cloud.deviceStatus(session, 'sw')).rejects.toThrow('missing device')
    } finally { vi.restoreAllMocks() }
  })
  it('confirms from a fresh batch that starts in the same millisecond as the command', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(100_000)
    try {
      const fetcher = vi.fn(async (url: string) => String(url).includes('/commands')
        ? { ok: true, json: async () => ({ success: true, result: true }) }
        : { ok: true, json: async () => ({ success: true, result: [{ id: 'sw', status: [{ code: 'switch_1', value: true }] }] }) })
      const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch, new SmartLifeRequestQueue(() => 100_000, async () => {}, () => 0))
      const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: 100_000 + 3_600_000, uid: 'u', terminalId: 't' }
      cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [{ id: 'sw', name: 'Cozinha', category: 'kg', localKey: '', homeId: 'home' }] }])
      await cloud.sendCommands(session, 'sw', [{ code: 'switch_1', value: true }])
      expect(await cloud.deviceStatus(session, 'sw')).toEqual({ switch_1: true })
    } finally { vi.restoreAllMocks() }
  })
  it('confirms on the retry through the real cache when the first post-command batch lags', async () => {
    let statusCalls = 0
    const fetcher = vi.fn(async (url: string) => {
      if (String(url).includes('/commands')) return { ok: true, json: async () => ({ success: true, result: true }) }
      statusCalls++
      return { ok: true, json: async () => ({ success: true, result: [{ id: 'sw', status: [{ code: 'switch_1', value: statusCalls >= 2 }] }] }) }
    })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch, new SmartLifeRequestQueue(() => Date.now(), async () => {}, () => 0))
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    const service = new TuyaService(cloud, {} as TuyaLanClient, vi.fn().mockResolvedValue(new Map()))
    vi.spyOn(cloud, 'listHomes').mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'sw', name: 'Cozinha', category: 'kg', localKey: '', homeId: 'home' }] }])
    await service.discover(session)
    expect(await service.setLight('sw', { on: true })).toMatchObject({ on: true, online: true })
    expect(statusCalls).toBe(2)
  })
  it('takes online from ha/home/devices even when cached switch status says on', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: [
      { id: 'one', online: false, status: [{ code: 'switch_led', value: true }] }
    ] }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch,
      new SmartLifeRequestQueue(() => 10_000, async () => {}, () => 0))
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    cloud.registerHomes([{ id: 'home', name: 'Casa', devices: [{ id: 'one', name: 'One', category: 'dj', localKey: '', homeId: 'home' }] }])
    expect(await cloud.deviceStatus(session, 'one')).toEqual({ switch_led: true })
    expect(cloud.deviceOnline('one')).toBe(false)
  })
  it('turns API_QPS_LIMIT_OR_DEGRADE into a shared queue cooldown', async () => {
    let clock = 10_000
    const queue = new SmartLifeRequestQueue(() => clock, async ms => { clock += ms }, () => 0)
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false, code: -9999999, msg: 'API_QPS_LIMIT_OR_DEGRADE' }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch, queue)
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    await expect(cloud.sendCommands(session, 'one', [{ code: 'switch_1', value: true }])).rejects.toBeInstanceOf(SmartLifeRateLimitError)
    expect(cloud.isRateLimited()).toBe(true)
  })
  it('uses cloud channel names and device-number fallback instead of Canal 1', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: [{ ownerId: 'home', name: 'Casa' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: [{ id: 'switch', name: 'Interruptor Office', category: 'kg', local_key: 'fixture-key',
        status: [{ code: 'switch_1', name: 'Luz do Office' }, { code: 'switch_2' }] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, result: {} }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const session: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    const homes = await cloud.listHomes(session)
    expect(homes[0].devices[0].channels).toEqual([{ dp: 1, name: 'Luz do Office' }, { dp: 2, name: 'Interruptor Office 2' }])
  })
  it('persists the specification code to DP mapping found during discovery', async () => {
    const paths: string[] = []
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname
      paths.push(path)
      const result = path.endsWith('/users/homes') ? [{ ownerId: 'home', name: 'Casa' }]
        : path.endsWith('/home/devices') ? [{ id: 'bulb', name: 'Lamp', category: 'dj', local_key: 'fixture-key' }]
          : path.endsWith('/specifications') ? { functions: [{ code: 'switch_led', dp_id: 20 }, { code: 'bright_value_v2', dp_id: 22 }],
            status: [{ code: 'colour_data_v2', dp_id: 24 }] } : {}
      return { ok: true, json: async () => ({ success: true, result }) }
    })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const homes = await cloud.listHomes({ endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' })
    expect(paths.filter(path => path.endsWith('/specifications'))).toEqual(['/v1.1/m/life/bulb/specifications'])
    expect(homes[0].devices[0].dpMap).toEqual({ switch_led: 20, bright_value_v2: 22, colour_data_v2: 24 })
    expect(homes[0].devices[0].cloudCodes).toEqual(['switch_led', 'bright_value_v2'])
  })
  it('uses the sharing SDK local strategy when specification has no dp_id', async () => {
    const fetcher = vi.fn(async (url: string) => {
      const path = new URL(url).pathname
      const result = path.endsWith('/users/homes') ? [{ ownerId: 'home', name: 'Casa' }]
        : path.endsWith('/home/devices') ? [{ id: 'bulb', name: 'Lamp', category: 'dj', local_key: 'fixture-key' }]
          : path.endsWith('/specifications') ? { functions: [{ code: 'switch_led' }], status: [] }
            : path.endsWith('/devices/bulb/status') ? { dpStatusRelationDTOS: [
              { statusCode: 'switch_led', dpId: 20, supportLocal: true },
              { statusCode: 'bright_value_v2', dpId: 22, supportLocal: true }] } : {}
      return { ok: true, json: async () => ({ success: true, result }) }
    })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const homes = await cloud.listHomes({ endpoint: 'https://example.invalid', accessToken: 'fake', refreshToken: 'fake', expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' })
    expect(homes[0].devices[0].dpMap).toEqual({ switch_led: 20, bright_value_v2: 22 })
  })
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
  it('matches the sharing SDK command POST, encrypted bytes and signature', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true, result: null }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    const current: SmartLifeSession = { endpoint: 'https://example.invalid', accessToken: 'fixture-token', refreshToken: 'fixture-refresh',
      expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }
    await cloud.sendCommands(current, 'bulb', [{ code: 'switch_led', value: true }])
    const [url, options] = fetcher.mock.calls[0]
    expect(new URL(url).pathname).toBe('/v1.1/m/thing/bulb/commands')
    expect(options.method).toBe('POST')
    const headers = options.headers as Record<string, string>
    const encoded = JSON.parse(options.body as string).encdata as string
    expect(Object.keys(JSON.parse(options.body as string))).toEqual(['encdata'])
    const hashKey = createHash('md5').update(headers['X-requestId'] + current.refreshToken).digest('hex')
    const secret = createHmac('sha256', headers['X-requestId']).update(hashKey).digest('hex').slice(0, 16)
    const bytes = Buffer.from(encoded, 'base64')
    const decipher = createDecipheriv('aes-128-gcm', Buffer.from(secret), bytes.subarray(0, 12))
    decipher.setAuthTag(bytes.subarray(-16))
    const plain = Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString()
    expect(plain).toBe('{"commands":[{"code":"switch_led","value":true}]}')
    const signed = ['X-appKey', 'X-requestId', 'X-time', 'X-token'].map(name => `${name}=${headers[name]}`).join('||') + encoded
    expect(headers['X-sign']).toBe(createHmac('sha256', hashKey).update(signed).digest('hex'))
  })
  it('surfaces the sharing API error message with code 2001', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: false, code: 2001, msg: 'function not supported' }) })
    const cloud = new SmartLifeCloud(fetcher as unknown as typeof fetch)
    await expect(cloud.sendCommands({ endpoint: 'https://example.invalid', accessToken: 'fixture', refreshToken: 'fixture',
      expiresAt: Date.now() + 3600000, uid: 'u', terminalId: 't' }, 'bulb', [{ code: 'switch_led', value: true }]))
      .rejects.toThrow('code=2001 msg=function not supported')
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

  it('does not probe or command a cloud-offline device and never displays cached on as live', async () => {
    const cloud = { registerHomes: vi.fn(), deviceStatus: vi.fn().mockResolvedValue({ switch_led: true }), deviceOnline: vi.fn().mockReturnValue(false), sendCommands: vi.fn() }
    const lan = { request: vi.fn() }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]])))
    await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', ip: device.ip, online: false }] }], session)
    expect(await service.getState('light-1')).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(lan.request).not.toHaveBeenCalled()
    expect(cloud.sendCommands).not.toHaveBeenCalled()
  })

  it('keeps saved cloud-offline devices off LAN when status fails until cloud confirms online', async () => {
    const cloud = { registerHomes: vi.fn(), deviceStatus: vi.fn().mockRejectedValue(new Error('status unavailable')),
      deviceOnline: vi.fn().mockReturnValue(undefined), sendCommands: vi.fn() }
    const lan = { request: vi.fn().mockResolvedValue({ '1': true }) }
    const scan = vi.fn().mockResolvedValue(new Map())
    const probe = vi.fn()
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient, scan, probe)
    await service.restore([{ id: 'home', name: 'Casa', devices: [
      { id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', ip: device.ip, online: false }
    ] }], session)
    expect(await service.getState('light-1')).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(lan.request).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    expect(cloud.sendCommands).not.toHaveBeenCalled()

    cloud.deviceStatus.mockResolvedValue({ switch_led: true })
    cloud.deviceOnline.mockReturnValue(true)
    expect(await service.getState('light-1')).toEqual({ on: true, online: true })
    expect(lan.request).toHaveBeenCalledOnce()
  })

  it('treats cloud 2001 as offline without retrying a rejected bundle', async () => {
    const cloud = { registerHomes: vi.fn(), deviceStatus: vi.fn().mockResolvedValue({ switch_led: true }),
      sendCommands: vi.fn().mockRejectedValue(new Error('Smart Life device request rejected code=2001 msg=device is offline')) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, { request: vi.fn() } as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: '', homeId: 'home' }] }], session)
    expect(await service.setLight('light-1', { on: true, brightness: 50 })).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
    expect(cloud.sendCommands).toHaveBeenCalledOnce()
    expect(await service.getState('light-1')).toEqual({ on: false, online: false, reason: 'sem energia ou fora da rede' })
  })

  it('backs off failed LAN attempts and keeps the version that previously answered', async () => {
    let now = 100_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const cloud = { registerHomes: vi.fn(), deviceStatus: vi.fn().mockRejectedValue(new Error('cloud unavailable')) }
      const lan = { request: vi.fn().mockResolvedValueOnce({ '1': true }).mockRejectedValue(new Error('socket offline')) }
      const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
        vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]])))
      await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', ip: device.ip }] }], session)
      expect(await service.getState('light-1')).toEqual({ on: true, online: true })
      expect(await service.getState('light-1')).toEqual({ on: false, online: false })
      expect(lan.request.mock.calls.map(call => call[0].version)).toEqual(['3.3', '3.3'])
      await service.getState('light-1')
      expect(lan.request).toHaveBeenCalledTimes(2)
      now += 5_000
      await service.getState('light-1')
      expect(lan.request.mock.calls.map(call => call[0].version)).toEqual(['3.3', '3.3', '3.3'])
    } finally { clock.mockRestore() }
  })

  it('keeps one LAN request in flight per device', async () => {
    let release!: (value: Record<string, unknown>) => void
    let active = 0
    let peak = 0
    const lan = { request: vi.fn().mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      const value = await new Promise<Record<string, unknown>>(resolve => { release = resolve })
      active--
      return value
    }) }
    const service = new TuyaService({ registerHomes: vi.fn() } as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]])))
    await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', ip: device.ip }] }])
    const first = service.getState('light-1')
    const second = service.getState('light-1')
    await vi.waitFor(() => expect(lan.request).toHaveBeenCalledTimes(1))
    release({ '1': true })
    await vi.waitFor(() => expect(lan.request).toHaveBeenCalledTimes(2))
    release({ '1': true })
    expect(await Promise.all([first, second])).toEqual([{ on: true, online: true }, { on: true, online: true }])
    expect(peak).toBe(1)
  })

  it('sends only power off and retries a non-offline rejected bundle one command at a time', async () => {
    const cloud = { registerHomes: vi.fn(), deviceStatus: vi.fn().mockResolvedValue({ switch_led: false, bright_value_v2: 505 }),
      sendCommands: vi.fn().mockRejectedValueOnce(new Error('bundle rejected')).mockResolvedValue(undefined) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, { request: vi.fn() } as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: '', homeId: 'home' }] }], session)
    // Cloud accepted the bundle but status still lags after a retry: requested state, flagged unconfirmed (never 'offline').
    expect(await service.setLight('light-1', { on: true, brightness: 50 })).toMatchObject({ on: true, brightness: 50, online: true, unconfirmed: true })
    expect(cloud.deviceStatus.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(cloud.sendCommands.mock.calls.map(call => call[2])).toEqual([
      [{ code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 505 }],
      [{ code: 'switch_led', value: true }], [{ code: 'bright_value_v2', value: 505 }]
    ])
    cloud.sendCommands.mockClear()
    expect(await service.setLight('light-1', { on: false, brightness: 20 })).toMatchObject({ on: false, online: true })
    expect(cloud.sendCommands.mock.calls[0][2]).toEqual([{ code: 'switch_led', value: false }])
  })

  it('keeps the last known light state stale during Smart Life rate limiting', async () => {
    const cloud = { registerHomes: vi.fn(), isRateLimited: vi.fn().mockReturnValue(true),
      deviceStatus: vi.fn().mockResolvedValueOnce({ switch_led: true }).mockRejectedValueOnce(new SmartLifeRateLimitError('code=-9999999')) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, {} as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    await service.restore([{ id: 'home', name: 'Casa', devices: [{ id: 'light', name: 'Luz', category: 'dj', localKey: '', homeId: 'home' }] }], session)
    expect(await service.getState('light')).toEqual({ on: true, online: true, viaCloud: true })
    expect(await service.getState('light')).toEqual({ on: true, online: true, viaCloud: true, stale: true })
  })
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
  it('confirms a cloud command on the second status read when the first one lags', async () => {
    const cloud = {
      listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', homeId: 'home' }
      ] }]),
      sendCommands: vi.fn().mockResolvedValue(undefined),
      deviceStatus: vi.fn().mockResolvedValueOnce({ switch_led: false }).mockResolvedValueOnce({ switch_led: true })
    }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, {} as TuyaLanClient, vi.fn().mockResolvedValue(new Map()))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toMatchObject({ on: true, online: true })
    expect(cloud.deviceStatus).toHaveBeenCalledTimes(2)
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

  it('falls back to Smart Life when a 3.5 LAN set fails', async () => {
    const cloud = {
      listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [
        { id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', dpMap: { switch_led: 20 } }
      ] }]),
      deviceStatus: vi.fn().mockResolvedValue({ switch_led: true }),
      sendCommands: vi.fn().mockResolvedValue(undefined)
    }
    const lan = { request: vi.fn().mockRejectedValue(new Error('offline')) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: '192.168.15.9', version: '3.5' }]])),
      vi.fn().mockResolvedValue([]))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: true, online: true, viaCloud: true })
    expect(cloud.sendCommands).toHaveBeenCalledWith(session, 'light-1', [{ code: 'switch_led', value: true }])
    expect(lan.request).toHaveBeenCalledTimes(1)
  })
  it('renegotiates 3.5 on a fresh request after ECONNRESET before cloud fallback', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', dpMap: { switch_led: 20 } }] }]),
      sendCommands: vi.fn() }
    const lan = { request: vi.fn().mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce({}).mockResolvedValueOnce({ '20': true }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.5' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toEqual({ on: true, online: true })
    expect(lan.request).toHaveBeenCalledTimes(3)
    expect(lan.request.mock.calls[0][0].version).toBe('3.5')
    expect(lan.request.mock.calls[1][0].version).toBe('3.5')
    expect(cloud.sendCommands).not.toHaveBeenCalled()
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
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', dpMap: { switch_led: 1, bright_value: 3 } }] }]) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '1': true, '3': 140 }) }
    const scan = vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]]))
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient, scan)
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 50 })).toEqual({ on: true, online: true, brightness: 50 })
    expect(lan.request.mock.calls[0][1]).toEqual({ '1': true, '3': 140 })
  })
  it('uses v2 DPs, scaling and HSV16 for a mapped bulb', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home',
      dpMap: { switch_led: 20, work_mode: 21, bright_value_v2: 22, temp_value_v2: 23, colour_data_v2: 24 } }] }]) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '20': true, '22': 505, '23': 500, '24': '000003e803e8' }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.5' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 50, temperature: 50, color: '#ff0000' }))
      .toMatchObject({ on: true, online: true, brightness: 50, temperature: 50, color: '#ff0000' })
    expect(lan.request.mock.calls[0][1]).toEqual({ '20': true, '21': 'colour', '22': 505, '23': 500, '24': '000003e803e8' })
  })
  it('confirms quantized v2 color and one-step brightness and temperature rounding', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home',
      dpMap: { switch_led: 20, bright_value_v2: 22, temp_value_v2: 23, colour_data_v2: 24 } }] }]),
      sendCommands: vi.fn().mockResolvedValue(undefined) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '20': true, '22': 505, '23': 504, '24': '00ef03e80161' }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.5' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 51, temperature: 51, color: '#00015a' }))
      .toEqual({ on: true, online: true, brightness: 50, temperature: 50, color: '#00025a' })
    expect(lan.request.mock.calls[0][1]).toEqual({ '20': true, '21': 'colour', '22': 515, '23': 510, '24': '00ef03e80161' })
    expect(cloud.sendCommands).not.toHaveBeenCalled()
  })
  it('uses legacy RGB8 color and 0 to 255 temperature', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home',
      dpMap: { switch_led: 1, work_mode: 2, temp_value: 4, colour_data: 5 } }] }]) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '1': true, '4': 128, '5': 'ff00000000ffff' }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, temperature: 50, color: '#ff0000' }))
      .toMatchObject({ on: true, temperature: 50, color: '#ff0000' })
    expect(lan.request.mock.calls[0][1]).toEqual({ '1': true, '2': 'colour', '4': 128, '5': 'ff00000000ffff' })
  })

  it('infers v2 from DP20 when discovery has no specification', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }] }]) }
    const lan = { request: vi.fn().mockResolvedValueOnce({ '20': false, '22': 10 }).mockResolvedValueOnce({}).mockResolvedValueOnce({ '20': true, '22': 505 }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 50 })).toMatchObject({ on: true, brightness: 50 })
    expect(lan.request.mock.calls[1][1]).toEqual({ '20': true, '22': 505 })
  })

  it('tries cloud immediately when a LAN reply does not confirm the requested state', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home', dpMap: { switch_led: 20 } }] }]),
      deviceStatus: vi.fn().mockResolvedValue({ switch_led: true }), sendCommands: vi.fn().mockResolvedValue(undefined) }
    const lan = { request: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ '20': false }) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.5' }]])))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true })).toMatchObject({ on: true, viaCloud: true })
    expect(cloud.sendCommands).toHaveBeenCalledOnce()
  })
  it('scales v2 color and brightness in queued cloud fallback', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home',
      cloudCodes: ['switch_led', 'bright_value_v2', 'work_mode', 'colour_data_v2'], dpMap: { switch_led: 20, bright_value_v2: 22, colour_data_v2: 24 } }] }]),
      deviceStatus: vi.fn().mockResolvedValue({ switch_led: true, bright_value_v2: 505, colour_data_v2: '{"h":0,"s":1000,"v":1000}' }),
      sendCommands: vi.fn().mockResolvedValue(undefined) }
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, { request: vi.fn() } as unknown as TuyaLanClient,
      vi.fn().mockResolvedValue(new Map()), vi.fn().mockResolvedValue([]))
    await service.discover(session)
    expect(await service.setLight('light-1', { on: true, brightness: 50, color: '#ff0000' }))
      .toMatchObject({ on: true, brightness: 50, color: '#ff0000', viaCloud: true })
    expect(cloud.sendCommands).toHaveBeenCalledWith(session, 'light-1', [
      { code: 'switch_led', value: true }, { code: 'bright_value_v2', value: 505 },
      { code: 'work_mode', value: 'colour' }, { code: 'colour_data_v2', value: '{"h":0,"s":1000,"v":1000}' }
    ])
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
