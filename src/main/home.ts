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

function roomList(homes: SmartLifeHome[], acs: Pick<AirConditioner, 'id' | 'name'>[]): Room[] {
  const rooms = new Map<string, Room>()
  for (const home of homes) for (const device of home.devices) {
    if (!['dj', 'kg', 'cz'].includes(device.category) || !device.localKey) continue
    const name = device.roomName || 'Sem cômodo'
    const id = `${home.id}:${device.roomId || name}`
    if (!rooms.has(id)) rooms.set(id, { id, name, lights: [] })
    rooms.get(id)!.lights.push({ id: device.id, name: device.name, state: { on: false, online: false } })
  }
  for (const ac of acs) {
    const name = acRoom(ac.name)
    if (!name) continue
    let room = [...rooms.values()].find(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
    if (!room) {
      room = { id: `lg:${name}`, name, lights: [] }
      rooms.set(room.id, room)
    }
    room.ac = { ...ac, state: offlineAc }
  }
  return [...rooms.values()]
}

export class HomeController {
  private saved: SavedSetup | null
  private draft: SavedSetup | null = null
  private qrToken: string | null = null
  private session: SmartLifeSession | null = null
  private readonly lg: LgClient | null
  private readonly ready: Promise<void>

  constructor(
    private readonly store = new SetupStore(),
    private readonly cloud = new SmartLifeCloud(),
    private readonly tuya = new TuyaService(),
    lg?: LgClient | null
  ) {
    this.saved = store.load()
    this.lg = lg === undefined ? (process.env.LG_PAT ? new LgClient(process.env.LG_PAT, process.env.LG_COUNTRY || 'BR') : null) : lg
    this.ready = this.saved ? this.tuya.restore(this.saved.homes) : Promise.resolve()
  }

  status(): SetupStatus {
    return { configured: this.saved !== null, lgTokenConfigured: this.lg !== null,
      tuyaKeysConfigured: !!this.saved?.homes.some(home => home.devices.some(device => !!device.localKey)) }
  }

  async beginLogin(): Promise<string> {
    const { token, qrUri } = await this.cloud.startLogin(process.env.USER_CODE_SMARTLIFE)
    this.qrToken = token
    this.session = null
    return qrUri
  }

  async discover(): Promise<Room[]> {
    if (!this.lg) throw new Error('Token LG não configurado')
    if (!this.session) {
      if (!this.qrToken) throw new Error('Leia o QR code primeiro')
      this.session = await this.cloud.pollLogin(this.qrToken, process.env.USER_CODE_SMARTLIFE)
      if (!this.session) throw new Error('Aguardando leitura do QR code no Smart Life')
    }
    const [homes, acs] = await Promise.all([this.tuya.discover(this.session), this.lg.listAcs()])
    this.draft = { homes, acs: acs.map(({ id, name }) => ({ id, name })) }
    return roomList(this.draft.homes, this.draft.acs)
  }

  async save(): Promise<void> {
    if (!this.draft) throw new Error('Busque dispositivos antes de salvar')
    this.store.save(this.draft)
    this.saved = this.draft
    this.draft = null
  }

  async rooms(): Promise<Room[]> {
    if (!this.saved) return []
    await this.ready
    const rooms = roomList(this.saved.homes, this.saved.acs)
    await Promise.all(rooms.flatMap(room => [
      ...room.lights.map(async light => { light.state = await this.tuya.getState(light.id) }),
      ...(room.ac ? [this.acState(room.ac)] : [])
    ]))
    return rooms
  }

  private async acState(ac: AirConditioner): Promise<void> {
    if (!this.lg) return
    ac.state = await this.lg.getAcState(ac.id).catch(() => offlineAc)
  }

  async command(command: DeviceCommand): Promise<void> {
    if (!this.saved) throw new Error('Configure devices before sending commands')
    await this.ready
    const rooms = roomList(this.saved.homes, this.saved.acs)
    const light = rooms.flatMap(room => room.lights).find(item => item.id === command.deviceId)
    const ac = rooms.map(room => room.ac).find(item => item?.id === command.deviceId)
    if ((command.kind === 'light.power' || command.kind === 'light.brightness' || command.kind === 'light.color' || command.kind === 'light.temperature') && light) {
      const patch = command.kind === 'light.power' ? { on: command.on }
        : command.kind === 'light.brightness' ? { brightness: command.brightness }
          : command.kind === 'light.color' ? { color: command.color } : { temperature: command.temperature }
      const state = await this.tuya.setLight(light.id, patch)
      if (!state.online) throw new Error('Device offline')
      return
    }
    if ((command.kind === 'ac.power' || command.kind === 'ac.temperature') && ac && this.lg) {
      await this.lg.setAc(ac.id, command.kind === 'ac.power' ? { on: command.on } : { targetTemperature: command.temperature })
      return
    }
    throw new Error('Device not found')
  }
}
