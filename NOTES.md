# NOTES — graspr-build

Informal scratchpad for ideas, deferred features, and design notes that don't belong in `CHANGELOG.md` (which is for shipped releases) or `README.md` (which is for current behavior).

## Deferred features

### `buildPages({ flatRoutes: true })` — extension-less abstract URLs

**What**: Add a `flatRoutes` option to `buildPages()` that emits `dist/about` (an extensionless file at the route name) instead of `dist/about/index.html` (a directory containing an index file). Pipe the same option through `grasprBuild()`'s Vite plugin so the dev server's URL resolution stays consistent with the build output.

**Why**: phillipharrington.com (and presumably other static-site graspr consumers) prefer extension-less abstract URLs — `/about`, not `/about/` or `/about/index.html`. The user runs S3 + CloudFront with a viewer-request function that 301s `/about/` → `/about` and `/index.html` → `/`, plus an `apply-metadata.sh` step that tags extensionless objects with `Content-Type: text/html` after `s3 sync` (S3 can't infer Content-Type without an extension and CloudFront would otherwise serve raw bytes as plain text). This setup predates graspr by years and the preference is strong. Currently phillipharrington-2 handles this with a per-site post-processor at `scripts/flatten-dist.mjs` that walks dist/ and renames each `<route>/index.html` → `<route>`. That's the same "every consumer copies the same script" smell that motivated extracting graspr-build from app-skeleton in the first place.

**How to apply**:

- Add `opts.flatRoutes` to `buildPages()`. When `true`, change `routeAndOutDirFromPageRel()` (or its caller) to return a sibling file path instead of a child `index.html` path. Roughly:
  ```
  // current shape (flatRoutes: false)
  /about    ->  dist/about/index.html
  // flatRoutes: true
  /about    ->  dist/about           (extensionless file)
  ```
- Pipe the same option through the `grasprBuild()` Vite plugin. The dev middleware already serves `/about` cleanly without redirects (look at `findStaticRoute()` in `src/vite-plugin.mjs`), so this is mostly a no-op for dev — but the option should be accepted and not error.
- **Special-case the 404 page** (or whatever's configured as the CloudFront error document) to keep its `.html` extension. phillipharrington.com's per-site `flatten-dist.mjs` hardcodes `keepWithExtension = new Set(['404'])`. The graspr-build version should accept this as a config option: `flatRoutes: { keepExtension: ['404'] }` or similar. Default to `['404']` so the common case is zero-config.
- **Detect and warn/error on nested-route conflicts**. You can't have both `dist/blog` (file) and `dist/blog/post-1` (file inside dir) on a real filesystem at the same path — the parent route `/blog` and any nested child route `/blog/post-1` are mutually exclusive when flattened. The per-site `flatten-dist.mjs` currently warns + skips. The graspr-build version should detect this at build time, list the conflicting routes, and hard-error — same conflict semantics as the cross-root duplicate route check that landed in 0.2.0.
- Default `flatRoutes: false` — no behavior change for existing consumers.
- Allow consumers to override the keep-extension list via a richer option shape: `flatRoutes: true` uses defaults, `flatRoutes: { keepExtension: [...] }` overrides. Same shape pattern as the proposed `minify` option below.
- Add tests covering: `flatRoutes: true` actually emits sibling files, `flatRoutes: false` (default) emits dirs as before, the 404 exception is honored, custom `keepExtension` lists work, nested-route conflicts are detected and produce a useful error message, dev middleware still resolves correctly under both modes.
- CHANGELOG entry under whatever the next minor version is.

**Pair with `minify`**: See the next entry. Both features are spiritually identical ("what shape do you want dist/ in") and both are wanted by the same downstream user (phillipharrington.com). Worth bundling them into a single 0.3.0 release: "shape options for dist/."

**Until this lands**: phillipharrington-2 has `scripts/flatten-dist.mjs` doing this as a per-site post-processor. When `flatRoutes` ships in graspr-build, that script gets deleted, the buildspec drops the flatten step, and the README's mention of `scripts/flatten-dist.mjs` goes away.

**User's posture**: "remember that it's a thing i like and should be an option on graspr-build's build pages — but don't try to implement it everywhere just yet" (2026-04-08). Don't implement proactively — wait until explicitly asked, or until naturally working on graspr-build for another reason and it makes sense to bundle in.

---

### `buildPages({ minify: true })` — HTML page minification

**What**: Add a `minify` option to `buildPages()` (and the `grasprBuild()` Vite plugin's build path, if applicable) that runs each rendered page through `html-minifier-terser` before writing to disk.

**Why**: graspr-build currently writes pages verbatim. Vite already minifies CSS+JS as part of `vite build`, but the HTML pages emitted by `graspr-build-pages` are full-fat — significant whitespace, attribute quotes, comments, etc. For phillipharrington.com specifically, the existing site (pre-graspr port) used `html-minifier` and saved roughly 10–15% on raw HTML size, ~3–5% after gzip. Not huge, but free if the build mechanic supports it. The previous build script for that site had been doing this for years and the user noticed the regression after the port.

**How to apply**:

- Add `html-minifier-terser` as an **optional peer dependency** (not a regular dep — consumers who don't want it shouldn't pay for the install).
- In `buildPages()`, when `opts.minify === true`, dynamically `import('html-minifier-terser')` and run each rendered page through it before `fs.writeFile`.
- If the dynamic import fails (peer dep not installed), throw a clear error: `buildPages({ minify: true }) requires the html-minifier-terser peer dependency. Install it: npm i -D html-minifier-terser`. Same opt-in dep pattern eslint plugins use.
- Default `minify: false` — no behavior change for existing consumers.
- Sensible default minifier options matching what the original phillipharrington.com build used:
  ```js
  {
      removeAttributeQuotes: true,
      collapseWhitespace: true,
      removeComments: true,
      removeRedundantAttributes: true,
      removeScriptTypeAttributes: true,
      removeTagWhitespace: true,
  }
  ```
- Allow consumers to override these via a richer `opts.minify` shape: `minify: true` uses defaults, `minify: { ...overrides }` merges with defaults. Same shape as a lot of other build tools.
- Pipe the option through `grasprBuild()`'s vite plugin too if there's a use case for minified dev output (probably not — dev should stay readable for debugging).
- Add tests covering: `minify: true` actually shrinks output, `minify: false` (default) leaves output unchanged, `minify: { collapseWhitespace: false }` overrides take effect, missing peer dep throws the expected error.
- CHANGELOG entry under whatever the next minor version is.

**Pair with `flatRoutes`**: See the entry above. Both features are spiritually identical ("what shape do you want dist/ in") and both are wanted by the same downstream user (phillipharrington.com). Worth bundling them into a single 0.3.0 release: "shape options for dist/."

**Until this lands**: phillipharrington.com can either accept the size regression or run a per-site `scripts/minify-dist.mjs` post-processor (same shape as its existing `scripts/flatten-dist.mjs`). When `minify: true` ships in graspr-build, that per-site script gets deleted.

---

## Format note

Each entry should have: **What** (one-line summary), **Why** (motivation, ideally with concrete numbers or a referenced incident), **How to apply** (enough detail that picking it up later doesn't require re-deriving the design). Move entries out of this file when they ship — they should land in `CHANGELOG.md` instead.
