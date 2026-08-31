import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerWebMcpTools } from './webmcp/register-tools'

const controller = registerWebMcpTools()
window.addEventListener('pagehide', () => controller.abort(), { once: true })

const root = document.getElementById('root')
if (!root) throw new Error('Floor Studio root element is missing.')
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
