import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import App from './App.tsx'
import ConfirmHost from './components/ConfirmHost'
import AuthProvider from './components/AuthProvider'
import PermissionsProvider from './components/PermissionsProvider'
import './index.css'
import './dark.css'
import { registerServiceWorker } from './lib/push'
import LanguageRoot from './components/LanguageRoot'
import { browserLang, isLang, setLanguage } from './i18n'
import { readLocal } from './lib/theme'

registerServiceWorker()

// First paint: the language last saved on this person's profile on this
// device, else the one chosen on the sign-in page, else the browser's. The
// profile's language replaces it as soon as it is read after signing in.
const cached = readLocal('bmm.lang') ?? readLocal('bmm.lang.signin')
setLanguage(isLang(cached) ? cached : browserLang()).finally(() =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <PermissionsProvider>
          <LanguageRoot>
            <HashRouter>
              <App />
              <Toaster position="top-right" richColors />
              <ConfirmHost />
            </HashRouter>
          </LanguageRoot>
        </PermissionsProvider>
      </AuthProvider>
    </StrictMode>,
  ),
)
