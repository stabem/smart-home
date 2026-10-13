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
const api = fixture === 'house' || fixture === 'empty'
  ? createFixtureApi(fixture)
  : window.api ?? createFixtureApi('house')

createRoot(document.getElementById('root')!).render(<React.StrictMode><App api={api} /></React.StrictMode>)
