import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    browser: 'src/browser.ts',
    index: 'index.ts',
    server: 'src/server.ts',
  },
  format: ['esm'],
  target: 'es2022',
  dts: true,
  clean: true,
  splitting: false,
});
