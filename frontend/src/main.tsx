import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { InteractionMotionRoot } from './components/InteractionMotionRoot'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <InteractionMotionRoot><App /></InteractionMotionRoot>
  </StrictMode>,
)
