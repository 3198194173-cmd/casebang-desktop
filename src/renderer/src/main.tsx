import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './styles/global.css'
import './styles/a-theme.css'
import { AccountProvider } from './app/account-context'

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <AccountProvider><App /></AccountProvider>
  </StrictMode>
)
