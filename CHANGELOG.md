# Changelog

## 0.2.1

### Fixed

- Component templates are now trimmed of surrounding whitespace before substitution. The trailing newline that every editor (and POSIX) adds to text files was bleeding into the page after inline components, so `<lnk>here</lnk>,` rendered as `here ,` instead of `here,`. Block-level components were unaffected because the surrounding block context was already collapsing the whitespace.

## 0.2.0

Multi-root page discovery for frontend modules.

### Added

- `buildPages({ pagesDirs })` and `grasprBuild({ pagesDirs })` accept an array of page directories. Files from all roots are merged and routed by their relative path within their own root, so a module's `modules/blog/pages/posts/index.html` produces `/posts/` exactly the way `content/pages/posts/index.html` would.
- `componentsDirs` option exposed alongside the existing back-compat `componentsDir`. Internally `renderPage()` already supported arrays — this just plumbs the option through `buildPages()` and the dev plugin.
- Test suite (`npm test`, runs on `node:test`) covering multi-root walking, conflict detection, ordering, and back-compat.

### Changed

- Cross-root route conflicts are now a **hard error** in both `buildPages()` and the dev plugin (was: warn + skip in `buildPages()`, undefined behavior in dev). Error messages name both source files. Mirrors the route conflict semantics in `handlr-framework` v0.5.

### Back-compat

- `pagesDir` (singular) and `componentsDir` (singular) still work. If both the singular and plural form are provided, the plural wins.

## 0.1.0

Initial release. Extracted from `graspr-app-skeleton`'s `scripts/` directory and `vite.config.js` plugin block.

### Exports

- `renderPage(...)` — single-page HTML compiler with custom-tag expansion, layout resolution, `<page-head>` extraction, and `[[prop]]`/`[[#if]]`/`[[slot]]` interpolation
- `buildPages({ root, siteConfig, ... })` — bake every page under `content/pages/` to `dist/<route>/index.html`
- `grasprBuild({ siteConfig })` from `@phillipsharring/graspr-build/vite` — Vite dev middleware that renders pages on the fly during `vite dev`
- `graspr-build-pages` bin — CLI shim around `buildPages()` for use in `package.json` scripts

### API notes

- `renderPage`'s `componentsDir` parameter accepts **either a string or an array of strings**. The compiler tries each directory in order when resolving a custom tag, enabling future module systems to contribute partials from multiple roots without breaking single-root callers.
