// Bundles the React + Gravity UI into the single self-contained ui.html Figma
// requires. Gravity's custom-elements build is bundled statically (no lazy
// chunks); only the Bull font faces reference the Gravity static host, which
// the manifest allows.
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';

const result = await build({
  entryPoints: ['src/ui/main.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  target: 'es2020',
  minify: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

const css = [
  readFileSync('node_modules/@gravity/foundation/primitives/index.css', 'utf8'),
  readFileSync('node_modules/@gravity/foundation/primitives/font/default.css', 'utf8'),
  readFileSync('src/ui/styles.css', 'utf8'),
].join('\n');

const html = readFileSync('src/ui/index.html', 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);
writeFileSync('ui.html', html);
console.log(`ui.html ${(html.length / 1024).toFixed(1)}kb`);
