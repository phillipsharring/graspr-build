# @phillipsharring/graspr-build

![Graspr](graspr.png)

Build mechanics for [Graspr](https://github.com/phillipsharring/graspr-framework) sites: HTML compiler, static page baker, and Vite dev plugin.

This package contains everything needed to **build** a Graspr site, separate from the runtime concerns (HTMX, Handlebars, auth) that live in `@phillipsharring/graspr-framework`. Static sites can depend on `graspr-build` alone; full apps depend on both.

## Install

```bash
npm install -D @phillipsharring/graspr-build vite @tailwindcss/vite tailwindcss
```

## Project shape

```
my-site/
├── content/
│   ├── layouts/        # base.html, etc  - shared shells
│   ├── components/     # custom-tag templates: lnk.html, callout.html, ...
│   └── pages/          # one HTML file per route
├── public/             # static assets, copied as-is
├── src/
│   ├── app.js          # vite entry  - at minimum, imports CSS
│   └── styles/         # CSS (tailwind v4 @theme block, etc)
├── site.config.js      # siteName, siteUrl, copyright, ...
└── vite.config.js
```

## `vite.config.js`

```js
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { grasprBuild } from '@phillipsharring/graspr-build/vite';
import siteConfig from './site.config.js';

export default defineConfig({
    root: 'src',
    publicDir: '../public',
    plugins: [tailwindcss(), grasprBuild({ siteConfig })],
    build: {
        outDir: '../dist',
        manifest: true,
        emptyOutDir: true,
        rollupOptions: { input: { app: './src/app.js' } },
    },
});
```

## `package.json`

```json
{
    "scripts": {
        "dev": "vite",
        "build": "vite build && graspr-build-pages",
        "preview": "vite preview"
    }
}
```

## Page format

```html
<layout name="base" title="About" />
<page-head>
<meta name="description" content="..." />
</page-head>

<h1>About</h1>
<callout type="info">Page content here.</callout>
```

- `<layout name="..." title="..." />` self-closing tag at the top picks the layout from `content/layouts/`
- `<page-head>...</page-head>` block injects extra `<head>` content
- Everything after is the page body, slotted into the layout's `[[app]]` placeholder

## Component format

`content/components/callout.html`:

```html
<aside class="rounded border border-blue-300 bg-blue-50 p-4">
    [[#if title]]<h3 class="font-bold">[[title]]</h3>[[/if]]
    [[slot]]
</aside>
```

- `[[prop]]`  - HTML-escaped prop
- `[[{prop}]]`  - raw prop (for attribute values, HTML snippets)
- `[[slot]]`  - child content
- `[[#if flag]] ... [[else]] ... [[/if]]`  - boolean conditional on a prop's truthiness

Custom tags can be either HTML custom-element style (`<my-callout>`  - must contain a hyphen) or single-word tags (`<callout>`  - works as long as a matching `callout.html` exists in `content/components/`).

## Programmatic API

```js
import { renderPage, buildPages } from '@phillipsharring/graspr-build';

// Bake all pages under content/pages/ to dist/
await buildPages({ root: process.cwd(), siteConfig });

// Render a single page (used by buildPages and the dev plugin)
const html = await renderPage({
    layoutsDir: 'content/layouts',
    componentsDir: 'content/components', // string OR string[]
    pagePath: 'content/pages/index.html',
    siteConfig,
    jsSrc: '/assets/app-XXXX.js',
    cssHref: '/assets/app-XXXX.css',
});
```

### `componentsDir`: string or array

`renderPage` accepts `componentsDir` as either a single directory or an array of directories. When resolving a custom tag like `<callout>`, the compiler tries each directory in order and uses the first match. This enables a future module system to contribute partials from `src/modules/*/partials/` alongside the project-level `content/components/` without changing the API.

## Output shape: `flatRoutes`

By default `buildPages()` writes each route as a directory containing an `index.html`:

```
/about/      -> dist/about/index.html
/blog/post/  -> dist/blog/post/index.html
```

Set `flatRoutes: true` to emit extensionless sibling files instead — handy when your host serves abstract URLs (`/about`, not `/about/`):

```
/about/      -> dist/about
/blog/post/  -> dist/blog/post
```

**Set it once in `site.config.js`** — both the `graspr-build-pages` build step and the dev plugin read it from there, so dev and prod stay consistent:

```js
// site.config.js
export default {
    siteName: 'My Site',
    flatRoutes: true,
    // or: flatRoutes: { keepExtension: ['404', 'errors/offline'] }
};
```

The `graspr-build-pages` CLI forwards `siteConfig.flatRoutes` to the build, and `grasprBuild({ siteConfig })` in `vite.config.js` falls back to the same field — no extra wiring needed. (You can still pass `flatRoutes` directly to `buildPages()` or `grasprBuild()` to override the config field, e.g. in a custom build script: `await buildPages({ root: process.cwd(), siteConfig, flatRoutes: true })`.)

- The root route always stays `dist/index.html` (it can't be an extensionless file).
- The `404` page is kept as `dist/404.html` by default, since CloudFront and most static hosts want a real `.html` file for the error document. Override the keep-list with route keys (no slashes): `flatRoutes: { keepExtension: ['404', 'errors/offline'] }`. The list **replaces** the default, so include `404` if you still want it kept.
- **Nested-route conflicts are a hard error.** A page at `/blog/` flattens to the file `dist/blog`, which can't coexist with a nested page at `/blog/post/` that needs `dist/blog/` to be a directory. The build fails with both source files named; either move a page or add the parent to `keepExtension`.
- Default is `flatRoutes: false` — no behavior change.

Dev serving already resolves `/about` without a redirect regardless of this setting; under `flatRoutes` the dev plugin additionally runs the same nested-route conflict check so `vite dev` fails the same way `npm run build` would.

## Minification: `minify`

Set `minify: true` in `site.config.js` to run each baked page through [`html-minifier-terser`](https://www.npmjs.com/package/html-minifier-terser) before it's written to disk:

```js
// site.config.js
export default {
    siteName: 'My Site',
    minify: true,
    // or: minify: { removeComments: false }   // override individual options
};
```

`html-minifier-terser` is an **optional peer dependency** — install it only if you minify:

```bash
npm install -D html-minifier-terser
```

- `minify: true` uses these defaults: `removeAttributeQuotes`, `collapseWhitespace`, `removeComments`, `removeRedundantAttributes`, `removeScriptTypeAttributes`, `removeTagWhitespace`.
- Pass an object to override individual options — it's **merged onto** the defaults, so `minify: { removeComments: false }` keeps everything else on.
- If `minify` is on but the peer dep isn't installed, the build throws a clear error telling you to install it (it fails before rendering any page, not midway through).
- Minification is **build-only** — `vite dev` always serves unminified HTML so it stays readable for debugging.
- Default is `minify: false` — no behavior change. With it off, the peer dep is never loaded or required.

Like `flatRoutes`, the `graspr-build-pages` CLI reads `minify` from `site.config.js`; you can also pass it directly to `buildPages({ ..., minify: true })` in a custom build script.

## Dev stylesheet: avoiding FOUC

In dev, Vite serves CSS that's `import`ed from your JS entry by injecting it via JavaScript *after* the script runs — so pages can paint unstyled for a moment (flash of unstyled content), most visible on content-heavy static sites. Production is unaffected (the hashed `<link>` from the manifest is render-blocking).

To fix dev, point graspr-build at your source stylesheet so it emits a real render-blocking `<link>`:

```js
// site.config.js
export default {
    siteName: 'My Site',
    devCss: '/styles/style.css', // dev-server URL of your CSS (relative to vite `root`)
};
```

`grasprBuild({ siteConfig })` reads it (or pass `grasprBuild({ devCss: '…' })` directly). Vite still hot-reloads the linked stylesheet, so HMR is unaffected. Keep importing the CSS from your JS entry too — that's what bundles it for the production build; in dev it just loads alongside the link harmlessly. The build ignores `devCss`.

## Hosting

graspr-build emits a plain `dist/` tree — host it anywhere that serves static files. Two deployment notes:

- **`flatRoutes` and `Content-Type` on S3.** Extensionless files (`dist/about`) have no extension for S3 to infer a MIME type from, so a naive `aws s3 sync` tags them `application/octet-stream` (or `binary/octet-stream`) and CloudFront serves them as a download instead of a page. After syncing, re-tag the extensionless objects as `text/html` — e.g. a small `apply-metadata` step that runs `aws s3 cp` with `--content-type text/html --metadata-directive REPLACE` over the flattened routes. Files kept with their extension (`index.html`, `404.html`) are unaffected.
- **The Vite build manifest is cleaned up for you.** `vite build` writes `dist/.vite/manifest.json` for graspr-build to read asset hashes from; `buildPages()` deletes it (and the now-empty `.vite/` dir) once those hashes are baked into the pages, so it never reaches your bucket. No `--exclude '.vite/*'` needed on the sync.

## License

MIT
