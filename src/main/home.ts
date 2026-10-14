import type { AirConditioner, DeviceCommand, Light, Room, SetupStatus } from '../shared/types'
import { LgClient } from './lg/client'
import { SetupStore, type SavedSetup } from './store'
import { app } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { SmartLifeCloud, TuyaService, confirms, type SmartLifeHome, type SmartLifeSession } from './tuya'
import { applyLightGroups, suggestLightGroups, validateLightGroups } from './light-groups'
import type { LightGroup, LightState } from '../shared/types'
import { gangDefault, houseRooms, matchingRoom, normalized, roomName } from './house-defaults'

const offlineAc = { on: false, targetTemperature: 23, online: false }

function acRoom(name: string): string | undefined {
  return matchingRoom(name)
}

function deviceRoom(name: string, smartLifeRoom: string | undefined, home: SmartLifeHome): string {
  const available = [...houseRooms, ...home.devices.flatMap(device => device.roomName?.trim() ? [roomName(device.roomName)] : [])]
  return smartLifeRoom?.trim() ? roomName(smartLifeRoom) : matchingRoom(name, available) ?? 'Sem cômodo'
}

function deviceRoomId(home: SmartLifeHome, room: string, roomId?: string): string {
  const matching = home.devices.find(device => device.roomId && device.roomName && normalized(roomName(device.roomName)) === normalized(room))
  return `${home.id}:${roomId || matching?.roomId || room}`
}

function isDeviceCommand(value: unknown): value is DeviceCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const command = value as Record<string, unknown>
  if (typeof command.deviceId !== 'string' || !command.deviceId.trim()) return false
  switch (command.kind) {
    case 'light.power':
    case 'ac.power': return typeof command.on === 'boolean'
    case 'light.brightness': return Number.isInteger(command.brightness) && Number(command.brightness) >= 1 && Number(command.brightness) <= 100
    case 'light.temperature': return Number.isInteger(command.temperature) && Number(command.temperature) >= 0 && Number(command.temperature) <= 100
    case 'ac.temperature': return Number.isInteger(command.temperature) && Number(command.temperature) >= 16 && Number(command.temperature) <= 30
    case 'ac.mode': return typeof command.mode === 'string' && ['Resfriar', 'Seco', 'Ventilar', 'Auto'].includes(command.mode)
    case 'ac.fan': return typeof command.fan === 'string' && ['Auto', 'Baixa', 'Média', 'Alta'].includes(command.fan)
    case 'ac.turbo': return typeof command.on === 'boolean'
    case 'light.color': return typeof command.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(command.color)
    default: return false
  }
}

function roomList(homes: SmartLifeHome[], acs: Pick<AirConditioner, 'id' | 'name'>[], acRoomIds: Record<string, string> = {}, lightRoomIds: Record<string, string> = {}, lightNames: Record<string, string> = {}, includeEmpty = false): Room[] {
  const rooms = new Map<string, Room>()
  for (const home of homes) for (const device of home.devices) {
    if (!['dj', 'kg', 'cz'].includes(device.category) || !device.localKey) continue
    const name = deviceRoom(device.name, device.roomName, home)
    const id = deviceRoomId(home, name, device.roomId)
    if (!rooms.has(id)) rooms.set(id, { id, name, lights: [], acs: [] })
  }
  for (const home of homes) for (const device of home.devices) for (const channel of device.category === 'dj' ? [{ dp: 1 }] : device.channels ?? []) {
    const name = gangDefault(device.name, channel.dp, device.category)?.room
    if (name && ![...rooms.values()].some(room => room.id.startsWith(`${home.id}:`) && normalized(room.name) === normalized(name))) {
      rooms.set(`${home.id}:${name}`, { id: `${home.id}:${name}`, name, lights: [], acs: [] })
    }
  }
  for (const ac of acs) {
    const name = acRoom(ac.name) || 'Sem cômodo'
    if (![...rooms.values()].some(room => normalized(room.name) === normalized(name))) {
      rooms.set(`lg:${name}`, { id: `lg:${name}`, name, lights: [], acs: [] })
    }
  }
  for (const home of homes) for (const device of home.devices) {
    if (!['dj', 'kg', 'cz'].includes(device.category) || !device.localKey) continue
    const name = deviceRoom(device.name, device.roomName, home)
    const id = deviceRoomId(home, name, device.roomId)
    const channels = device.category === 'dj' ? [] : device.channels?.length ? device.channels : [{ dp: 1, name: device.name }]
    const lights = device.category === 'dj'
      ? [{ id: device.id, name: device.name, state: { on: false, online: false } }]
      : channels.map(channel => ({ id: channel.dp === 1 ? device.id : `${device.id}::${channel.dp}`,
        name: /^Canal \d+$/i.test(channel.name) ? `${device.name} ${channel.dp}` : channel.name,
        switchOnly: true, state: { on: false, online: false } }))
    for (const light of lights) {
      const dp = light.id === device.id ? 1 : Number(light.id.slice(device.id.length + 2))
      const fallback = gangDefault(device.name, dp, device.category)
      const preferred = fallback?.room ? [...rooms.values()].find(room => room.id.startsWith(`${home.id}:`) && normalized(room.name) === normalized(fallback.room!)) : undefined
      const target = rooms.get(lightRoomIds[light.id]) ?? preferred ?? rooms.get(id)!
      target.lights.push({ ...light, name: lightNames[light.id] || fallback?.name || light.name })
    }
  }
  for (const ac of acs) {
    const name = acRoom(ac.name) || 'Sem cômodo'
    const room = rooms.get(acRoomIds[ac.id]) || [...rooms.values()].find(item => normalized(item.name) === normalized(name))!
    room.acs.push({ ...ac, state: offlineAc })
  }
  return [...rooms.values()].filter(room => includeEmpty || room.lights.length || room.acs.length)
}

function fillHouseDefaults(setup: SavedSetup): { setup: SavedSetup; changed: boolean } {
  const rooms = roomList(setup.homes, setup.acs, setup.acRoomIds, setup.lightRoomIds, setup.lightNames, true)
  const locations = new Map(rooms.flatMap(room => room.lights.map(light => [light.id, room.id] as const)))
  const lightRoomIds = { ...setup.lightRoomIds }
  const lightNames = { ...setup.lightNames }
  let changed = false
  for (const home of setup.homes) for (const device of home.devices) {
    if (!['dj', 'kg', 'cz'].includes(device.category) || !device.localKey) continue
    const channels = device.category === 'dj' ? [] : device.channels?.length ? device.channels : [{ dp: 1, name: device.name }]
    for (const channel of device.category === 'dj' ? [{ dp: 1, name: device.name }] : channels) {
      const id = device.category === 'dj' || channel.dp === 1 ? device.id : `${device.id}::${channel.dp}`
      const location = locations.get(id)
      if (!location) continue
      const gang = gangDefault(device.name, channel.dp, device.category)
      if (gang?.name && !lightNames[id]?.trim()) { lightNames[id] = gang.name; changed = true }
      if ((gang?.room || !device.roomName?.trim() && matchingRoom(device.name,
        [...houseRooms, ...home.devices.flatMap(item => item.roomName?.trim() ? [roomName(item.roomName)] : [])])) && !lightRoomIds[id]?.trim()) {
        lightRoomIds[id] = location
        changed = true
      }
    }
  }
  return { setup: changed ? { ...setup, lightRoomIds, lightNames } : setup, changed }
}

export class HomeController {
  private saved: SavedSetup | null
  private draft: SavedSetup | null = null
  private qrToken: string | null = null
  private loginUserCode: string | null = null
  private session: SmartLifeSession | null = null
  private readonly lgPat: string | undefined
  private readonly lgCountry: string
  private readonly lg: LgClient | null
  private readonly ready: Promise<void>
  private groupFailures: Record<string, string[]> = {}

  constructor(
    private readonly store = new SetupStore(),
    private readonly cloud = new SmartLifeCloud(),
    private readonly tuya = new TuyaService(),
    lg?: LgClient | null
  ) {
    const loaded = store.load()
    const defaults = loaded && fillHouseDefaults(loaded)
    this.saved = defaults?.setup ?? null
    if (defaults?.changed) store.save(defaults.setup)
    this.lgPat = this.saved?.lgPat || process.env.LG_PAT
    this.lgCountry = this.saved?.lgCountry || process.env.LG_COUNTRY || 'BR'
    this.lg = lg === undefined ? (this.lgPat ? new LgClient(this.lgPat, this.lgCountry) : null) : lg
    this.session = this.saved?.smartLifeSession || null
    this.tuya.onAddressesChanged?.(homes => { if (this.saved?.homes === homes) this.store.save(this.saved) })
    this.ready = this.saved ? this.tuya.restore(this.saved.homes, this.session) : Promise.resolve()
  }

  status(): SetupStatus {
    return { configured: this.saved !== null, lgTokenConfigured: this.lg !== null,
      tuyaKeysConfigured: !!this.saved?.homes.some(home => home.devices.some(device => !!device.localKey)),
      smartLifeUserCodeConfigured: !!(this.saved?.smartLifeUserCode || process.env.USER_CODE_SMARTLIFE),
      smartLifeConnected: !!this.saved?.smartLifeSession && this.saved.smartLifeSession.expiresAt > Date.now(),
      syncGuard: this.saved?.syncGuard !== false }
  }

  async beginLogin(userCode?: unknown): Promise<string> {
    if (userCode !== undefined && typeof userCode !== 'string') throw new Error('Invalid Smart Life user code')
    const selectedCode = (userCode as string | undefined)?.trim() || this.saved?.smartLifeUserCode || process.env.USER_CODE_SMARTLIFE
    if (!selectedCode) throw new Error('Smart Life user code required')
    const { token, qrUri } = await this.cloud.startLogin(selectedCode)
    this.qrToken = token
    this.loginUserCode = selectedCode
    this.session = null
    return qrUri
  }

  async discover(): Promise<Room[]> {
    if (!this.lg) throw new Error('Token LG não configurado')
    if (!this.session) {
      if (!this.qrToken) throw new Error('Leia o QR code primeiro')
      this.session = await this.cloud.pollLogin(this.qrToken, this.loginUserCode || undefined)
      if (!this.session) throw new Error('Aguardando leitura do QR code no Smart Life')
      this.qrToken = null
    }
    const [homes, acs] = await Promise.all([this.tuya.discover(this.session), this.lg.listAcs()])
    this.draft = { ...this.saved, homes, acs: acs.map(({ id, name }) => ({ id, name })),
      smartLifeSession: this.session ?? undefined, smartLifeUserCode: this.loginUserCode || this.saved?.smartLifeUserCode }
    this.draft = fillHouseDefaults(this.draft).setup
    return roomList(this.draft.homes, this.draft.acs, this.draft.acRoomIds, this.draft.lightRoomIds, this.draft.lightNames)
  }

  async reconnectSmartLife(): Promise<void> {
    if (!this.saved || !this.qrToken) throw new Error('Leia o QR code primeiro')
    const session = await this.cloud.pollLogin(this.qrToken, this.loginUserCode || undefined)
    if (!session) throw new Error('Aguardando leitura do QR code no Smart Life')
    await this.ready
    const updated: SavedSetup = { ...this.saved, smartLifeSession: session,
      smartLifeUserCode: this.loginUserCode || this.saved.smartLifeUserCode }
    this.store.save(updated)
    this.saved = updated
    this.session = session
    this.qrToken = null
    await this.tuya.restore(this.saved.homes, session)
  }

  async save(assignments: unknown = {}, groups?: unknown): Promise<void> {
    if (!this.draft) throw new Error('Busque dispositivos antes de salvar')
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) throw new Error('Invalid room mapping')
    const mapping = assignments as Record<string, unknown>
    const validRooms = new Set(roomList(this.draft.homes, this.draft.acs).map(room => room.id))
    const validAcs = new Set(this.draft.acs.map(ac => ac.id))
    const validLights = new Set(roomList(this.draft.homes, this.draft.acs).flatMap(room => room.lights.map(light => light.id)))
    for (const [deviceId, roomId] of Object.entries(mapping)) {
      if ((!validAcs.has(deviceId) && !validLights.has(deviceId)) || typeof roomId !== 'string' || !validRooms.has(roomId)) throw new Error('Invalid room mapping')
    }
    this.draft.acRoomIds = { ...this.draft.acRoomIds, ...Object.fromEntries(Object.entries(mapping).filter(([id]) => validAcs.has(id))) as Record<string, string> }
    this.draft.lightRoomIds = { ...this.draft.lightRoomIds, ...Object.fromEntries(Object.entries(mapping).filter(([id]) => validLights.has(id))) as Record<string, string> }
    const assignedRooms = roomList(this.draft.homes, this.draft.acs, this.draft.acRoomIds, this.draft.lightRoomIds)
    this.draft.lightGroups = validateLightGroups(groups ?? suggestLightGroups(assignedRooms), assignedRooms)
    this.draft.groupLastState = {}
    this.draft.syncGuard = true
    this.draft.lgPat = this.lgPat
    this.draft.lgCountry = this.lgCountry
    this.draft.smartLifeUserCode = this.loginUserCode || this.saved?.smartLifeUserCode || process.env.USER_CODE_SMARTLIFE
    this.draft.smartLifeSession = this.session || undefined
    this.store.save(this.draft)
    this.saved = this.draft
    this.draft = null
  }

  async rooms(): Promise<Room[]> {
    if (!this.saved) return []
    await this.ready
    const rooms = roomList(this.saved.homes, this.saved.acs, this.saved.acRoomIds, this.saved.lightRoomIds, this.saved.lightNames)
    await Promise.all(rooms.flatMap(room => [
      ...room.lights.map(async light => { light.state = await this.tuya.getState(light.id) }),
      ...room.acs.map(ac => this.acState(ac))
    ]))
    const groups = this.groups(rooms)
    if (this.saved.syncGuard !== false) await this.reapplyDrift(rooms, groups)
    const singles = rooms.flatMap(room => room.lights.map(light => ({ ...light, state: { ...light.state } })))
    const grouped = applyLightGroups(rooms, groups, this.groupFailures)
    void this.writeInventory(grouped, groups, singles)
    return grouped
  }

  /** Human-readable house inventory (names, rooms, groups, state) for support. Never keys or tokens. */
  private async writeInventory(rooms: Room[], groups: LightGroup[], ungrouped: Light[]): Promise<void> {
    const devices = new Map(this.saved?.homes.flatMap(home => home.devices).map(device => [device.id, device]) ?? [])
    const singles = new Map(ungrouped.map(light => [light.id, light]))
    const path = (state: LightState): string => state.viaCloud ? 'nuvem' : state.online ? 'wifi' : 'offline'
    const lines = [`# Casa — inventário (${new Date().toLocaleString('pt-BR')})`, '']
    for (const room of rooms) {
      lines.push(`## ${room.name}`)
      for (const light of room.lights) {
        const device = devices.get(light.id.split(':')[0])
        const kind = light.memberIds ? `grupo de ${light.memberIds.length}` : device?.category === 'dj' ? 'lâmpada' : 'interruptor'
        lines.push(`- ${light.name} [${kind}] id=${light.id} smartlife="${device?.name ?? '?'}" sala-smartlife="${device?.roomName ?? '?'}" ${light.state.on ? 'ligada' : 'desligada'} via ${path(light.state)}`)
        for (const member of light.memberIds ?? []) {
          const single = singles.get(member)
          const device = devices.get(member.split(':')[0])
          lines.push(`    - membro ${member} smartlife="${device?.name ?? '?'}" sala-smartlife="${device?.roomName ?? '?'}" ${single?.state.on ? 'ligada' : 'desligada'} via ${single ? path(single.state) : '?'}`)
        }
      }
      for (const ac of room.acs) lines.push(`- ${ac.name} [ar] id=${ac.id} ${ac.state.online ? 'online via nuvem (LG ThinQ)' : 'offline'}`)
      lines.push('')
    }
    lines.push('## Grupos', ...groups.map(group => `- ${group.name} (${group.roomId}): ${group.memberIds.join(', ')}`))
    try { await writeFile(join(app.getPath('userData'), 'inventario.md'), lines.join('\n'), 'utf8') } catch { /* support file only */ }
  }

  private groups(rooms: Room[]): LightGroup[] {
    return this.saved?.lightGroups ?? suggestLightGroups(rooms)
  }

  private async setGroupMember(id: string, patch: Partial<LightState>): Promise<LightState> {
    let last: unknown
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const state = await this.tuya.setLight(id, patch)
        if (confirms(state, patch)) return state
        last = new Error('offline after LAN and cloud control')
      } catch (error) { last = error }
      const message = last instanceof Error ? last.message : 'unknown'
      const secrets = [this.saved?.lgPat, this.saved?.smartLifeSession?.accessToken, this.saved?.smartLifeSession?.refreshToken,
        ...this.saved?.homes.flatMap(home => home.devices.map(device => device.localKey)) ?? []].filter((value): value is string => !!value)
      console.warn(`Group member id=${id} attempt=${attempt} failed: ${secrets.reduce((safe, secret) => safe.replaceAll(secret, '[redacted]'), message).replace(/[\r\n]+/g, ' ')}`)
    }
    throw last
  }

  private async reapplyDrift(rooms: Room[], groups: LightGroup[]): Promise<void> {
    for (const group of groups) {
      const desired = this.saved?.groupLastState?.[group.id]
      if (!desired) continue
      const members = rooms.flatMap(room => room.lights).filter(light => group.memberIds.includes(light.id))
      const patch = Object.fromEntries(Object.entries(desired).filter(([key]) => ['on', 'brightness', 'color', 'temperature'].includes(key))) as Partial<LightState>
      const drifted = members.filter(light => light.state.online && !light.state.stale && !confirms(light.state, patch))
        .sort((a, b) => Number(!!this.tuya.hasLan?.(b.id)) - Number(!!this.tuya.hasLan?.(a.id)))
      const results = []
      for (const light of drifted) results.push(await Promise.allSettled([this.setGroupMember(light.id, patch)]).then(([result]) => result))
      this.groupFailures[group.id] = results.flatMap((result, index) => result.status === 'rejected' || !result.value.online ? [drifted[index].name] : [])
      results.forEach((result, index) => { if (result.status === 'fulfilled' && result.value.online) drifted[index].state = result.value })
    }
  }

  setSyncGuard(enabled: unknown): void {
    if (typeof enabled !== 'boolean' || !this.saved) throw new Error('Invalid sync guard')
    this.saved = { ...this.saved, syncGuard: enabled }
    this.store.save(this.saved)
  }

  groupSetup(): { rooms: Room[]; groups: LightGroup[] } {
    if (!this.saved) throw new Error('Configure devices first')
    const source = this.draft ?? this.saved
    const rooms = roomList(source.homes, source.acs, source.acRoomIds, source.lightRoomIds, source.lightNames, true)
    const ids = new Set(rooms.flatMap(room => room.lights.map(light => light.id)))
    return { rooms, groups: (source.lightGroups ?? suggestLightGroups(rooms)).filter(group => group.memberIds.every(id => ids.has(id))) }
  }

  saveHomeEdits(assignments: unknown, names: unknown, groups: unknown): void {
    if (!this.saved) throw new Error('Configure devices first')
    if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments) ||
      !names || typeof names !== 'object' || Array.isArray(names)) throw new Error('Invalid home edits')
    const source = this.draft ?? this.saved
    const base = roomList(source.homes, source.acs, {}, {}, {}, true)
    const roomIds = new Set(base.map(room => room.id))
    const lightIds = new Set(base.flatMap(room => room.lights.map(light => light.id)))
    const acIds = new Set(source.acs.map(ac => ac.id))
    const mapping = assignments as Record<string, unknown>
    const labels = names as Record<string, unknown>
    for (const [id, roomId] of Object.entries(mapping)) {
      if ((!lightIds.has(id) && !acIds.has(id)) || typeof roomId !== 'string' || !roomIds.has(roomId)) throw new Error('Invalid room mapping')
    }
    for (const [id, name] of Object.entries(labels)) {
      if (!lightIds.has(id) || typeof name !== 'string' || !name.trim() || name.trim().length > 80) throw new Error('Invalid light name')
    }
    const next: SavedSetup = { ...source,
      acRoomIds: Object.fromEntries(Object.entries(mapping).filter(([id]) => acIds.has(id))) as Record<string, string>,
      lightRoomIds: Object.fromEntries(Object.entries(mapping).filter(([id]) => lightIds.has(id))) as Record<string, string>,
      lightNames: Object.fromEntries(Object.entries(labels).map(([id, name]) => [id, (name as string).trim()])) }
    const rooms = roomList(next.homes, next.acs, next.acRoomIds, next.lightRoomIds, next.lightNames)
    next.lightGroups = validateLightGroups(groups, rooms)
    const groupIds = new Set(next.lightGroups.map(group => group.id))
    next.groupLastState = Object.fromEntries(Object.entries(next.groupLastState ?? {}).filter(([id]) => groupIds.has(id)))
    this.store.save(next)
    this.saved = next
    this.draft = null
  }

  saveLightGroups(value: unknown): void {
    if (!this.saved) throw new Error('Configure devices first')
    const rooms = roomList(this.saved.homes, this.saved.acs, this.saved.acRoomIds, this.saved.lightRoomIds, this.saved.lightNames)
    const groups = validateLightGroups(value, rooms)
    const ids = new Set(groups.map(group => group.id))
    this.saved = { ...this.saved, lightGroups: groups,
      groupLastState: Object.fromEntries(Object.entries(this.saved.groupLastState ?? {}).filter(([id]) => ids.has(id))) }
    this.store.save(this.saved)
  }

  private async acState(ac: AirConditioner): Promise<void> {
    if (!this.lg) return
    ac.state = await this.lg.getAcState(ac.id).catch(() => offlineAc)
  }

  async command(command: unknown): Promise<void> {
    if (!isDeviceCommand(command)) throw new Error('Invalid device command')
    if (!this.saved) throw new Error('Configure devices before sending commands')
    await this.ready
    const rooms = roomList(this.saved.homes, this.saved.acs, this.saved.acRoomIds, this.saved.lightRoomIds, this.saved.lightNames)
    const light = rooms.flatMap(room => room.lights).find(item => item.id === command.deviceId)
    const ac = rooms.flatMap(room => room.acs).find(item => item.id === command.deviceId)
    if ((command.kind === 'light.power' || command.kind === 'light.brightness' || command.kind === 'light.color' || command.kind === 'light.temperature') && light) {
      const patch = command.kind === 'light.power' ? { on: command.on }
        : command.kind === 'light.brightness' ? { brightness: command.brightness }
          : command.kind === 'light.color' ? { color: command.color } : { temperature: command.temperature }
      const state = await this.tuya.setLight(light.id, patch)
      if (!state.online) throw new Error('Device offline')
      return
    }
    const group = this.groups(rooms).find(item => item.id === command.deviceId)
    if (group && (command.kind === 'light.power' || command.kind === 'light.brightness' || command.kind === 'light.color' || command.kind === 'light.temperature')) {
      const patch = command.kind === 'light.power' ? { on: command.on }
        : command.kind === 'light.brightness' ? { brightness: command.brightness }
          : command.kind === 'light.color' ? { color: command.color } : { temperature: command.temperature }
      const members = rooms.flatMap(room => room.lights).filter(item => group.memberIds.includes(item.id))
        .sort((a, b) => Number(!!this.tuya.hasLan?.(b.id)) - Number(!!this.tuya.hasLan?.(a.id)))
      const results = []
      for (const member of members) results.push(await Promise.allSettled([this.setGroupMember(member.id, patch)]).then(([result]) => result))
      const failed = results.flatMap((result, index) => result.status === 'rejected' || !result.value.online ? [members[index].name] : [])
      this.groupFailures[group.id] = failed
      this.saved.groupLastState = { ...this.saved.groupLastState, [group.id]: { ...this.saved.groupLastState?.[group.id], ...patch } }
      this.store.save(this.saved)
      if (failed.length) throw new Error(`Falha em: ${failed.join(', ')}`)
      return
    }
    if (ac && this.lg && (command.kind === 'ac.power' || command.kind === 'ac.temperature' || command.kind === 'ac.mode' || command.kind === 'ac.fan' || command.kind === 'ac.turbo')) {
      const patch = command.kind === 'ac.power' ? { on: command.on }
        : command.kind === 'ac.temperature' ? { targetTemperature: command.temperature }
          : command.kind === 'ac.mode' ? { mode: command.mode }
            : command.kind === 'ac.fan' ? { fan: command.fan }
              : { turbo: command.on }
      try { await this.lg.setAc(ac.id, patch) }
      catch (error) {
        console.error(`LG AC control failed id=${ac.id}: ${error instanceof Error ? error.message : 'UnknownError'}`)
        throw error
      }
      return
    }
    throw new Error('Device not found')
  }
}
