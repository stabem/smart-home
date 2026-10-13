import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'smart-home-store-'))
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

afterEach(() => { encryption.available = true })

describe('encrypted setup store', () => {
  it('persists secrets through safeStorage and refuses unencrypted saves', () => {
    const store = new SetupStore()
    encryption.available = false
    expect(() => store.save({ homes: [], acs: [] })).toThrow('OS encryption unavailable')
    encryption.available = true
    store.save({ homes: [{ id: 'h', name: 'Casa', devices: [{ id: 'd', name: 'Luz', category: 'dj', localKey: 'fake-local-key', homeId: 'h' }] }], acs: [] })
    expect(readFileSync(join(root, 'setup.enc'), 'utf8')).not.toContain('fake-local-key')
    expect(store.load()?.homes[0].devices[0].localKey).toBe('fake-local-key')
    unlinkSync(join(root, 'setup.enc'))
    rmdirSync(root)
  })
})
