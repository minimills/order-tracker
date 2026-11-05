import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App.tsx'
import AuthProvider from './components/AuthProvider'
import PermissionsProvider from './components/PermissionsProvider'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <PermissionsProvider>
        <HashRouter>
          <App />
          <Toaster position="top-right" richColors />
        </HashRouter>
      </PermissionsProvider>
    </AuthProvider>
  </StrictMode>,
)
