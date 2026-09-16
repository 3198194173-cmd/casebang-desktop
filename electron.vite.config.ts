import { resolve } from 'node:path'
import { builtinModules } from 'node:module'
import packageJson from './package.json'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const runtimeModules = new Set(['electron', ...builtinModules, ...builtinModules.map(name => `node:${name}`), ...Object.keys(packageJson.dependencies)])
const external = (id: string): boolean => runtimeModules.has(id) || [...runtimeModules].some(name => id.startsWith(`${name}/`))

export default defineConfig({
  main: {
    build: { rollupOptions: { external, input: { index: resolve('src/main/index.ts'), 'supplement-worker': resolve('src/main/modules/supplement/supplement-worker.ts') }, output: { format: 'cjs', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' } } },
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    plugins: [react({})],
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    }
  }
})
