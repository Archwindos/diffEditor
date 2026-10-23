import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
await build({ entryPoints: { main: 'src/main/main.ts', preload: 'src/main/preload.ts', cli: 'src/cli/index.ts' },
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' }, entryNames: '[name]', external: ['electron'], sourcemap: false });
await viteBuild();
