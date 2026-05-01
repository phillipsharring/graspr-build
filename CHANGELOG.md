# Changelog

## 0.3.5

### Fixed

- Vite dev plugin: 301-redirect directory-style URLs missing their trailing slash (e.g. `/admin` → `/admin/`) when the resolved page is an `index.html`. Without this, the URL bar would show the slash-less form, which breaks downstream consumers that match on path prefixes (e.g. `path.startsWith('/admin/')`) and also diverges from prod CloudFront behavior. Query strings are preserved.

## 0.3.4

### Added

- `[[moduleAdminNav]]` layout placeholder -- generates admin nav links from modules that declare `adminNav` in their defaults. Respects `configure(mod, { adminNav: false })` to disable. Outputs `<a data-nav-section>` elements matching the existing admin nav pattern.

## 0.3.3

### Added

- `moduleRoot(importMetaUrl)` -- resolves a module's root directory from `import.meta.url` using the URL standard. Works in both Node and browser contexts without Node-only imports. Modules use this instead of `node:url` + `node:path` boilerplate.

## 0.3.2

### Added

- `initModules(modules)` -- iterates the modules array from `site.config.js` and calls `init()` on each module object that provides one. Apps call this once from their entry JS.

## 0.3.1

### Fixed

- `resolveModuleDirs()` no longer throws when a module's `pagesDir` or `componentsDir` doesn't exist on disk. This happens when npm skips empty directories during publish. The dir is silently skipped instead.

## 0.3.0

Module system.

### Added

- `configure(mod, overrides)` -- shallow-merges site-specific config onto a module's defaults. Modules registered without `configure()` use their own defaults.
- `resolveModuleDirs(rootDir, modules)` -- resolves an array of module entries into `pagesDirs` and `componentsDirs` for graspr-build. Accepts both module objects (from npm packages, self-resolving via `import.meta.url`) and legacy strings (local directory names under `modules/`).
- New export path: `@phillipsharring/graspr-build/modules` for the module utilities.

### How it works

Modules are plain objects with `name`, `pagesDir`, `componentsDir`, `defaults`, `config`, and `init()`. They self-resolve their own filesystem paths, so the build system just reads what the module declares rather than guessing paths by convention. This enables modules distributed as npm packages.

```js
// site.config.js
import { landing } from '@phillipsharring/handlr-module-landing';
import { configure } from '@phillipsharring/graspr-build/modules';

export default {
    modules: [
        landing,                                // uses defaults
        configure(landing, { adminNav: false }), // overridden
    ],
};
```

## 0.2.1

### Fixed

- Component templates are now trimmed of surrounding whitespace before substitution. The trailing newline that every editor (and POSIX) adds to text files was bleeding into the page after inline components, so `<lnk>here</lnk>,` rendered as `here ,` instead of `here,`. Block-level components were unaffected because the surrounding block context was already collapsing the whitespace.

## 0.2.0

Multi-root page discovery for frontend modules.

### Added

- `buildPages({ pagesDirs })` and `grasprBuild({ pagesDirs })` accept an array of page directories. Files from all roots are merged and routed by their relative path within their own root, so a module's `modules/blog/pages/posts/index.html` produces `/posts/` exactly the way `content/pages/posts/index.html` would.
- `componentsDirs` option exposed alongside the existing back-compat `componentsDir`. Internally `renderPage()` already supported arrays  - this just plumbs the option through `buildPages()` and the dev plugin.
- Test suite (`npm test`, runs on `node:test`) covering multi-root walking, conflict detection, ordering, and back-compat.

### Changed

- Cross-root route conflicts are now a **hard error** in both `buildPages()` and the dev plugin (was: warn + skip in `buildPages()`, undefined behavior in dev). Error messages name both source files. Mirrors the route conflict semantics in `handlr-framework` v0.5.

### Back-compat

- `pagesDir` (singular) and `componentsDir` (singular) still work. If both the singular and plural form are provided, the plural wins.

## 0.1.0

Initial release. Extracted from `graspr-app-skeleton`'s `scripts/` directory and `vite.config.js` plugin block.

### Exports

- `renderPage(...)`  - single-page HTML compiler with custom-tag expansion, layout resolution, `<page-head>` extraction, and `[[prop]]`/`[[#if]]`/`[[slot]]` interpolation
- `buildPages({ root, siteConfig, ... })`  - bake every page under `content/pages/` to `dist/<route>/index.html`
- `grasprBuild({ siteConfig })` from `@phillipsharring/graspr-build/vite`  - Vite dev middleware that renders pages on the fly during `vite dev`
- `graspr-build-pages` bin  - CLI shim around `buildPages()` for use in `package.json` scripts

### API notes

- `renderPage`'s `componentsDir` parameter accepts **either a string or an array of strings**. The compiler tries each directory in order when resolving a custom tag, enabling future module systems to contribute partials from multiple roots without breaking single-root callers.
