# Changelog

## 0.1.0

Initial release. Extracted from `graspr-app-skeleton`'s `scripts/` directory and `vite.config.js` plugin block.

### Exports

- `renderPage(...)` — single-page HTML compiler with custom-tag expansion, layout resolution, `<page-head>` extraction, and `[[prop]]`/`[[#if]]`/`[[slot]]` interpolation
- `buildPages({ root, siteConfig, ... })` — bake every page under `content/pages/` to `dist/<route>/index.html`
- `grasprBuild({ siteConfig })` from `@phillipsharring/graspr-build/vite` — Vite dev middleware that renders pages on the fly during `vite dev`
- `graspr-build-pages` bin — CLI shim around `buildPages()` for use in `package.json` scripts

### API notes

- `renderPage`'s `componentsDir` parameter accepts **either a string or an array of strings**. The compiler tries each directory in order when resolving a custom tag, enabling future module systems to contribute partials from multiple roots without breaking single-root callers.
