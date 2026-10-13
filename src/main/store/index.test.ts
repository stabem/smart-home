import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string
const encryption = { available: true }
vi.mock('electron', () => ({
  app: { getPath: () => root },
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    encryptString: (value: string) => Buffer.from(`cipher:${value}`),
    decryptString: (value: Buffer) => value.toString().replace(/^cipher:/, '')
  }
}))
import { SetupStore } from './index'

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'smart-home-store-')) })
afterEach(() => { encryption.available = true; rmSync(root, { recursive: true, force: true }) })

describe('encrypted setup store', () => {
  it('persists secrets through safeStorage and refuses unencrypted saves', () => {
    const store = new SetupStore()
    encryption.available = false
    expect(() => store.save({ homes: [], acs: [] })).toThrow('OS encryption unavailable')
    encryption.available = true
    store.save({ homes: [{ id: 'h', name: 'Casa', devices: [{ id: 'd', name: 'Luz', category: 'dj', localKey: 'fake-local-key', homeId: 'h' }] }], acs: [] })
    expect(readFileSync(join(root, 'setup.enc'), 'utf8')).not.toContain('fake-local-key')
    expect(store.load()?.homes[0].devices[0].localKey).toBe('fake-local-key')
  })

  it('round-trips credentials through safeStorage without writing them as plaintext', () => {
    const store = new SetupStore()
    const setup = { homes: [], acs: [], lgPat: 'fake-lg-pat', lgCountry: 'BR',
      smartLifeUserCode: 'fake-user-code', smartLifeSession: {
        endpoint: 'https://example.invalid', accessToken: 'fake-access-token', refreshToken: 'fake-refresh-token',
        expiresAt: 9999999999999, uid: 'fake-uid', terminalId: 'fake-terminal'
      } }
    store.save(setup)
    const ciphertext = readFileSync(join(root, 'setup.enc'), 'utf8')
    for (const secret of ['fake-lg-pat', 'fake-user-code', 'fake-access-token', 'fake-refresh-token']) {
      expect(ciphertext).not.toContain(secret)
    }
    expect(store.load()).toEqual(setup)
  })

  it('loads an existing setup file without credential fields', () => {
    const store = new SetupStore()
    store.save({ homes: [], acs: [] })
    expect(store.load()).toEqual({ homes: [], acs: [] })
  })
})
