import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { Button, Slider, SliderThumb, SliderTrack, Switch, ToggleButton } from 'react-aria-components'
import type { CSSProperties, ReactNode } from 'react'
import QRCode from 'qrcode'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import type { DeviceCommand, LightGroup, Room, SetupStatus, SmartHomeApi } from '../shared/types'
import airMotion from './assets/lottie/air.lottie?url'
import scanMotion from './assets/lottie/scan.lottie?url'
import bulbIcon from './assets/icons/light-bulb.svg?url'
import airIcon from './assets/icons/snow-flake.svg?url'
import settingsIcon from './assets/icons/settings.svg?url'
import backIcon from './assets/icons/arrow-left.svg?url'
import { Bathroom, Bed, Closet, Cloud, Cutlery, HomeSimpleDoor, Laptop, SmallLamp, Sofa, Table, WashingMachine } from 'iconoir-react/regular'
import { roomIcon } from './roomIcons'
import { startDiscoveryOrbit } from './discovery-orbit'

const roomGlyphs = { sofa: Sofa, cutlery: Cutlery, table: Table, bed: Bed, laptop: Laptop, bath: Bathroom, closet: Closet, washer: WashingMachine, door: HomeSimpleDoor, lamp: SmallLamp }

function RoomGlyph({ name }: { name: string }) {
  const Glyph = roomGlyphs[roomIcon(name)]
  return <Glyph className="roomGlyph" aria-hidden="true" strokeWidth={1.8} />
}

function Motion({ src, active, className = '' }: { src: string; active: boolean; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (!active || !canvas.current) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const player = new DotLottie({ canvas: canvas.current, src, autoplay: !reduced, loop: !reduced, backgroundColor: 'transparent' })
    return () => player.destroy()
  }, [src, active])
  return active ? <canvas className={`motion ${className}`} ref={canvas} width="48" height="48" aria-hidden="true" /> : null
}

function Icon({ src, className = '' }: { src: string; className?: string }) {
  return <img className={`lineIcon ${className}`} src={src} alt="" aria-hidden="true" />
}

const ease = [0.22, 1, 0.36, 1] as const
const waitingCopy = ['Ainda esperando a lâmpada…', 'A nuvem está lenta hoje…', 'Quase lá…']
const discoveryCopy = ['Entrando no Smart Life', 'Procurando na sua rede', 'Perguntando à nuvem', 'Organizando os cômodos']

function PendingCopy({ pending, normal }: { pending: boolean; normal: string }) {
  const reducedMotion = useReducedMotion()
  const [step, setStep] = useState(-1)
  useEffect(() => {
    if (!pending) { setStep(-1); return }
    let rotate = 0
    const start = window.setTimeout(() => {
      setStep(0)
      rotate = window.setInterval(() => setStep(current => (current + 1) % waitingCopy.length), 3500)
    }, 3000)
    return () => { clearTimeout(start); clearInterval(rotate) }
  }, [pending])
  const value = step < 0 ? normal : waitingCopy[step]
  return <AnimatePresence initial={false} mode="wait"><motion.span key={value} initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? undefined : { opacity: 0, y: -3 }} transition={{ duration: reducedMotion ? 0 : .5, ease }}>{value}</motion.span></AnimatePresence>
}

function DiscoveryStage({ active, ready, reducedMotion }: { active: boolean; ready: boolean; reducedMotion: boolean | null }) {
  const [phase, setPhase] = useState(0)
  const orbit = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!active) { setPhase(0); return }
    const timers = [1, 2, 3].map(index => window.setTimeout(() => setPhase(index), index * 1200))
    return () => timers.forEach(clearTimeout)
  }, [active])
  useEffect(() => {
    return startDiscoveryOrbit(orbit.current, active, !!reducedMotion)
  }, [active, reducedMotion])
  if (!active) return null
  return <div className="discoveryStage" aria-label="Buscando dispositivos">
    <div className="discoveryOrbit" aria-hidden="true"><div className="discoveryRing"/><div className="discoveryRing inner"/><div className="discoveryChips" ref={orbit}>{['Entrada', 'Cozinha', 'Sala de estar', 'Office', 'Quarto', 'Banheiro'].map((name, index) => <span key={name} className={`discoveryChip ${ready && phase >= 2 && index <= phase + 2 ? 'seen' : ''}`} style={{ '--chip-index': index, left: Math.cos(index * Math.PI / 3) * 124, top: Math.sin(index * Math.PI / 3) * 72 } as CSSProperties}><RoomGlyph name={name}/></span>)}</div><div className="discoveryCore"><HomeSimpleDoor aria-hidden="true"/><span>Casa</span></div></div>
    <div className="discoveryStatus"><AnimatePresence mode="wait"><motion.p key={phase} role="status" initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={reducedMotion ? undefined : { opacity: 0, y: -3 }} transition={{ duration: reducedMotion ? 0 : .5, ease }}>{discoveryCopy[phase]}</motion.p></AnimatePresence><div className="discoverySteps" aria-hidden="true">{discoveryCopy.map((_, index) => <i key={index} className={index < phase ? 'done' : index === phase ? 'now' : ''}/>)}</div></div>
  </div>
}

function PresenceScreen({ children, className, direction, reducedMotion }: { children: ReactNode; className: string; direction: number; reducedMotion: boolean | null }) {
  const present = useIsPresent()
  const surface = useRef<HTMLElement>(null)
  return <motion.main ref={surface} className={className} inert={!present} aria-hidden={!present} style={{ willChange: reducedMotion ? 'auto' : 'transform' }}
    initial={reducedMotion ? false : { x: direction, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={reducedMotion ? undefined : { x: -direction, opacity: 0, transition: { duration: .08 } }}
    onAnimationStart={() => { if (surface.current) surface.current.style.willChange = 'transform' }}
    onAnimationComplete={() => { if (surface.current) surface.current.style.willChange = 'auto' }}
    transition={{ duration: reducedMotion ? 0 : .5, ease }}>{children}</motion.main>
}

export function updatedLabel(value?: string, now = Date.now()): string {
  if (!value) return 'Atualizado'
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return 'Atualizado'
  if (now >= time && now - time < 60_000) return 'Atualizado agora'
  return `Atualizado às ${new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(time)}`
}

function GroupEditor({ rooms, groups, onChange }: { rooms: Room[]; groups: LightGroup[]; onChange: (update: (current: LightGroup[]) => LightGroup[]) => void }) {
  return <div className="groupSetup"><h2>Grupos de luz</h2><p className="help">Luzes do mesmo trilho respondem juntas.</p>
    {groups.map(group => <fieldset key={group.id}><legend>{rooms.find(room => room.id === group.roomId)?.name}</legend><label>Nome do grupo<input aria-label={`Nome do grupo ${group.id}`} value={group.name} onChange={event => onChange(current => current.map(item => item.id === group.id ? { ...item, name: event.target.value } : item))} /></label>
      {(rooms.find(room => room.id === group.roomId)?.lights ?? []).filter(light => !light.switchOnly).map(light => <label key={light.id} className="memberChoice"><input type="checkbox" checked={group.memberIds.includes(light.id)} disabled={!group.memberIds.includes(light.id) && groups.some(other => other.memberIds.includes(light.id)) || group.memberIds.includes(light.id) && group.memberIds.length <= 2} onChange={event => onChange(current => current.map(item => item.id === group.id ? { ...item, memberIds: event.target.checked ? [...item.memberIds, light.id] : item.memberIds.filter(id => id !== light.id) } : item))} />{light.name}</label>)}
      <button type="button" className="secondaryButton" onClick={() => onChange(current => current.filter(item => item.id !== group.id))}>Desagrupar</button></fieldset>)}
    {rooms.filter(room => room.lights.filter(light => !light.switchOnly && !groups.some(group => group.memberIds.includes(light.id))).length >= 2).map(room => <button type="button" key={room.id} className="secondaryButton" onClick={() => onChange(current => [...current, { id: `group:${room.id}:${Date.now()}`, roomId: room.id, name: `Grupo ${room.name}`, memberIds: room.lights.filter(light => !light.switchOnly && !current.some(group => group.memberIds.includes(light.id))).map(light => light.id) }])}>Criar grupo em {room.name}</button>)}
  </div>
}

function applyCommand(rooms: Room[], command: DeviceCommand): Room[] {
  return rooms.map(room => ({ ...room,
    lights: room.lights.map(light => {
      if (light.id !== command.deviceId && !light.memberIds?.includes(command.deviceId)) return light
      const state = { ...light.state }
      if (command.kind === 'light.power') state.on = command.on
      if (command.kind === 'light.brightness') state.brightness = command.brightness
      if (command.kind === 'light.color') state.color = command.color
      if (command.kind === 'light.temperature') state.temperature = command.temperature
      return { ...light, state }
    }),
    acs: room.acs.map(ac => {
      if (ac.id !== command.deviceId) return ac
      const state = { ...ac.state }
      if (command.kind === 'ac.power') state.on = command.on
      if (command.kind === 'ac.temperature') state.targetTemperature = command.temperature
      if (command.kind === 'ac.mode') { state.mode = command.mode; state.turbo = false }
      if (command.kind === 'ac.fan') state.fan = command.fan
      if (command.kind === 'ac.turbo') state.turbo = command.on
      return { ...ac, state }
    })
  }))
}

export function App({ api }: { api: SmartHomeApi }) {
  const reducedMotion = useReducedMotion()
  const baseRooms = useRef<Room[]>([])
  const optimistic = useRef(new Map<string, { command: DeviceCommand; version: number }>())
  const sending = useRef(new Set<string>())
  const serial = useRef(0)
  const lastIntent = useRef<string | null>(null)
  const [pending, setPending] = useState<string[]>([])
  const [controlError, setControlError] = useState<Record<string, string>>({})
  const [dragging, setDragging] = useState<string | null>(null)
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [found, setFound] = useState<Room[] | null>(null)
  const [groups, setGroups] = useState<LightGroup[]>([])
  const [editing, setEditing] = useState(false)
  const [editRooms, setEditRooms] = useState<Room[]>([])
  const [editAssignments, setEditAssignments] = useState<Record<string, string>>({})
  const [editNames, setEditNames] = useState<Record<string, string>>({})
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryReady, setDiscoveryReady] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [login, setLogin] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
  const [acMenu, setAcMenu] = useState<'mode' | 'fan' | null>(null)
  const [error, setError] = useState('')
  const [userCode, setUserCode] = useState('')
  const [acRoomIds, setAcRoomIds] = useState<Record<string, string>>({})
  useEffect(() => {
    if (!discovering && !found) return
    const timer = window.setTimeout(() => {
      document.querySelector<HTMLElement>(discovering ? '.discoveryStage' : '.foundDevices')?.scrollIntoView({ behavior: reducedMotion ? 'instant' : 'smooth', block: 'center' })
    }, 80)
    return () => clearTimeout(timer)
  }, [discovering, found, reducedMotion])
  useLayoutEffect(() => {
    if (!api.fitWindow) return
    const home = document.querySelector<HTMLElement>('.homeScreen')
    if (!home) { api.fitWindow(604); return }
    const report = () => api.fitWindow?.(home.scrollHeight - 36)
    const observer = new ResizeObserver(report)
    observer.observe(home)
    const changes = new MutationObserver(report)
    changes.observe(home, { childList: true, subtree: true, characterData: true })
    report()
    return () => { observer.disconnect(); changes.disconnect() }
  }, [api, rooms, selected, reconnecting])
  const visibleRooms = () => [...optimistic.current.values()].reduce((value, item) => applyCommand(value, item.command), baseRooms.current)
  async function refresh() { baseRooms.current = await api.getRooms(); setRooms(visibleRooms()); setSetup(await api.getSetupStatus()) }
  useEffect(() => {
    void api.getRooms().then(async rooms => { baseRooms.current = rooms; setRooms(rooms); setSetup(await api.getSetupStatus()) }).catch(() => setRooms([]))
    void api.getSetupStatus().then(setSetup).catch(() => setError('Não foi possível abrir a configuração salva.'))
    void api.getLaunchAtLogin().then(setLogin).catch(() => setLogin(false))
  }, [api])
  function command(value: DeviceCommand) {
    const key = `${value.deviceId}:${value.kind}`
    const version = ++serial.current
    performance.mark(`control:${key}:${version}:intent`)
    lastIntent.current = `control:${key}:${version}`
    optimistic.current.set(key, { command: value, version })
    setRooms(visibleRooms())
    setPending([...optimistic.current.keys()])
    setControlError(current => ({ ...current, [value.deviceId]: '' }))
    if (sending.current.has(key)) return
    sending.current.add(key)
    void (async () => {
      while (optimistic.current.has(key)) {
        let next = optimistic.current.get(key)!
        if (next.command.kind === 'light.brightness' || next.command.kind === 'ac.temperature' || next.command.kind === 'light.temperature') {
          await new Promise(resolve => setTimeout(resolve, 150))
          next = optimistic.current.get(key)!
        }
        try {
          await api.sendCommand(next.command)
          baseRooms.current = applyCommand(baseRooms.current, next.command)
          if (optimistic.current.get(key)?.version === next.version) optimistic.current.delete(key)
        } catch (cause) {
          if (optimistic.current.get(key)?.version === next.version) {
            optimistic.current.delete(key)
            setControlError(current => ({ ...current, [value.deviceId]: cause instanceof Error && (cause.message.startsWith('Falha em:') || cause.message.startsWith('Sem energia')) ? cause.message : value.kind.startsWith('ac.') ? 'Ar não respondeu. Tente novamente.' : 'Dispositivo não respondeu. Tente novamente.' }))
          }
        }
        setRooms(visibleRooms())
        setPending([...optimistic.current.keys()])
      }
      sending.current.delete(key)
      void refresh().catch(() => undefined)
    })()
  }
  useLayoutEffect(() => { if (lastIntent.current) { performance.mark(`${lastIntent.current}:paint-ready`); lastIntent.current = null } }, [rooms])
  const isPending = (deviceId: string) => pending.some(key => key.startsWith(`${deviceId}:`))
  function turnOffAll() {
    (rooms ?? []).flatMap(room => room.lights).filter(light => light.state.online && !light.state.stale && light.state.on).forEach(light => command({ kind: 'light.power', deviceId: light.id, on: false }))
  }
  async function beginLogin() {
    try { setError(''); setQr(await QRCode.toDataURL(await api.beginSmartLifeLogin(userCode), { width: 192, margin: 2 })) }
    catch { setError('Não foi possível gerar o QR. Confira o User Code e a conexão.') }
  }
  async function search() {
    setBusy(true); setDiscovering(true); setDiscoveryReady(false); setFound(null); setError('')
    try { const [devices] = await Promise.all([api.discoverDevices().then(value => { setDiscoveryReady(true); return value }), new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : 5400))]); setFound(devices); setAcRoomIds(Object.fromEntries(devices.flatMap(room => [...room.acs, ...room.lights].map(device => [device.id, room.id])))); setGroups(devices.flatMap(room => {
      const bases = new Map<string, string[]>()
      room.lights.forEach(light => { const match = /^(.*?)_\d+$/.exec(light.name); if (match) bases.set(match[1], [...(bases.get(match[1]) ?? []), light.id]) })
      return [...bases].filter(([, ids]) => ids.length > 1).map(([base, ids]) => ({ id: `group:${room.id}:${base}`, roomId: room.id, name: base === room.name ? `Trilho do ${room.name}` : `${base} (trilho)`, memberIds: ids }))
    })) }
    catch { setError('A busca falhou ou o QR ainda não foi lido. Tente novamente.') }
    finally { setBusy(false); setDiscovering(false) }
  }
  async function save() {
    setBusy(true); setError('')
    try { await api.saveSetup(acRoomIds, groups); setSetup(await api.getSetupStatus()); await refresh() }
    catch { setError('Não foi possível salvar a configuração com a proteção do sistema.') }
    finally { setBusy(false) }
  }
  async function openEdit() {
    try {
      const data = await api.getGroupSetup()
      setEditRooms(data.rooms)
      setEditAssignments(Object.fromEntries(data.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => [device.id, room.id]))))
      setEditNames(Object.fromEntries(data.rooms.flatMap(room => room.lights.map(light => [light.id, light.name]))))
      setGroups(data.groups)
      setEditing(true)
      setError('')
    } catch { setError('Não foi possível abrir a edição da casa.') }
  }
  async function searchAgain() {
    setBusy(true); setDiscovering(true); setDiscoveryReady(false); setError('')
    try {
      await Promise.all([api.discoverDevices().then(() => setDiscoveryReady(true)), new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : 5400))])
      const data = await api.getGroupSetup()
      setEditRooms(data.rooms)
      const known = new Set(data.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => device.id)))
      setEditAssignments(current => ({ ...Object.fromEntries(data.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => [device.id, room.id]))), ...Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id))) }))
      setEditNames(current => ({ ...Object.fromEntries(data.rooms.flatMap(room => room.lights.map(light => [light.id, light.name]))), ...Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id))) }))
      setGroups(data.groups)
    } catch { setError('A busca falhou. Tente novamente.') }
    finally { setBusy(false); setDiscovering(false) }
  }
  async function saveEdit() {
    setBusy(true); setError('')
    try { await api.saveHomeEdits(editAssignments, editNames, groups); await refresh(); setEditing(false) }
    catch { setError('Não foi possível salvar. Confira os nomes e grupos.') }
    finally { setBusy(false) }
  }
  async function finishReconnect() {
    setBusy(true); setDiscovering(true); setDiscoveryReady(false); setError('')
    try {
      await Promise.all([api.reconnectSmartLife().then(() => setDiscoveryReady(true)), new Promise(resolve => setTimeout(resolve, reducedMotion ? 0 : 4200))])
      setSetup(await api.getSetupStatus())
      await refresh()
      setReconnecting(false)
      setQr('')
    } catch { setError('Leia o QR no Smart Life e tente novamente.') }
    finally { setBusy(false); setDiscovering(false) }
  }
  const alert = error && <p role="alert" className="error">{error}</p>
  if (!rooms || !setup) return <main className="shell"><p role="status">Carregando...</p>{alert}</main>
  if (!setup.configured) return <main className="shell setupScreen">
    <header className="topbar"><div><p className="overline">Primeiros passos</p><h1>Configurar</h1></div><span className="topbarMark" aria-hidden="true">⌂</span></header>
    <div className="setupIntro"><span>01 / 03</span><p>Conecte a casa para controlar luzes e ar em um só lugar.</p></div>
    <section className="setupStatus" aria-label="Estado das conexões">
      <p role="status" aria-label="Token LG"><span>LG ThinQ</span><strong>{setup.lgTokenConfigured ? 'Token pronto' : 'Token pendente'}</strong></p>
      <p role="status" aria-label="Chaves Tuya"><span>Smart Life</span><strong>{setup.tuyaKeysConfigured ? 'Chaves salvas' : 'Aguardando dispositivos'}</strong></p>
    </section>
    <section className="setupFlow"><h2>Vincular Smart Life</h2>
      <label>Smart Life User Code<input aria-label="Smart Life User Code" type="text" autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} placeholder={setup.smartLifeUserCodeConfigured ? 'Já configurado' : 'Digite seu User Code'} /></label>
      <p className="help">Escaneie o QR com o app Smart Life.</p>
      <button className="secondaryButton" onClick={() => void beginLogin()}>Gerar QR Smart Life</button>
      {qr && <img className="qr" src={qr} alt="QR Smart Life" />}
      <button className="primaryButton" disabled={busy} onClick={() => void search()}><Motion src={scanMotion} active={busy && !discovering} className="buttonMotion" />Buscar dispositivos</button>
    </section>
    <AnimatePresence mode="wait">{discovering ? <motion.div key="discovery" exit={reducedMotion ? undefined : { opacity: 0, scale: .96 }} transition={{ duration: reducedMotion ? 0 : .35 }}><DiscoveryStage active ready={discoveryReady} reducedMotion={reducedMotion}/></motion.div> : found && <motion.section key="found" className="foundDevices" initial={reducedMotion ? false : { opacity: 0, y: 16, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .6, ease }}><h2>Dispositivos encontrados</h2>
      <ul aria-label="Dispositivos encontrados">{found.map(room => <li key={room.id}><strong>{room.name}</strong><ul>{[...room.lights, ...room.acs].map(device => <li key={device.id}><label>{device.name} — Cômodo<select aria-label={`Cômodo de ${device.name}`} value={acRoomIds[device.id] || room.id} onChange={event => {
        const nextRoom = event.target.value
        setAcRoomIds(current => ({ ...current, [device.id]: nextRoom }))
        if (room.lights.some(light => light.id === device.id) && nextRoom !== room.id) {
          setGroups(current => current.flatMap(group => {
            if (!group.memberIds.includes(device.id)) return [group]
            const memberIds = group.memberIds.filter(id => id !== device.id)
            return memberIds.length >= 2 ? [{ ...group, memberIds }] : []
          }))
        }
      }}>{found.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></li>)}</ul></li>)}</ul>
      <GroupEditor rooms={found.map(room => ({ ...room, lights: found.flatMap(source => source.lights.filter(light => (acRoomIds[light.id] || source.id) === room.id)) }))} groups={groups} onChange={setGroups} />
      <button className="primaryButton" disabled={busy || !found.length} onClick={() => void save()}>Salvar</button>
    </motion.section>}</AnimatePresence>
    {alert}
  </main>
  if (editing) return <main className="shell editScreen">
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setEditing(false); setError('') }}><Icon src={backIcon} /> <span>Voltar</span></button><h1>Editar casa</h1></header>
    <div className="editContent">
      <section className="editModule"><h2>Conexões</h2><button className="secondaryButton" onClick={() => setReconnecting(!reconnecting)}>Reconectar Smart Life</button>
        {reconnecting && <div className="reconnectFlow"><label>Smart Life User Code<input autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} /></label><button className="secondaryButton" disabled={busy} onClick={() => void beginLogin()}>Gerar QR Smart Life</button>{qr && <><img className="qr" src={qr} alt="QR Smart Life" /><button className="primaryButton" disabled={busy} onClick={() => void finishReconnect()}>Concluir reconexão</button></>}</div>}
        <button className="secondaryButton" disabled={busy} onClick={() => void searchAgain()}>Buscar dispositivos</button>
        <AnimatePresence>{discovering && <motion.div exit={reducedMotion ? undefined : { opacity: 0, scale: .96 }} transition={{ duration: reducedMotion ? 0 : .35 }}><DiscoveryStage active ready={discoveryReady} reducedMotion={reducedMotion}/></motion.div>}</AnimatePresence>
      </section>
      {!discovering && <motion.section className="editModule" initial={reducedMotion ? false : { opacity: 0, y: 16, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .6, delay: discoveryReady ? .35 : 0, ease }}><h2>Luzes e cômodos</h2>{editRooms.map(room => <div className="editRoom" key={room.id}><h3>{room.name}</h3>{[...room.lights, ...room.acs].map(device => <div className="editDevice" key={device.id}>{room.lights.some(light => light.id === device.id) && <label>Nome de {device.name}<input value={editNames[device.id] ?? device.name} onChange={event => setEditNames(current => ({ ...current, [device.id]: event.target.value }))} /></label>}<label>Cômodo de {device.name}<select value={editAssignments[device.id] ?? room.id} onChange={event => {
          const nextRoom = event.target.value
          setEditAssignments(current => ({ ...current, [device.id]: nextRoom }))
          if (nextRoom !== room.id) setGroups(current => current.flatMap(group => {
            if (!group.memberIds.includes(device.id)) return [group]
            const memberIds = group.memberIds.filter(id => id !== device.id)
            return memberIds.length >= 2 ? [{ ...group, memberIds }] : []
          }))
        }}>{editRooms.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></div>)}</div>)}</motion.section>}
      <section className="editModule"><GroupEditor rooms={editRooms.map(room => ({ ...room, lights: editRooms.flatMap(source => source.lights.filter(light => (editAssignments[light.id] ?? source.id) === room.id)) }))} groups={groups} onChange={setGroups} /></section>
      <section className="editModule editPrefs"><label><input type="checkbox" checked={login} onChange={event => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label><label><input type="checkbox" checked={setup.syncGuard !== false} onChange={event => { const enabled = event.target.checked; void api.setSyncGuard(enabled).then(refresh) }} /> Manter grupos sincronizados</label></section>
      {alert}<button className="primaryButton editSave" disabled={busy} onClick={() => void saveEdit()}>Salvar</button>
    </div>
  </main>
  const room = rooms.find(item => item.id === selected)
  const lightsOn = rooms.flatMap(item => item.lights).filter(light => light.state.online && light.state.on).length
  return <div className="viewStage"><AnimatePresence initial={false} mode="wait">{room ? <PresenceScreen key={room.id} className="shell roomScreen" direction={20} reducedMotion={reducedMotion}>
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}><Icon src={backIcon} /> <span>Voltar</span></button></header>
    <motion.div className="roomTitle" initial={reducedMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reducedMotion ? 0 : .5, ease }}><h1>{room.name}</h1></motion.div>
    <div className="roomControls">
      {room.lights.map((light, index) => <motion.section layout={!reducedMotion} initial={reducedMotion ? false : { opacity: 0, y: 10, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .5, delay: reducedMotion ? 0 : index * .08, ease }} className={`devicePanel ${!light.state.online || light.state.reason ? 'unavailable' : ''} ${light.memberIds && light.state.on ? 'groupOn' : ''}`} key={light.id}>
        <div className="deviceHead"><Switch className={`lightSwitch ${isPending(light.id) ? 'isPending' : ''}`} aria-label={light.name} isSelected={light.state.online && light.state.on} isDisabled={!light.state.online || light.state.stale} onChange={on => command({ kind: 'light.power', deviceId: light.id, on })}><motion.img className="lineIcon lampSymbol" src={bulbIcon} alt="" aria-hidden="true" animate={{ scale: reducedMotion ? 1 : light.state.on ? [1, 1.08, 1] : 1 }} transition={{ duration: reducedMotion ? 0 : .38, ease }} /></Switch>{isPending(light.id) && <span className="pendingRing" role="status" aria-label="Enviando comando" />}<div className="deviceText"><strong>{light.name}</strong><small><PendingCopy pending={isPending(light.id)} normal={light.state.reason ? 'Sem energia' : light.state.stale ? 'Sem atualização' : !light.state.online ? 'Offline' : light.memberIds ? `${light.memberIds.length} lâmpadas` : light.state.on ? 'Ligada' : 'Desligada'} /> {light.state.viaCloud && <Cloud className="statusGlyph cloudGlyph" aria-label="Via nuvem" />}</small></div></div>
        {controlError[light.id] && <p className="controlError" role="alert">{controlError[light.id]}</p>}
        {!!light.partialFailure?.length && <p className="groupError" role="alert">{light.state.reason ? 'Sem energia' : 'Falha em'}: {light.partialFailure.join(', ')}</p>}
        {!light.switchOnly && light.state.online && !light.state.reason && <div className="rangeLabel"><Slider className="brightnessSlider" aria-label="Brilho" minValue={1} maxValue={100} value={light.state.brightness ?? 100} isDisabled={!light.state.online || light.state.stale} onChangeEnd={() => setDragging(null)} onChange={brightness => command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(brightness) })}><SliderTrack className="sliderTrack" onPointerDown={() => setDragging(light.id)} onPointerUp={() => setDragging(null)} style={{ '--fill': `${light.state.brightness ?? 100}%` } as CSSProperties}><span className="sliderIcon" aria-hidden="true">☀</span><span className="sliderValue" aria-hidden="true">{light.state.brightness ?? 100}%</span><SliderThumb className="ghostThumb" />{dragging === light.id && <span className="valueBubble">{light.state.brightness ?? 100}%</span>}</SliderTrack></Slider></div>}
        {!light.switchOnly && light.state.online && !light.state.reason && light.state.color !== undefined && <div className="swatches" aria-label="Cores rápidas">{[['Âmbar', '#ffbd75'], ['Quente', '#ffe0ae'], ['Neutra', '#ffffff'], ['Fria', '#d8e9ff'], ['Azul', '#88b8e6']].map(([name, color]) => <button key={color} type="button" aria-label={`Selecionar ${name}`} aria-pressed={light.state.color === color} disabled={!light.state.online || light.state.stale} style={{ backgroundColor: color }} onClick={() => void command({ kind: 'light.color', deviceId: light.id, color })} />)}<button className="customSwatch" aria-label="Cor" aria-expanded={colorFor === light.id} disabled={!light.state.online || light.state.stale} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>+</button></div>}
        {!light.switchOnly && light.state.online && !light.state.reason && light.state.color === undefined && <button className="textButton" disabled={!light.state.online || light.state.stale} aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor</button>}
        <AnimatePresence initial={false}>{colorFor === light.id && light.state.online && !light.state.reason && <motion.div className="appearance" initial={reducedMotion ? false : { height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={reducedMotion ? undefined : { height: 0, opacity: 0 }} transition={{ duration: reducedMotion ? 0 : .2 }}>
          {light.state.color !== undefined && <label>Cor personalizada<input type="color" aria-label="Escolher cor" value={light.state.color} disabled={!light.state.online || light.state.stale} onChange={event => void command({ kind: 'light.color', deviceId: light.id, color: event.target.value })} /></label>}
          {light.state.temperature !== undefined && <label>Temperatura da luz<input type="range" aria-label="Temperatura da luz" min="0" max="100" value={light.state.temperature} disabled={!light.state.online || light.state.stale} onChange={event => void command({ kind: 'light.temperature', deviceId: light.id, temperature: Number(event.target.value) })} /></label>}
          {light.state.color === undefined && light.state.temperature === undefined && <p className="help" role="status">Controle de cor ainda não disponível para este dispositivo.</p>}
        </motion.div>}</AnimatePresence>
      </motion.section>)}
      {room.acs.map((ac, index) => <motion.section layout={!reducedMotion} initial={reducedMotion ? false : { opacity: 0, y: 10, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .5, delay: reducedMotion ? 0 : (room.lights.length + index) * .08, ease }} className="acPanel" key={ac.id}>
        <div className="deviceHead acHead"><span className={`deviceIcon acIcon ${ac.state.on ? 'active' : ''}`} aria-hidden="true"><Icon src={airIcon} /></span><strong>{ac.name}</strong><button className={`acPower ${ac.state.on ? 'active' : ''} ${isPending(ac.id) ? 'isPending' : ''}`} aria-label={ac.state.on ? 'Desligar ar' : 'Ligar ar'} disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.power', deviceId: ac.id, on: !ac.state.on })}><span aria-hidden="true">⏻</span></button></div>
        <Motion src={airMotion} active={ac.state.on} className="airMotion" />
        <div className="acReading"><span className="ambient">Ambiente {ac.state.currentTemperature ?? '—'}°</span><div className="temperature"><Button aria-label="Diminuir" isDisabled={!ac.state.online} onPress={() => command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.max(16, ac.state.targetTemperature - 1) })}>−</Button><strong>{ac.state.targetTemperature}°</strong><Button aria-label="Aumentar" isDisabled={!ac.state.online} onPress={() => command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.min(30, ac.state.targetTemperature + 1) })}>+</Button></div></div>
        <Slider className="acSlider" aria-label="Temperatura" minValue={16} maxValue={30} value={ac.state.targetTemperature} isDisabled={!ac.state.online} onChange={temperature => command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Number(temperature) })}><SliderTrack className="sliderTrack" style={{ '--fill': `${((ac.state.targetTemperature - 16) / 14) * 100}%` } as CSSProperties}><SliderThumb className="ghostThumb" /></SliderTrack></Slider>
        <div className="acActions"><button aria-label="Modo" disabled={!ac.state.online} aria-expanded={acMenu === 'mode'} onClick={() => setAcMenu(acMenu === 'mode' ? null : 'mode')}>Modo <small>{ac.state.mode ?? '—'}</small></button><button aria-label="Ventilação" disabled={!ac.state.online} aria-expanded={acMenu === 'fan'} onClick={() => setAcMenu(acMenu === 'fan' ? null : 'fan')}>Ventilação <small>{ac.state.fan ?? '—'}</small></button><Switch aria-label="Turbo" isSelected={ac.state.turbo ?? false} isDisabled={!ac.state.online} onChange={on => command({ kind: 'ac.turbo', deviceId: ac.id, on })}>Turbo</Switch></div>
        {acMenu === 'mode' && <div className="acOptions" aria-label="Escolher modo">{(['Resfriar', 'Seco', 'Ventilar', 'Auto'] as const).map(mode => <button key={mode} aria-pressed={ac.state.mode === mode} onClick={() => { setAcMenu(null); void command({ kind: 'ac.mode', deviceId: ac.id, mode }) }}>{mode}</button>)}</div>}
        {acMenu === 'fan' && <div className="acOptions" aria-label="Escolher ventilação">{(['Auto', 'Baixa', 'Média', 'Alta'] as const).map(fan => <button key={fan} aria-pressed={ac.state.fan === fan} onClick={() => { setAcMenu(null); void command({ kind: 'ac.fan', deviceId: ac.id, fan }) }}>{fan}</button>)}</div>}
        {controlError[ac.id] && <p className="acError" role="alert">{controlError[ac.id]}</p>}
        <p className="updated" role="status">{ac.state.online ? updatedLabel(ac.state.updatedAt) : 'Offline'}</p>
      </motion.section>)}
    </div>{alert}
  </PresenceScreen> : <PresenceScreen key="home" className="shell homeScreen" direction={-16} reducedMotion={reducedMotion}>
    <header className="topbar"><div><h1>Casa</h1><span className="status">{lightsOn > 0 ? `${lightsOn} ${lightsOn === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Tudo apagado'}</span></div><button className="settingsButton" aria-label="Configurações" onClick={() => void openEdit()}><Icon src={settingsIcon} /></button></header>
    {!setup.smartLifeConnected && <section className="reconnectBanner" aria-label="Smart Life desconectado">
      <p><strong>Smart Life desconectado</strong><span>Reconecte para usar as luzes pela nuvem.</span></p>
      <button type="button" onClick={() => setReconnecting(true)}>Reconectar Smart Life</button>
    </section>}
    {reconnecting && <section className="reconnectFlow" aria-label="Reconectar Smart Life">
      <label>Smart Life User Code<input type="text" aria-label="Smart Life User Code" autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} placeholder={setup.smartLifeUserCodeConfigured ? 'Já configurado' : 'Digite seu User Code'} /></label>
      <button type="button" className="secondaryButton" disabled={busy} onClick={() => void beginLogin()}>Gerar QR Smart Life</button>
      {qr && <><img className="qr" src={qr} alt="QR Smart Life" /><p className="help">Escaneie o QR com o app Smart Life.</p><button type="button" className="primaryButton" disabled={busy} onClick={() => void finishReconnect()}>Concluir reconexão</button></>}
      {discovering && <DiscoveryStage active ready={discoveryReady} reducedMotion={reducedMotion}/>}
    </section>}
    <section className="roomListSection"><div className="sectionHeading"><h2>Cômodos</h2>{lightsOn > 0 && <button className="allOff" onClick={() => void turnOffAll()}>Apagar tudo</button>}</div><ul aria-label="Cômodos" className={`rooms ${rooms.length > 10 ? 'manyRooms' : rooms.length > 8 ? 'tenRooms' : ''}`}>{rooms.map(item => {
      const stale = item.lights.some(light => light.state.stale)
      const online = item.lights.every(light => light.state.online && !light.state.stale)
      const on = item.lights.length > 0 && online && item.lights.every(light => light.state.on)
      const ac = item.acs[0]
      const lit = item.lights.filter(light => light.state.on).length
      const status = item.lights.some(light => light.state.reason) ? 'Sem energia' : stale ? 'Sem atualização' : !online ? 'Offline' : ac?.state.on ? `Ar ${ac.state.targetTemperature}°` : lit ? `${lit} ${lit === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Luzes apagadas'
      return <motion.li layout={!reducedMotion} initial={reducedMotion ? false : { opacity: 0, y: 10, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: reducedMotion ? 0 : .5, delay: reducedMotion ? 0 : rooms.indexOf(item) * .06, ease }} className={`roomTile ${lit ? 'isLit' : ''} ${ac?.state.on ? 'isCool' : ''}`} key={item.id}>
        <ToggleButton className={`roomLights lightSwitch ${item.lights.some(light => isPending(light.id)) ? 'isPending' : ''}`} aria-label={`Luzes ${item.name}`} isSelected={on} isDisabled={!item.lights.length || !online} onChange={() => item.lights.forEach(light => command({ kind: 'light.power', deviceId: light.id, on: !on }))}><motion.span className="roomGlyphWrap" animate={{ scale: reducedMotion ? 1 : on ? [1, 1.08, 1] : 1 }} transition={{ duration: reducedMotion ? 0 : .38, ease }}><RoomGlyph name={item.name} /></motion.span></ToggleButton>
        {ac && <strong className="tileTemperature">{ac.state.currentTemperature ?? ac.state.targetTemperature}°</strong>}
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}><span className="tileName">{item.name}</span><small><PendingCopy pending={item.lights.some(light => isPending(light.id))} normal={status} />{online && item.lights.some(light => light.state.viaCloud) && <Cloud className="statusGlyph cloudGlyph" aria-label="Via nuvem" />}</small></button>
        {item.lights.some(light => controlError[light.id]) && <p className="tileError" role="alert">Falha ao mudar as luzes</p>}
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </motion.li>
    })}</ul></section>{alert}
  </PresenceScreen>}</AnimatePresence></div>
}
