# Migration Helper

Figma plugin that migrates `gravity-list-entry` instances to `gravity-list-entry-new`, preserving leading, action, and meta-slot content.

## Build

```sh
npm install
npm run build      # builds code.js (sandbox) and ui.html (React + shadcn, self-contained)
npm run typecheck
```

## Use

In Figma: Plugins → Development → Import plugin from manifest… → select `manifest.json`.
Select the frames to migrate, run **Scan selection**, then **Migrate**. Scope is always the current selection; up to 100 instances per run.
