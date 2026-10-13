import { EventEmitter } from 'node:events'
import type { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { SmartLifeCloud, type SmartLifeSession } from './cloud'
import { TuyaService } from './index'
import { decodeBroadcast, packFrame, udpKey, unpackFrame, TuyaLanClient, type LanDevice } from './protocol'

const device: LanDevice = { id: 'light-1', ip: '192.168.1.20', localKey: 'abcdefghijklmnop', version: '3.3' }

describe('Tuya LAN', () => {
  it('reads legacy plaintext and authenticated 3.5 LAN announcements', () => {
    const announcement = Buffer.from('{"gwId":"light-1","ip":"192.168.1.20","version":"3.5"}')
    expect(decodeBroadcast(announcement)).toEqual({ id: 'light-1', ip: '192.168.1.20', version: '3.5' })
    expect(decodeBroadcast(packFrame('3.5', udpKey, 1, 19, announcement))).toEqual({ id: 'light-1', ip: '192.168.1.20', version: '3.5' })
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
})

describe('typed light service', () => {
  const session = {} as SmartLifeSession
  it('maps discovered LAN lights and keeps an unreachable light offline', async () => {
    const cloud = { listHomes: vi.fn().mockResolvedValue([{ id: 'home', name: 'Casa', devices: [{ id: 'light-1', name: 'Lamp', category: 'dj', localKey: device.localKey, homeId: 'home' }] }]) }
    const lan = { request: vi.fn().mockRejectedValue(new Error('socket failed')) }
    const scan = vi.fn().mockResolvedValue(new Map([['light-1', { id: 'light-1', ip: device.ip, version: '3.3' }]]))
    const service = new TuyaService(cloud as unknown as SmartLifeCloud, lan as unknown as TuyaLanClient, scan)
    const homes = await service.discover(session)
    expect(homes[0].devices[0].ip).toBe(device.ip)
    expect(await service.getState('light-1')).toEqual({ on: false, online: false })
    expect(lan.request).toHaveBeenCalledWith(expect.objectContaining({ id: 'light-1', version: '3.3' }))
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
})
