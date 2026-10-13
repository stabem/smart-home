export interface LightState {
  on: boolean
  brightness?: number
  color?: string
  temperature?: number
  online: boolean
}

export interface AcState {
  on: boolean
  currentTemperature?: number
  targetTemperature: number
  mode?: string
  fan?: string
  turbo?: boolean
  online: boolean
  updatedAt?: string
}

export interface Light {
  id: string
  name: string
  state: LightState
}

export interface AirConditioner {
  id: string
  name: string
  state: AcState
}

export interface Room {
  id: string
  name: string
  lights: Light[]
  acs: AirConditioner[]
}

export type DeviceCommand =
  | { kind: 'light.power'; deviceId: string; on: boolean }
  | { kind: 'light.brightness'; deviceId: string; brightness: number }
  | { kind: 'light.color'; deviceId: string; color: string }
  | { kind: 'light.temperature'; deviceId: string; temperature: number }
  | { kind: 'ac.power'; deviceId: string; on: boolean }
  | { kind: 'ac.temperature'; deviceId: string; temperature: number }
  | { kind: 'ac.mode'; deviceId: string; mode: 'Resfriar' | 'Seco' | 'Ventilar' | 'Auto' }
  | { kind: 'ac.fan'; deviceId: string; fan: 'Auto' | 'Baixa' | 'Média' | 'Alta' }
  | { kind: 'ac.turbo'; deviceId: string; on: boolean }

export interface SetupStatus {
  configured: boolean
  lgTokenConfigured: boolean
  tuyaKeysConfigured: boolean
  smartLifeUserCodeConfigured: boolean
}

export interface SmartHomeApi {
  getRooms(): Promise<Room[]>
  sendCommand(command: DeviceCommand): Promise<void>
  getLaunchAtLogin(): Promise<boolean>
  setLaunchAtLogin(enabled: boolean): Promise<void>
  getSetupStatus(): Promise<SetupStatus>
  beginSmartLifeLogin(userCode?: string): Promise<string>
  discoverDevices(): Promise<Room[]>
  saveSetup(acRoomIds: Record<string, string>): Promise<void>
}
