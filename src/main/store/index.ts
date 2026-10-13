import { app, safeStorage } from 'electron'
import { config } from 'dotenv'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AirConditioner } from '../../shared/types'
import type { SmartLifeHome, SmartLifeSession } from '../tuya'

export interface SavedSetup {
  homes: SmartLifeHome[]
  acs: Pick<AirConditioner, 'id' | 'name'>[]
  acRoomIds?: Record<string, string>
  lightRoomIds?: Record<string, string>
  lgPat?: string
  lgCountry?: string
  smartLifeUserCode?: string
  smartLifeSession?: SmartLifeSession
}

export function loadEnvironment(): void {
  const candidates = [app.getAppPath(), dirname(process.execPath), process.cwd()]
  const path = candidates.map(dir => join(dir, '.env')).find(existsSync)
  if (path) config({ path })
}

export class SetupStore {
  private get path(): string { return join(app.getPath('userData'), 'setup.enc') }

  load(): SavedSetup | null {
    if (!existsSync(this.path)) return null
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')
    const plaintext = safeStorage.decryptString(Buffer.from(readFileSync(this.path, 'utf8'), 'base64'))
    const value: unknown = JSON.parse(plaintext)
    if (!value || typeof value !== 'object' || !('homes' in value) || !('acs' in value) ||
      !Array.isArray(value.homes) || !Array.isArray(value.acs)) throw new Error('Saved setup invalid')
    return value as SavedSetup
  }

  save(value: SavedSetup): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable')
    const encrypted = safeStorage.encryptString(JSON.stringify(value)).toString('base64')
    const temporary = `${this.path}.tmp`
    writeFileSync(temporary, encrypted, { mode: 0o600 })
    renameSync(temporary, this.path)
  }
}
