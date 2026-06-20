import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPage } from './html-compiler.mjs';
import {
    titleFromUrlPath,
    routeAndOutDirFromPageRel,
    routeKey,
    resolveFlatRoutes,
    outFileFromRoute,
    assertNoFlatRouteConflicts,
} from './url-helpers.mjs';
import { createHtmlMinifier } from './minify.mjs';

async function readManifest(distDir) {
    const manifestPath = path.join(distDir, '.vite', 'manifest.json');
    try {
        const json = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(json);
    } catch {
        return null;
    }
}

/**
 * Remove Vite's build manifest once its asset hashes have been baked into the
 * rendered pages. It's build-internal state that has no business being deployed
 * (a naive `aws s3 sync dist/` would otherwise ship it to a public bucket). Vite
 * regenerates it on every build, so deleting it here loses nothing.
 *
 * No-ops if the manifest isn't there (e.g. `buildPages()` was called without a
 * preceding `vite build`). The `.vite/` directory is removed too, but only when
 * it's left empty.
 */
async function cleanupViteManifest(distDir) {
    const viteDir = path.join(distDir, '.vite');
    try {
        await fs.unlink(path.join(viteDir, 'manifest.json'));
    } catch {
        return; // nothing to clean up
    }
    try {
        await fs.rmdir(viteDir); // only succeeds if now empty; otherwise leave it
    } catch {
        // .vite/ still has other files, or is already gone — fine either way
    }
}

function resolveAssetsFromManifest(manifest) {
    if (!manifest) return { jsSrc: '/assets/app.js', cssHref: '/assets/app.css' };

    const entry = Object.values(manifest).find((v) => v.isEntry);
    const jsFile = entry?.file ? `/${entry.file}` : null;
    const cssFile = entry?.css?.[0] ? `/${entry.css[0]}` : null;

    return { jsSrc: jsFile, cssHref: cssFile };
}

async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

async function writeFile(filePath, contents) {
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, contents, 'utf-8');
}

async function listHtmlFilesRecursive(dir) {
    /** @type {string[]} */
    const out = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            out.push(...(await listHtmlFilesRecursive(full)));
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html') && !ent.name.startsWith('_')) {
            out.push(full);
        }
    }
    return out;
}

/**
 * Normalize a singular-or-array option into a non-empty array. If both the
 * plural and singular forms are provided, the plural wins.
 *
 * @param {string|string[]|undefined} plural
 * @param {string|undefined} singular
 * @param {string} fallback - default value when neither is provided
 * @returns {string[]}
 */
function toArrayOption(plural, singular, fallback) {
    if (Array.isArray(plural)) return plural.slice();
    if (typeof plural === 'string') return [plural];
    if (typeof singular === 'string') return [singular];
    return [fallback];
}

/**
 * Bake all pages under one or more content/pages/ roots into dist/<route>/index.html.
 *
 * Multi-root support is how frontend modules contribute pages to the host app:
 * the app's own `content/pages/` is the first root, and each enabled module's
 * `pages/` directory is appended. Files from all roots are merged and routed
 * by their relative path within their own root — so `modules/blog/pages/posts/index.html`
 * routes to `/posts/` exactly the same as `content/pages/posts/index.html` would.
 *
 * Route conflicts across roots are a HARD ERROR (mirrors backend Router conflict
 * detection in handlr-framework v0.5+). The error message names both source files
 * so you can locate the collision immediately.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]                       - Project root. Defaults to process.cwd().
 * @param {object} [opts.siteConfig]                 - Site-wide values injected into layouts via [[propName]].
 * @param {string} [opts.distDir]                    - Override dist output dir. Defaults to <root>/dist.
 * @param {string|string[]} [opts.pagesDirs]         - One or more directories to scan for page files. Order matters for diagnostics.
 * @param {string} [opts.pagesDir]                   - Back-compat singular form. Use `pagesDirs` for new code.
 * @param {string} [opts.layoutsDir]                 - Layouts dir. Defaults to <root>/content/layouts. Single root by design — layouts are app-level.
 * @param {string|string[]} [opts.componentsDirs]    - One or more component dirs (later entries override earlier ones for same-name lookups).
 * @param {string|string[]} [opts.componentsDir]     - Back-compat alias for `componentsDirs`.
 * @param {boolean|{keepExtension?: string[]}} [opts.flatRoutes] - Emit extensionless files (`dist/about`) instead of `dist/about/index.html`. `true` uses defaults (keeps `404` as `dist/404.html`); pass `{ keepExtension: [...] }` (route keys) to override. Defaults to `false` — no behavior change.
 * @param {boolean|object} [opts.minify] - Minify each rendered page via the optional `html-minifier-terser` peer dep. `true` uses sensible defaults; pass an object to override them (merged onto the defaults). Defaults to `false`. Throws if `true` but the peer dep isn't installed.
 */
export async function buildPages(opts = {}) {
    const root = opts.root || process.cwd();
    const distDir = opts.distDir || path.join(root, 'dist');
    const layoutsDir = opts.layoutsDir || path.join(root, 'content', 'layouts');
    const siteConfig = opts.siteConfig || {};
    const flatRoutes = resolveFlatRoutes(opts.flatRoutes);

    // Resolve the minifier up front so a missing peer dep fails before we render
    // a single page. Returns null when minify is off.
    const minifyHtml = await createHtmlMinifier(opts.minify);

    const pagesDirs = toArrayOption(opts.pagesDirs, opts.pagesDir, path.join(root, 'content', 'pages'));
    const componentsDirs = toArrayOption(opts.componentsDirs, opts.componentsDir, path.join(root, 'content', 'components'));

    const manifest = await readManifest(distDir);
    const { jsSrc, cssHref } = resolveAssetsFromManifest(manifest);

    // The manifest's hashes are now captured in jsSrc/cssHref and about to be
    // baked into every page — drop the build-internal file so it doesn't ship.
    await cleanupViteManifest(distDir);

    // Walk every pages root, tagging each discovered file with its source root
    // so route resolution and conflict diagnostics know where it came from.
    /** @type {Array<{filePath: string, sourceDir: string}>} */
    const allEntries = [];
    for (const dir of pagesDirs) {
        const files = await listHtmlFilesRecursive(dir);
        for (const filePath of files) {
            allEntries.push({ filePath, sourceDir: dir });
        }
    }

    // Within each source dir, prefer directory index pages (foo/index.html) over
    // same-route flat pages (foo.html). Stable across roots: earlier roots win
    // ties when filenames are equivalent.
    allEntries.sort((a, b) => {
        const aBase = path.basename(a.filePath).toLowerCase();
        const bBase = path.basename(b.filePath).toLowerCase();
        if (aBase === 'index.html' && bBase !== 'index.html') return -1;
        if (bBase === 'index.html' && aBase !== 'index.html') return 1;
        return a.filePath.localeCompare(b.filePath);
    });

    /** @type {Array<{route:string, outDir:string, pagePath:string, title:string}>} */
    const pages = [];
    /** @type {Map<string, string>} route -> first filePath that claimed it */
    const seen = new Map();

    for (const { filePath, sourceDir } of allEntries) {
        const rel = path.relative(sourceDir, filePath);
        const { route, outDir } = routeAndOutDirFromPageRel(rel, distDir);

        if (seen.has(route)) {
            const firstFile = seen.get(route);
            throw new Error(
                `Route ${route} is declared twice:\n` +
                `  - ${path.relative(root, firstFile)}\n` +
                `  - ${path.relative(root, filePath)}\n` +
                `Each route must be owned by exactly one page file across all pagesDirs.`
            );
        }

        seen.set(route, filePath);
        pages.push({
            route,
            outDir,
            pagePath: filePath,
            title: titleFromUrlPath(route),
        });
    }

    // Under flatRoutes, a page that flattens to an extensionless file can't share
    // a path with a nested page that needs that path to be a directory. Surface
    // this before writing anything so the build fails cleanly.
    if (flatRoutes) {
        assertNoFlatRouteConflicts(
            pages.map((p) => ({
                route: p.route,
                filePath: p.pagePath,
                keep: flatRoutes.keepExtension.has(routeKey(p.route)),
            })),
            root
        );
    }

    for (const p of pages) {
        let html = await renderPage({
            layoutsDir,
            pagePath: p.pagePath,
            title: p.title,
            componentsDir: componentsDirs,
            siteConfig,
            jsSrc,
            cssHref,
        });

        if (minifyHtml) html = await minifyHtml(html);

        p.outFile = outFileFromRoute(p.route, p.outDir, distDir, flatRoutes);
        await writeFile(p.outFile, html);
    }

    console.log(
        'Built pages:',
        pages.map((p) => `${p.route} -> ${path.relative(root, p.outFile)}`).join(', ')
    );

    return pages;
}
