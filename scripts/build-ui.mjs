// Bundles the React UI into the single self-contained ui.html Figma requires:
// Tailwind CSS + esbuild JS + base64 Inter, no external requests (manifest
// declares networkAccess: none).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

mkdirSync('build', { recursive: true });
execSync('npx tailwindcss -i src/ui/styles.css -o build/ui.css --minify', { stdio: 'inherit' });

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

const fontCss = [400, 500, 600]
  .map((w) => {
    const b64 = readFileSync(`node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`).toString('base64');
    return `@font-face{font-family:Inter;font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2')}`;
  })
  .join('');

const css = fontCss + readFileSync('build/ui.css', 'utf8');
const html = readFileSync('src/ui/index.html', 'utf8')
  .replace('/*__CSS__*/', () => css)
  .replace('/*__JS__*/', () => js);
writeFileSync('ui.html', html);
console.log(`ui.html ${(html.length / 1024).toFixed(1)}kb`);
