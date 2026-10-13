import type { AirConditioner, DeviceCommand, Room, SetupStatus } from '../shared/types'
import { LgClient } from './lg/client'
import { SetupStore, type SavedSetup } from './store'
import { SmartLifeCloud, TuyaService, type SmartLifeHome, type SmartLifeSession } from './tuya'

const acRoomNames = ['Sala de estar', 'Office', 'Quarto']
const offlineAc = { on: false, targetTemperature: 23, online: false }

function acRoom(name: string): string | undefined {
  const normalized = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
  return acRoomNames.find(room => normalized.includes(room.toLocaleLowerCase()))
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

function roomList(homes: SmartLifeHome[], acs: Pick<AirConditioner, 'id' | 'name'>[], acRoomIds: Record<string, string> = {}): Room[] {
  const rooms = new Map<string, Room>()
  for (const home of homes) for (const device of home.devices) {
    if (!['dj', 'kg', 'cz'].includes(device.category) || !device.localKey) continue
    const name = device.roomName || 'Sem cômodo'
    const id = `${home.id}:${device.roomId || name}`
    if (!rooms.has(id)) rooms.set(id, { id, name, lights: [], acs: [] })
    rooms.get(id)!.lights.push({ id: device.id, name: device.name, state: { on: false, online: false } })
  }
  for (const ac of acs) {
    const name = acRoom(ac.name) || 'Sem cômodo'
    let room = [...rooms.values()].find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (!room) {
      room = { id: `lg:${name}`, name, lights: [], acs: [] }
      rooms.set(room.id, room)
    }
  }
  for (const ac of acs) {
    const name = acRoom(ac.name) || 'Sem cômodo'
    const room = rooms.get(acRoomIds[ac.id]) || [...rooms.values()].find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())!
    room.acs.push({ ...ac, state: offlineAc })
  }
  return [...rooms.values()].filter(room => room.lights.length || room.acs.length)
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

  constructor(
    private readonly store = new SetupStore(),
    private readonly cloud = new SmartLifeCloud(),
    private readonly tuya = new TuyaService(),
    lg?: LgClient | null
  ) {
    this.saved = store.load()
    this.lgPat = this.saved?.lgPat || process.env.LG_PAT
    this.lgCountry = this.saved?.lgCountry || process.env.LG_COUNTRY || 'BR'
    this.lg = lg === undefined ? (this.lgPat ? new LgClient(this.lgPat, this.lgCountry) : null) : lg
    this.session = this.saved?.smartLifeSession || null
    this.ready = this.saved ? this.tuya.restore(this.saved.homes) : Promise.resolve()
  }

  status(): SetupStatus {
    return { configured: this.saved !== null, lgTokenConfigured: this.lg !== null,
      tuyaKeysConfigured: !!this.saved?.homes.some(home => home.devices.some(device => !!device.localKey)),
      smartLifeUserCodeConfigured: !!(this.saved?.smartLifeUserCode || process.env.USER_CODE_SMARTLIFE) }
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
    this.draft = { homes, acs: acs.map(({ id, name }) => ({ id, name })) }
    return roomList(this.draft.homes, this.draft.acs)
  }

  async save(acRoomIds: unknown = {}): Promise<void> {
    if (!this.draft) throw new Error('Busque dispositivos antes de salvar')
    if (!acRoomIds || typeof acRoomIds !== 'object' || Array.isArray(acRoomIds)) throw new Error('Invalid AC room mapping')
    const mapping = acRoomIds as Record<string, unknown>
    const validRooms = new Set(roomList(this.draft.homes, this.draft.acs).map(room => room.id))
    const validAcs = new Set(this.draft.acs.map(ac => ac.id))
    for (const [acId, roomId] of Object.entries(mapping)) {
      if (!validAcs.has(acId) || typeof roomId !== 'string' || !validRooms.has(roomId)) throw new Error('Invalid AC room mapping')
    }
    this.draft.acRoomIds = mapping as Record<string, string>
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
    const rooms = roomList(this.saved.homes, this.saved.acs, this.saved.acRoomIds)
    await Promise.all(rooms.flatMap(room => [
      ...room.lights.map(async light => { light.state = await this.tuya.getState(light.id) }),
      ...room.acs.map(ac => this.acState(ac))
    ]))
    return rooms
  }

  private async acState(ac: AirConditioner): Promise<void> {
    if (!this.lg) return
    ac.state = await this.lg.getAcState(ac.id).catch(() => offlineAc)
  }

  async command(command: unknown): Promise<void> {
    if (!isDeviceCommand(command)) throw new Error('Invalid device command')
    if (!this.saved) throw new Error('Configure devices before sending commands')
    await this.ready
    const rooms = roomList(this.saved.homes, this.saved.acs, this.saved.acRoomIds)
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
    if (ac && this.lg && (command.kind === 'ac.power' || command.kind === 'ac.temperature' || command.kind === 'ac.mode' || command.kind === 'ac.fan' || command.kind === 'ac.turbo')) {
      const patch = command.kind === 'ac.power' ? { on: command.on }
        : command.kind === 'ac.temperature' ? { targetTemperature: command.temperature }
          : command.kind === 'ac.mode' ? { mode: command.mode }
            : command.kind === 'ac.fan' ? { fan: command.fan }
              : { turbo: command.on }
      await this.lg.setAc(ac.id, patch)
      return
    }
    throw new Error('Device not found')
  }
}
