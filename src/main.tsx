import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerWebMcpTools } from './webmcp/register-tools'

const controller = registerWebMcpTools()
window.addEventListener('pagehide', () => controller.abort(), { once: true })

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

