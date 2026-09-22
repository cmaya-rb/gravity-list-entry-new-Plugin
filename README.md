# Migration Helper

Figma plugin that migrates `gravity-list-entry` instances to `gravity-list-entry-new`, preserving leading, action, and meta-slot content.

## Build

Gravity packages come from Red Bull's npm registry; the repo's `.npmrc` maps the `@gravity` scope (public, read-only).

```sh
npm install
npm run build      # builds code.js (sandbox) and ui.html (React + Gravity web components, self-contained)
npm run typecheck
```

## Use

In Figma: Plugins → Development → Import plugin from manifest… → select `manifest.json`.
Select the frames to migrate, run **Scan selection**, then **Migrate**. Scope is always the current selection; up to 100 instances per run.

The UI is built with Gravity (`@gravity/web-components-react`). Components are bundled statically; only the Bull font is loaded from `rbds-static.redbull.com`, which the manifest allows.
