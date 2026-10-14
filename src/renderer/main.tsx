import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createFixtureApi } from './fixtures'
import type { SmartHomeApi } from '../shared/types'
import './style.css'

declare global {
  interface Window { api?: SmartHomeApi }
}

const fixture = new URLSearchParams(location.search).get('fixture')
if (fixture === 'house' || fixture === 'house10' || fixture === 'empty' || !window.api) document.body.classList.add('fixtureMode')
const api = fixture === 'house' || fixture === 'house10' || fixture === 'empty'
  ? createFixtureApi(fixture)
  : window.api ?? createFixtureApi('house')

createRoot(document.getElementById('root')!).render(<React.StrictMode><App api={api} /></React.StrictMode>)

const syncHidden = (): void => document.body.classList.toggle('hidden', document.hidden)
syncHidden()
document.addEventListener('visibilitychange', syncHidden)
