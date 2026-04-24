import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

export default defineConfig({
  plugins: [preact()],
  base: '/Float32bit-AAC_LC-converter-pwa/',
})