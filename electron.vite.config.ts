import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import commonjs from '@rollup/plugin-commonjs';
import { resolve } from 'path';

export default defineConfig({
  main: {
    // @hongguo/server（原 data-server，源码在 src/server，CJS 无类型）：alias 到源码入口
    resolve: {
      alias: [{ find: /^@hongguo\/server$/, replacement: resolve(__dirname, 'src/server/index.js') }],
    },
    // axios/cheerio 一并内联进产物：打包后无需依赖生产 node_modules
    plugins: [
      externalizeDepsPlugin({ exclude: ['axios', 'cheerio'] }),
      // server 源码与 axios/cheerio 均为 CJS，内联进 ESM 产物需 commonjs 转换
      commonjs({ include: [/node_modules/, /src[\\/]server[\\/]/] }),
    ],
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      outDir: 'out/main',
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
