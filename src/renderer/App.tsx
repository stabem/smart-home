import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import QRCode from 'qrcode'
import { DotLottie } from '@lottiefiles/dotlottie-web'
import type { DeviceCommand, Room, SetupStatus, SmartHomeApi } from '../shared/types'
import bulbMotion from './assets/lottie/bulb.lottie?url'
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

export function App({ api }: { api: SmartHomeApi }) {
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [found, setFound] = useState<Room[] | null>(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [login, setLogin] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
  const [acMenu, setAcMenu] = useState<'mode' | 'fan' | null>(null)
  const [error, setError] = useState('')
  const [userCode, setUserCode] = useState('')
  const [acRoomIds, setAcRoomIds] = useState<Record<string, string>>({})
  async function refresh() { setRooms(await api.getRooms()) }
  useEffect(() => {
    void api.getRooms().then(setRooms).catch(() => setRooms([]))
    void api.getSetupStatus().then(setSetup).catch(() => setError('Não foi possível abrir a configuração salva.'))
    void api.getLaunchAtLogin().then(setLogin).catch(() => setLogin(false))
  }, [api])
  async function command(value: DeviceCommand) {
    try { setError(''); await api.sendCommand(value); await refresh() }
    catch { setError('O dispositivo não respondeu. Confira se está ligado e tente novamente.') }
  }
  async function turnOffAll() {
    const lights = (rooms ?? []).flatMap(room => room.lights).filter(light => light.state.online && light.state.on)
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
    try { const devices = await api.discoverDevices(); setFound(devices); setAcRoomIds(Object.fromEntries(devices.flatMap(room => room.acs.map(ac => [ac.id, room.id])))) }
    catch { setError('A busca falhou ou o QR ainda não foi lido. Tente novamente.') }
    finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setError('')
    try { await api.saveSetup(acRoomIds); setSetup(await api.getSetupStatus()); await refresh() }
    catch { setError('Não foi possível salvar a configuração com a proteção do sistema.') }
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
      <ul aria-label="Dispositivos encontrados">{found.map(room => <li key={room.id}><strong>{room.name}</strong><ul>{room.lights.map(light => <li key={light.id}>{light.name}</li>)}{room.acs.map(ac => <li key={ac.id}><label>{ac.name} — Cômodo<select aria-label={`Cômodo de ${ac.name}`} value={acRoomIds[ac.id] || room.id} onChange={event => setAcRoomIds(current => ({ ...current, [ac.id]: event.target.value }))}>{found.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></li>)}</ul></li>)}</ul>
      <button className="primaryButton" disabled={busy || !found.length} onClick={() => void save()}>Salvar</button>
    </section>}
    {alert}
  </main>
  const room = rooms.find(item => item.id === selected)
  if (room) return <main className="shell roomScreen">
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}><Icon src={backIcon} /> <span>Voltar</span></button><Icon src={homeIcon} className="topbarMark" /></header>
    <div className="roomTitle"><p className="overline">Cômodo</p><h1>{room.name}</h1><p>{room.lights.length} {room.lights.length === 1 ? 'luz' : 'luzes'}{room.acs.length ? ' · Ar-condicionado' : ''}</p></div>
    <div className="roomHero" aria-hidden="true"><span className="heroIcon"><Icon src={room.acs.length ? airIcon : bulbIcon} /></span><span>{room.acs.length ? 'Clima e iluminação' : 'Iluminação'}</span></div>
    <div className="roomControls">
      {room.lights.map(light => <section className="devicePanel" key={light.id}>
        <div className="deviceHead"><div><span className="deviceIcon lightIcon" aria-hidden="true"><Icon src={bulbIcon} /><Motion src={bulbMotion} active={light.state.on} className="bulbMotion" /></span><strong>{light.name}</strong></div><button className="lightSwitch" role="switch" aria-label={light.name} aria-checked={light.state.online && light.state.on} disabled={!light.state.online} onClick={() => void command({ kind: 'light.power', deviceId: light.id, on: !light.state.on })}><Icon src={bulbIcon} className="lampSymbol" /><span className="switchTrack" aria-hidden="true"/><span>{!light.state.online ? 'Offline' : light.state.on ? 'Ligada' : 'Desligada'}</span></button></div>
        <label className="rangeLabel"><span>Brilho</span><input type="range" aria-label="Brilho" min="1" max="100" disabled={!light.state.online} value={light.state.brightness ?? 100} style={{ '--fill': `${light.state.brightness ?? 100}%` } as CSSProperties} onChange={event => void command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(event.target.value) })} /><span>{light.state.brightness ?? 100}%</span></label>
        <button className="textButton" disabled={!light.state.online} aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor <span aria-hidden="true">⌄</span></button>
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
        <input type="range" aria-label="Temperatura" min="16" max="30" disabled={!ac.state.online} value={ac.state.targetTemperature} onChange={event => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Number(event.target.value) })} />
        <div className="acActions"><button aria-label="Modo" disabled={!ac.state.online} aria-expanded={acMenu === 'mode'} onClick={() => setAcMenu(acMenu === 'mode' ? null : 'mode')}>Modo <small>{ac.state.mode ?? '—'}</small></button><button aria-label="Ventilação" disabled={!ac.state.online} aria-expanded={acMenu === 'fan'} onClick={() => setAcMenu(acMenu === 'fan' ? null : 'fan')}>Ventilação <small>{ac.state.fan ?? '—'}</small></button><button role="switch" aria-label="Turbo" aria-checked={ac.state.turbo ?? false} disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.turbo', deviceId: ac.id, on: !ac.state.turbo })}>Turbo</button></div>
        {acMenu === 'mode' && <div className="acOptions" aria-label="Escolher modo">{(['Resfriar', 'Seco', 'Ventilar', 'Auto'] as const).map(mode => <button key={mode} aria-pressed={ac.state.mode === mode} onClick={() => { setAcMenu(null); void command({ kind: 'ac.mode', deviceId: ac.id, mode }) }}>{mode}</button>)}</div>}
        {acMenu === 'fan' && <div className="acOptions" aria-label="Escolher ventilação">{(['Auto', 'Baixa', 'Média', 'Alta'] as const).map(fan => <button key={fan} aria-pressed={ac.state.fan === fan} onClick={() => { setAcMenu(null); void command({ kind: 'ac.fan', deviceId: ac.id, fan }) }}>{fan}</button>)}</div>}
        <p className="updated" role="status">{ac.state.online ? `Atualizado${ac.state.updatedAt ? ` ${ac.state.updatedAt}` : ''}` : 'Offline'}</p>
      </section>)}
    </div>{alert}
  </main>
  const lightsOn = rooms.flatMap(item => item.lights).filter(light => light.state.online && light.state.on).length
  return <main className="shell homeScreen">
    <header className="topbar"><div><p className="overline">Minha casa</p><h1>Casa</h1></div><div className="topbarRight"><button className="settingsButton" aria-label="Configurações" aria-expanded={settings} onClick={() => setSettings(!settings)}><Icon src={settingsIcon} /></button></div></header>
    {settings && <div className="settingsPanel"><label><input type="checkbox" checked={login} onChange={event => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label></div>}
    <div className="homeSummary"><div><span className="summaryIcon"><Icon src={homeIcon} /></span><p><strong>{rooms.length} cômodos</strong><span>{lightsOn ? `${lightsOn} ${lightsOn === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Tudo tranquilo por aqui'}</span></p></div><button className="allOff" disabled={!lightsOn} onClick={() => void turnOffAll()}>Apagar tudo</button></div>
    <section className="roomListSection"><div className="sectionHeading"><h2>Cômodos</h2><span>{rooms.length} ambientes</span></div><ul aria-label="Cômodos" className="rooms">{rooms.map(item => {
      const online = item.lights.every(light => light.state.online)
      const on = item.lights.length > 0 && online && item.lights.every(light => light.state.on)
      const ac = item.acs[0]
      const lit = item.lights.filter(light => light.state.on).length
      return <li className={`roomTile ${lit ? 'isLit' : ''} ${ac?.state.on ? 'isCool' : ''}`} key={item.id}>
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}><span className="tileIcon"><Icon src={ac ? airIcon : bulbIcon} /></span><span className="tileName">{item.name}</span><small>{!online ? 'Offline' : ac?.state.on ? `Ar ${ac.state.targetTemperature}°` : lit ? `${lit} ${lit === 1 ? 'luz acesa' : 'luzes acesas'}` : 'Luzes apagadas'}</small>{ac && <strong className="tileTemperature">{ac.state.currentTemperature ?? ac.state.targetTemperature}°</strong>}</button>
        <button className="roomLights lightSwitch" aria-label={`Luzes ${item.name}`} aria-pressed={on} disabled={!item.lights.length || !online} title={on ? 'Desligar luzes' : 'Ligar luzes'} onClick={() => void Promise.all(item.lights.map(light => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: !on }))).catch(() => setError(`Luzes de ${item.name} não responderam. Confira se estão ligadas na tomada.`)).finally(refresh)}><Icon src={bulbIcon} className="lampSymbol" /><span className="switchTrack" aria-hidden="true" /></button>
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </li>
    })}</ul></section>{alert}
  </main>
}
