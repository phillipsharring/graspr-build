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
│   ├── layouts/        # base.html, etc — shared shells
│   ├── components/     # custom-tag templates: lnk.html, callout.html, ...
│   └── pages/          # one HTML file per route
├── public/             # static assets, copied as-is
├── src/
│   ├── app.js          # vite entry — at minimum, imports CSS
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

- `[[prop]]` — HTML-escaped prop
- `[[{prop}]]` — raw prop (for attribute values, HTML snippets)
- `[[slot]]` — child content
- `[[#if flag]] ... [[else]] ... [[/if]]` — boolean conditional on a prop's truthiness

Custom tags can be either HTML custom-element style (`<my-callout>` — must contain a hyphen) or single-word tags (`<callout>` — works as long as a matching `callout.html` exists in `content/components/`).

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

## License

MIT
