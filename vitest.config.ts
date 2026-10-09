import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Keep deep dependency-source imports inside this workspace when node_modules
  // is a Windows junction shared with another checkout.
  resolve: {preserveSymlinks: true},
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    server: {deps: {inline: ['@panzoom/panzoom']}},
  },
})
