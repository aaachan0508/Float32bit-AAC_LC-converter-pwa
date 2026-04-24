import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'

render(<App />, document.getElementById('app')!)

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL

    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then(() => {
        console.log('Service worker registered')
      })
      .catch((err) => {
        console.warn('Service worker registration failed:', err)
      })
  })
}