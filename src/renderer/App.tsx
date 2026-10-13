import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import QRCode from 'qrcode'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import type { DeviceCommand, LightGroup, Room, SetupStatus, SmartHomeApi } from '../shared/types'
import airMotion from './assets/lottie/air.lottie?url'
import scanMotion from './assets/lottie/scan.lottie?url'
import bulbIcon from './assets/icons/light-bulb.svg?url'
import airIcon from './assets/icons/snow-flake.svg?url'
import settingsIcon from './assets/icons/settings.svg?url'
import homeIcon from './assets/icons/home.svg?url'
import backIcon from './assets/icons/arrow-left.svg?url'

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

export function App({ api }: { api: SmartHomeApi }) {
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
  const [selected, setSelected] = useState<string | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const [login, setLogin] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
  const [acMenu, setAcMenu] = useState<'mode' | 'fan' | null>(null)
  const [error, setError] = useState('')
  const [userCode, setUserCode] = useState('')
  const [acRoomIds, setAcRoomIds] = useState<Record<string, string>>({})
  const [acError, setAcError] = useState<Record<string, string>>({})
  async function refresh() { setRooms(await api.getRooms()); setSetup(await api.getSetupStatus()) }
  useEffect(() => {
    void api.getRooms().then(async rooms => { setRooms(rooms); setSetup(await api.getSetupStatus()) }).catch(() => setRooms([]))
    void api.getSetupStatus().then(setSetup).catch(() => setError('Não foi possível abrir a configuração salva.'))
    void api.getLaunchAtLogin().then(setLogin).catch(() => setLogin(false))
  }, [api])
  async function command(value: DeviceCommand) {
    try { setError(''); await api.sendCommand(value); setAcError(current => ({ ...current, [value.deviceId]: '' })); await refresh() }
    catch (cause) {
      if (value.kind.startsWith('ac.')) setAcError(current => ({ ...current, [value.deviceId]: 'Ar não respondeu. Tente novamente.' }))
      else setError(cause instanceof Error && cause.message.startsWith('Falha em:') ? cause.message : 'O dispositivo não respondeu. Confira se está ligado e tente novamente.')
    }
  }
  async function turnOffAll() {
    const lights = (rooms ?? []).flatMap(room => room.lights).filter(light => light.state.online && !light.state.stale && light.state.on)
    try {
      setError('')
      await Promise.all(lights.map(light => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: false })))
    } catch {
      setError('Uma ou mais luzes não responderam. Confira os dispositivos e tente novamente.')
    } finally {
      await refresh()
    }
  }
  async function beginLogin() {
    try { setError(''); setQr(await QRCode.toDataURL(await api.beginSmartLifeLogin(userCode), { width: 192, margin: 2 })) }
    catch { setError('Não foi possível gerar o QR. Confira o User Code e a conexão.') }
  }
  async function search() {
    setBusy(true); setError('')
    try { const devices = await api.discoverDevices(); setFound(devices); setAcRoomIds(Object.fromEntries(devices.flatMap(room => [...room.acs, ...room.lights].map(device => [device.id, room.id])))); setGroups(devices.flatMap(room => {
      const bases = new Map<string, string[]>()
      room.lights.forEach(light => { const match = /^(.*?)_\d+$/.exec(light.name); if (match) bases.set(match[1], [...(bases.get(match[1]) ?? []), light.id]) })
      return [...bases].filter(([, ids]) => ids.length > 1).map(([base, ids]) => ({ id: `group:${room.id}:${base}`, roomId: room.id, name: base === room.name ? `Trilho do ${room.name}` : `${base} (trilho)`, memberIds: ids }))
    })) }
    catch { setError('A busca falhou ou o QR ainda não foi lido. Tente novamente.') }
    finally { setBusy(false) }
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
    setBusy(true); setError('')
    try {
      await api.discoverDevices()
      const data = await api.getGroupSetup()
      setEditRooms(data.rooms)
      const known = new Set(data.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => device.id)))
      setEditAssignments(current => ({ ...Object.fromEntries(data.rooms.flatMap(room => [...room.lights, ...room.acs].map(device => [device.id, room.id]))), ...Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id))) }))
      setEditNames(current => ({ ...Object.fromEntries(data.rooms.flatMap(room => room.lights.map(light => [light.id, light.name]))), ...Object.fromEntries(Object.entries(current).filter(([id]) => known.has(id))) }))
      setGroups(data.groups)
    } catch { setError('A busca falhou. Tente novamente.') }
    finally { setBusy(false) }
  }
  async function saveEdit() {
    setBusy(true); setError('')
    try { await api.saveHomeEdits(editAssignments, editNames, groups); await refresh(); setEditing(false) }
    catch { setError('Não foi possível salvar. Confira os nomes e grupos.') }
    finally { setBusy(false) }
  }
  async function finishReconnect() {
    setBusy(true); setError('')
    try {
      await api.reconnectSmartLife()
      setSetup(await api.getSetupStatus())
      await refresh()
      setReconnecting(false)
      setQr('')
    } catch { setError('Leia o QR no Smart Life e tente novamente.') }
    finally { setBusy(false) }
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
      <button className="primaryButton" disabled={busy} onClick={() => void search()}><Motion src={scanMotion} active={busy} className="buttonMotion" />Buscar dispositivos</button>
    </section>
    {found && <section className="foundDevices"><h2>Dispositivos encontrados</h2>
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
    </section>}
    {alert}
  </main>
  if (editing) return <main className="shell editScreen">
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setEditing(false); setError('') }}><Icon src={backIcon} /> <span>Voltar</span></button><h1>Editar casa</h1></header>
    <div className="editContent">
      <section className="editModule"><h2>Conexões</h2><button className="secondaryButton" onClick={() => setReconnecting(!reconnecting)}>Reconectar Smart Life</button>
        {reconnecting && <div className="reconnectFlow"><label>Smart Life User Code<input autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} /></label><button className="secondaryButton" disabled={busy} onClick={() => void beginLogin()}>Gerar QR Smart Life</button>{qr && <><img className="qr" src={qr} alt="QR Smart Life" /><button className="primaryButton" disabled={busy} onClick={() => void finishReconnect()}>Concluir reconexão</button></>}</div>}
        <button className="secondaryButton" disabled={busy} onClick={() => void searchAgain()}>Buscar dispositivos</button>
      </section>
      <section className="editModule"><h2>Luzes e cômodos</h2>{editRooms.map(room => <div className="editRoom" key={room.id}><h3>{room.name}</h3>{[...room.lights, ...room.acs].map(device => <div className="editDevice" key={device.id}>{room.lights.some(light => light.id === device.id) && <label>Nome de {device.name}<input value={editNames[device.id] ?? device.name} onChange={event => setEditNames(current => ({ ...current, [device.id]: event.target.value }))} /></label>}<label>Cômodo de {device.name}<select value={editAssignments[device.id] ?? room.id} onChange={event => {
          const nextRoom = event.target.value
          setEditAssignments(current => ({ ...current, [device.id]: nextRoom }))
          if (nextRoom !== room.id) setGroups(current => current.flatMap(group => {
            if (!group.memberIds.includes(device.id)) return [group]
            const memberIds = group.memberIds.filter(id => id !== device.id)
            return memberIds.length >= 2 ? [{ ...group, memberIds }] : []
          }))
        }}>{editRooms.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></div>)}</div>)}</section>
      <section className="editModule"><GroupEditor rooms={editRooms.map(room => ({ ...room, lights: editRooms.flatMap(source => source.lights.filter(light => (editAssignments[light.id] ?? source.id) === room.id)) }))} groups={groups} onChange={setGroups} /></section>
      <section className="editModule editPrefs"><label><input type="checkbox" checked={login} onChange={event => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label><label><input type="checkbox" checked={setup.syncGuard !== false} onChange={event => { const enabled = event.target.checked; void api.setSyncGuard(enabled).then(refresh) }} /> Manter grupos sincronizados</label></section>
      {alert}<button className="primaryButton editSave" disabled={busy} onClick={() => void saveEdit()}>Salvar</button>
    </div>
  </main>
  const room = rooms.find(item => item.id === selected)
  if (room) return <main className="shell roomScreen">
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}><Icon src={backIcon} /> <span>Voltar</span></button><Icon src={homeIcon} className="topbarMark" /></header>
    <div className="roomTitle"><h1>{room.name}</h1></div>
    <div className="roomControls">
      {room.lights.map(light => <section className="devicePanel" key={light.id}>
        <div className="deviceHead"><button className="lightSwitch" role="switch" aria-label={light.name} aria-checked={light.state.online && light.state.on} disabled={!light.state.online || light.state.stale} onClick={() => void command({ kind: 'light.power', deviceId: light.id, on: !light.state.on })}><Icon src={bulbIcon} className="lampSymbol" /></button><div className="deviceText"><strong>{light.name}</strong><small>{light.state.stale ? 'Sem atualização' : !light.state.online ? 'Offline' : light.memberIds ? `${light.memberIds.length} lâmpadas` : light.state.on ? 'Ligada' : 'Desligada'} {light.state.viaCloud && <span className="cloudGlyph" title="Via nuvem" aria-label="Via nuvem">☁</span>}</small></div></div>
        {!!light.partialFailure?.length && <p className="groupError" role="alert">Falha em: {light.partialFailure.join(', ')}</p>}
        {!light.switchOnly && <label className="rangeLabel"><span className="srOnly">Brilho</span><span className="sliderWrap"><span className="sliderIcon" aria-hidden="true">☼</span><input type="range" aria-label="Brilho" min="1" max="100" disabled={!light.state.online || light.state.stale} value={light.state.brightness ?? 100} style={{ '--fill': `${light.state.brightness ?? 100}%` } as CSSProperties} onChange={event => void command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(event.target.value) })} /></span><span>{light.state.brightness ?? 100}%</span></label>}
        {!light.switchOnly && <button className="textButton" disabled={!light.state.online || light.state.stale} aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor <span aria-hidden="true">⌄</span></button>}
        {colorFor === light.id && <div className="appearance">
          {light.state.color !== undefined && <><div className="swatches" aria-label="Cores rápidas">{[['Âmbar', '#ffbd75'], ['Quente', '#ffe0ae'], ['Neutra', '#ffffff'], ['Fria', '#d8e9ff'], ['Azul', '#88b8e6']].map(([name, color]) => <button key={color} type="button" aria-label={`Cor ${name}`} aria-pressed={light.state.color === color} style={{ backgroundColor: color }} onClick={() => void command({ kind: 'light.color', deviceId: light.id, color })} />)}</div><label>Cor personalizada<input type="color" aria-label="Escolher cor" value={light.state.color} onChange={event => void command({ kind: 'light.color', deviceId: light.id, color: event.target.value })} /></label><span role="status" aria-label="Cor atual">{light.state.color}</span></>}
          {light.state.temperature !== undefined && <label>Temperatura da luz<input type="range" aria-label="Temperatura da luz" min="0" max="100" value={light.state.temperature} onChange={event => void command({ kind: 'light.temperature', deviceId: light.id, temperature: Number(event.target.value) })} /></label>}
          {light.state.color === undefined && light.state.temperature === undefined && <p className="help" role="status">Controle de cor ainda não disponível para este dispositivo.</p>}
        </div>}
      </section>)}
      {room.acs.map(ac => <section className="acPanel" key={ac.id}>
        <div className="deviceHead"><div><span className="deviceIcon acIcon" aria-hidden="true"><Icon src={airIcon} /></span><strong>{ac.name}</strong></div><button className="acPower" aria-label={ac.state.on ? 'Desligar ar' : 'Ligar ar'} disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.power', deviceId: ac.id, on: !ac.state.on })}>{ac.state.on ? 'Desligar ar' : 'Ligar ar'}</button></div>
        <Motion src={airMotion} active={ac.state.on} className="airMotion" />
        <div className="acReading"><div><span>Ambiente</span><strong>{ac.state.currentTemperature ?? '—'}°</strong></div><div className="target"><span>Temperatura</span><div className="temperature"><button aria-label="Diminuir" disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.max(16, ac.state.targetTemperature - 1) })}>−</button><strong>{ac.state.targetTemperature}°</strong><button aria-label="Aumentar" disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.min(30, ac.state.targetTemperature + 1) })}>+</button></div></div></div>
        <input type="range" aria-label="Temperatura" min="16" max="30" disabled={!ac.state.online} value={ac.state.targetTemperature} style={{ '--fill': `${((ac.state.targetTemperature - 16) / 14) * 100}%` } as CSSProperties} onChange={event => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Number(event.target.value) })} />
        <div className="acActions"><button aria-label="Modo" disabled={!ac.state.online} aria-expanded={acMenu === 'mode'} onClick={() => setAcMenu(acMenu === 'mode' ? null : 'mode')}>Modo <small>{ac.state.mode ?? '—'}</small></button><button aria-label="Ventilação" disabled={!ac.state.online} aria-expanded={acMenu === 'fan'} onClick={() => setAcMenu(acMenu === 'fan' ? null : 'fan')}>Ventilação <small>{ac.state.fan ?? '—'}</small></button><button role="switch" aria-label="Turbo" aria-checked={ac.state.turbo ?? false} disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.turbo', deviceId: ac.id, on: !ac.state.turbo })}>Turbo</button></div>
        {acMenu === 'mode' && <div className="acOptions" aria-label="Escolher modo">{(['Resfriar', 'Seco', 'Ventilar', 'Auto'] as const).map(mode => <button key={mode} aria-pressed={ac.state.mode === mode} onClick={() => { setAcMenu(null); void command({ kind: 'ac.mode', deviceId: ac.id, mode }) }}>{mode}</button>)}</div>}
        {acMenu === 'fan' && <div className="acOptions" aria-label="Escolher ventilação">{(['Auto', 'Baixa', 'Média', 'Alta'] as const).map(fan => <button key={fan} aria-pressed={ac.state.fan === fan} onClick={() => { setAcMenu(null); void command({ kind: 'ac.fan', deviceId: ac.id, fan }) }}>{fan}</button>)}</div>}
        {acError[ac.id] && <p className="acError" role="alert">{acError[ac.id]}</p>}
        <p className="updated" role="status">{ac.state.online ? updatedLabel(ac.state.updatedAt) : 'Offline'}</p>
      </section>)}
    </div>{alert}
  </main>
  const lightsOn = rooms.flatMap(item => item.lights).filter(light => light.state.online && light.state.on).length
  return <main className="shell homeScreen">
    <header className="topbar"><div><p className="overline">Minha casa</p><h1>Casa</h1></div><div className="topbarRight"><button className="settingsButton" aria-label="Configurações" onClick={() => void openEdit()}><Icon src={settingsIcon} /></button></div></header>
    {!setup.smartLifeConnected && <section className="reconnectBanner" aria-label="Smart Life desconectado">
      <p><strong>Smart Life desconectado</strong><span>Reconecte para usar as luzes pela nuvem.</span></p>
      <button type="button" onClick={() => setReconnecting(true)}>Reconectar Smart Life</button>
    </section>}
    {reconnecting && <section className="reconnectFlow" aria-label="Reconectar Smart Life">
      <label>Smart Life User Code<input type="text" aria-label="Smart Life User Code" autoComplete="off" value={userCode} onChange={event => setUserCode(event.target.value)} placeholder={setup.smartLifeUserCodeConfigured ? 'Já configurado' : 'Digite seu User Code'} /></label>
      <button type="button" className="secondaryButton" disabled={busy} onClick={() => void beginLogin()}>Gerar QR Smart Life</button>
      {qr && <><img className="qr" src={qr} alt="QR Smart Life" /><p className="help">Escaneie o QR com o app Smart Life.</p><button type="button" className="primaryButton" disabled={busy} onClick={() => void finishReconnect()}>Concluir reconexão</button></>}
    </section>}
    <div className="homeSummary"><div><span className="summaryIcon"><Icon src={homeIcon} /></span><p><strong>{rooms.length} cômodos</strong><span>{lightsOn ? `${lightsOn} ${lightsOn === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Tudo tranquilo por aqui'}</span></p></div><button className="allOff" disabled={!lightsOn} onClick={() => void turnOffAll()}>Apagar tudo</button></div>
    <section className="roomListSection"><div className="sectionHeading"><h2>Cômodos</h2></div><ul aria-label="Cômodos" className="rooms">{rooms.map(item => {
      const stale = item.lights.some(light => light.state.stale)
      const online = item.lights.every(light => light.state.online && !light.state.stale)
      const on = item.lights.length > 0 && online && item.lights.every(light => light.state.on)
      const ac = item.acs[0]
      const lit = item.lights.filter(light => light.state.on).length
      return <li className={`roomTile ${lit ? 'isLit' : ''} ${ac?.state.on ? 'isCool' : ''}`} key={item.id}>
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}><span className="tileIcon"><Icon src={ac ? airIcon : bulbIcon} /></span><span className="tileName">{item.name}</span><small>{stale ? 'Sem atualização' : !online ? 'Offline' : ac?.state.on ? `Ar ${ac.state.targetTemperature}°` : lit ? `${lit} ${lit === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Luzes apagadas'}{online && item.lights.some(light => light.state.viaCloud) && <span className="cloudGlyph" title="Via nuvem" aria-label="Via nuvem">☁</span>}</small>{ac && <strong className="tileTemperature">{ac.state.currentTemperature ?? ac.state.targetTemperature}°</strong>}</button>
        <button className="roomLights lightSwitch" aria-label={`Luzes ${item.name}`} aria-pressed={on} disabled={!item.lights.length || !online} title={on ? 'Desligar luzes' : 'Ligar luzes'} onClick={() => void Promise.all(item.lights.map(light => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: !on }))).catch(() => setError(`Luzes de ${item.name} não responderam. Confira se estão ligadas na tomada.`)).finally(refresh)}><Icon src={bulbIcon} className="lampSymbol" /><span className="switchTrack" aria-hidden="true" /></button>
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </li>
    })}</ul></section>{alert}
  </main>
}
