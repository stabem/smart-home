import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { DeviceCommand, Room, SetupStatus, SmartHomeApi } from '../shared/types'
import { ApartmentMap } from './map/ApartmentMap'

export function App({ api }: { api: SmartHomeApi }) {
  const [rooms, setRooms] = useState<Room[] | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [found, setFound] = useState<Room[] | null>(null)
  const [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [login, setLogin] = useState(false)
  const [colorFor, setColorFor] = useState<string | null>(null)
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
      <button className="primaryButton" disabled={busy} onClick={() => void search()}>Buscar dispositivos</button>
    </section>
    {found && <section className="foundDevices"><h2>Dispositivos encontrados</h2>
      <ul aria-label="Dispositivos encontrados">{found.map(room => <li key={room.id}><strong>{room.name}</strong><ul>{room.lights.map(light => <li key={light.id}>{light.name}</li>)}{room.acs.map(ac => <li key={ac.id}><label>{ac.name} — Cômodo<select aria-label={`Cômodo de ${ac.name}`} value={acRoomIds[ac.id] || room.id} onChange={event => setAcRoomIds(current => ({ ...current, [ac.id]: event.target.value }))}>{found.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label></li>)}</ul></li>)}</ul>
      <button className="primaryButton" disabled={busy || !found.length} onClick={() => void save()}>Salvar</button>
    </section>}
    {alert}
  </main>
  const room = rooms.find(item => item.id === selected)
  if (room) return <main className="shell roomScreen">
    <header className="topbar roomTopbar"><button className="back" onClick={() => { setSelected(null); setColorFor(null) }}>← <span>Voltar</span></button><span className="topbarMark" aria-hidden="true">⌂</span></header>
    <div className="roomTitle"><p className="overline">Cômodo</p><h1>{room.name}</h1><p>{room.lights.length} {room.lights.length === 1 ? 'luz' : 'luzes'}{room.acs.length ? ' · Ar-condicionado' : ''}</p></div>
    <div className="roomMap"><ApartmentMap rooms={rooms} highlighted={room.id} selected={room.id} onSelect={setSelected} onHighlight={setHovered} /></div>
    <div className="roomControls">
      {room.lights.map(light => <section className="devicePanel" key={light.id}>
        <div className="deviceHead"><div><span className="deviceIcon lightIcon" aria-hidden="true">✳</span><strong>{light.name}</strong></div><button className="switchButton" role="switch" aria-label={light.name} aria-checked={light.state.online && light.state.on} disabled={!light.state.online} onClick={() => void command({ kind: 'light.power', deviceId: light.id, on: !light.state.on })}>{!light.state.online ? 'Offline' : light.state.on ? 'Ligada' : 'Desligada'}</button></div>
        <label className="rangeLabel"><span>Brilho</span><input type="range" aria-label="Brilho" min="1" max="100" disabled={!light.state.online} value={light.state.brightness ?? 100} onChange={event => void command({ kind: 'light.brightness', deviceId: light.id, brightness: Number(event.target.value) })} /><span>{light.state.brightness ?? 100}%</span></label>
        <button className="textButton" disabled={!light.state.online} aria-expanded={colorFor === light.id} onClick={() => setColorFor(colorFor === light.id ? null : light.id)}>Cor <span aria-hidden="true">⌄</span></button>
        {colorFor === light.id && <div className="appearance">
          {light.state.color !== undefined && <><label>Cor<input type="color" aria-label="Escolher cor" value={light.state.color} onChange={event => void command({ kind: 'light.color', deviceId: light.id, color: event.target.value })} /></label><span role="status" aria-label="Cor atual">{light.state.color}</span></>}
          {light.state.temperature !== undefined && <label>Temperatura da luz<input type="range" aria-label="Temperatura da luz" min="0" max="100" value={light.state.temperature} onChange={event => void command({ kind: 'light.temperature', deviceId: light.id, temperature: Number(event.target.value) })} /></label>}
          {light.state.color === undefined && light.state.temperature === undefined && <p className="help" role="status">Controle de cor ainda não disponível para este dispositivo.</p>}
        </div>}
      </section>)}
      {room.acs.map(ac => <section className="acPanel" key={ac.id}>
        <div className="deviceHead"><div><span className="deviceIcon acIcon" aria-hidden="true">❄</span><strong>{ac.name}</strong></div><button className="acPower" aria-label={ac.state.on ? 'Desligar ar' : 'Ligar ar'} disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.power', deviceId: ac.id, on: !ac.state.on })}>{ac.state.on ? 'Desligar ar' : 'Ligar ar'}</button></div>
        <div className="acReading"><div><span>Ambiente</span><strong>{ac.state.currentTemperature ?? '—'}°</strong></div><div className="target"><span>Temperatura</span><div className="temperature"><button aria-label="Diminuir" disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.max(16, ac.state.targetTemperature - 1) })}>−</button><strong>{ac.state.targetTemperature}°</strong><button aria-label="Aumentar" disabled={!ac.state.online} onClick={() => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Math.min(30, ac.state.targetTemperature + 1) })}>+</button></div></div></div>
        <input type="range" aria-label="Temperatura" min="16" max="30" disabled={!ac.state.online} value={ac.state.targetTemperature} onChange={event => void command({ kind: 'ac.temperature', deviceId: ac.id, temperature: Number(event.target.value) })} />
        <div className="acActions"><button disabled title="Controle ainda não disponível">Modo</button><button disabled title="Controle ainda não disponível">Ventilação</button><button role="switch" aria-label="Turbo" aria-checked={ac.state.turbo ?? false} disabled title="Controle ainda não disponível">Turbo</button></div>
        <p className="updated" role="status">{ac.state.online ? `Atualizado${ac.state.updatedAt ? ` ${ac.state.updatedAt}` : ''}` : 'Offline'}</p>
      </section>)}
    </div>{alert}
  </main>
  return <main className="shell homeScreen">
    <header className="topbar"><div><p className="overline">Seu apartamento</p><h1>Casa</h1></div><div className="topbarRight"><span className="indoorTemp" aria-label="Temperatura interna">21°</span><button className="settingsButton" aria-label="Configurações" aria-expanded={settings} onClick={() => setSettings(!settings)}>⚙</button></div></header>
    {settings && <div className="settingsPanel"><label><input type="checkbox" checked={login} onChange={event => { const enabled = event.target.checked; void api.setLaunchAtLogin(enabled).then(() => setLogin(enabled)) }} /> Iniciar com o Windows</label></div>}
    <section className="modelSection" aria-label="Apartamento"><div className="modelCaption"><span>Planta do apartamento</span><span>Arraste para girar</span></div><ApartmentMap rooms={rooms} highlighted={hovered} selected={null} onSelect={setSelected} onHighlight={id => setHovered(current => current === id ? current : id)} /></section>
    <section className="roomListSection"><div className="sectionHeading"><h2>Cômodos</h2><span>{rooms.length} ambientes</span></div><ul aria-label="Cômodos" className="rooms">{rooms.map(item => {
      const online = item.lights.every(light => light.state.online)
      const on = item.lights.length > 0 && online && item.lights.every(light => light.state.on)
      const ac = item.acs[0]
      return <li className={`roomRow ${hovered === item.id ? 'highlighted' : ''}`} key={item.id} onMouseEnter={() => setHovered(item.id)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(item.id)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHovered(null) }}>
        <button className="roomName" aria-label={`Abrir ${item.name}`} onClick={() => setSelected(item.id)}><span>{item.name}</span><small>{!online ? 'Offline' : ac ? `Ar · ${ac.state.currentTemperature ?? ac.state.targetTemperature}°` : 'Luzes'}</small></button>
        {ac && <span className={`acIndicator ${ac.state.on ? 'isOn' : ''}`} aria-label={ac.state.on ? 'Ar ligado' : 'Ar desligado'}>❄</span>}
        <button className="roomLights" aria-label={`Luzes ${item.name}`} aria-pressed={on} disabled={!item.lights.length || !online} title={on ? 'Desligar luzes' : 'Ligar luzes'} onClick={() => void Promise.all(item.lights.map(light => api.sendCommand({ kind: 'light.power', deviceId: light.id, on: !on }))).catch(() => setError(`Luzes de ${item.name} não responderam. Confira se estão ligadas na tomada.`)).finally(refresh)}><span aria-hidden="true">{on ? '●' : '○'}</span></button>
        {on && <span className="srOnly" role="status" aria-label={`${item.name} luzes ligadas`}>Ligadas</span>}
      </li>
    })}</ul></section>{alert}
  </main>
}
