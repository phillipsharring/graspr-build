import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPage } from './html-compiler.mjs';
import {
    normalizeUrlPath,
    titleFromUrlPath,
    routeKey,
    resolveFlatRoutes,
    assertNoFlatRouteConflicts,
} from './url-helpers.mjs';

async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function listHtmlFiles(dir) {
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
            out.push(...(await listHtmlFiles(full)));
        } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.html') && !ent.name.startsWith('_')) {
            out.push(full);
        }
    }
    return out;
}

function templatePathToRoute(relPath) {
    const rel = relPath.replaceAll(path.sep, '/');
    if (rel === 'index.html') return '/';
    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);
    if (base === 'index.html') return `/${dir}/`.replace(/\/\//g, '/');
    const name = base.slice(0, -'.html'.length);
    return `/${dir === '.' ? '' : `${dir}/`}${name}/`.replace(/\/\//g, '/');
}

function matchesRoutePattern(urlPath, patternRoute) {
    const urlNorm = normalizeUrlPath(urlPath);
    const patternNorm = normalizeUrlPath(patternRoute);
    const urlSegments = urlNorm.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
    const patternSegments = patternNorm.replace(/^\/|\/$/g, '').split('/').filter(Boolean);
    if (urlSegments.length !== patternSegments.length) return false;
    for (let i = 0; i < urlSegments.length; i++) {
        if (patternSegments[i].startsWith('[') && patternSegments[i].endsWith(']')) continue;
        if (urlSegments[i] !== patternSegments[i]) return false;
    }
    return true;
}

/**
 * Normalize a singular-or-array option into a non-empty array. If both the
 * plural and singular forms are provided, the plural wins.
 */
function toArrayOption(plural, singular, fallback) {
    if (Array.isArray(plural)) return plural.slice();
    if (typeof plural === 'string') return [plural];
    if (typeof singular === 'string') return [singular];
    return [fallback];
}

/**
 * Walk every pagesDir, mapping each unique route to a single file. Throws if
 * two roots both claim the same route — same semantics as `buildPages()` so
 * that dev and prod surface conflicts the same way.
 *
 * @param {string[]} pagesDirs
 * @param {string} projectRoot - for relative paths in error messages
 * @param {{keepExtension: Set<string>} | null} [flatRoutes] - when set, also enforce nested-route conflict rules so dev fails like prod
 * @returns {Promise<Map<string, string>>}
 */
async function buildRouteIndex(pagesDirs, projectRoot, flatRoutes = null) {
    /** @type {Map<string, string>} route -> filePath */
    const routes = new Map();

    for (const dir of pagesDirs) {
        const files = await listHtmlFiles(dir);
        // Stable order: index pages first within each root, then alphabetical
        files.sort((a, b) => {
            const aBase = path.basename(a).toLowerCase();
            const bBase = path.basename(b).toLowerCase();
            if (aBase === 'index.html' && bBase !== 'index.html') return -1;
            if (bBase === 'index.html' && aBase !== 'index.html') return 1;
            return a.localeCompare(b);
        });

        for (const filePath of files) {
            const rel = path.relative(dir, filePath);
            const route = templatePathToRoute(rel);
            if (routes.has(route)) {
                const firstFile = routes.get(route);
                throw new Error(
                    `Route ${route} is declared twice:\n` +
                    `  - ${path.relative(projectRoot, firstFile)}\n` +
                    `  - ${path.relative(projectRoot, filePath)}\n` +
                    `Each route must be owned by exactly one page file across all pagesDirs.`
                );
            }
            routes.set(route, filePath);
        }
    }

    // Mirror the build-time nested-route conflict check so `vite dev` surfaces
    // the same error as `npm run build` instead of masking it until deploy.
    if (flatRoutes) {
        assertNoFlatRouteConflicts(
            [...routes].map(([route, filePath]) => ({
                route,
                filePath,
                keep: flatRoutes.keepExtension.has(routeKey(route)),
            })),
            projectRoot
        );
    }

    return routes;
}

/**
 * Vite plugin: middleware that renders Graspr pages on the fly during `vite dev`.
 *
 * Supports multi-root page discovery so frontend modules can drop their own
 * `pages/` directories into the build without touching app code. Resolution
 * walks every configured root in order; first match wins for static routes,
 * and dynamic `[id]`/`[slug]` segments fall back to a full scan.
 *
 * Resolution order for an incoming GET:
 *   1. /                  -> <each pagesDir>/index.html
 *   2. /foo/              -> <each pagesDir>/foo.html
 *   3. /foo/              -> <each pagesDir>/foo/index.html
 *   4. /foo/123/          -> <each pagesDir>/foo/[id].html (dynamic segment)
 *
 * @param {object} [opts]
 * @param {object} [opts.siteConfig]
 * @param {string} [opts.layoutsDir]              - Defaults to <cwd>/content/layouts. Single root by design.
 * @param {string|string[]} [opts.pagesDirs]      - One or more page roots. Defaults to [<cwd>/content/pages].
 * @param {string} [opts.pagesDir]                - Back-compat singular form. Use `pagesDirs`.
 * @param {string|string[]} [opts.componentsDirs] - One or more component roots.
 * @param {string|string[]} [opts.componentsDir]  - Back-compat alias.
 * @param {string} [opts.jsSrc]                   - Path to dev JS entry. Defaults to '/app.js'.
 * @param {boolean|{keepExtension?: string[]}} [opts.flatRoutes] - Match the build's extensionless-output mode. Falls back to `siteConfig.flatRoutes` when omitted, so setting it once in `site.config.js` covers both dev and build. Dev serving is unaffected (URLs already resolve without redirects); this only enables the nested-route conflict check so dev fails like prod. Defaults to `false`.
 * @param {string} [opts.devCss] - Dev-only: URL of the source stylesheet, with Vite's `?direct` query (e.g. `/styles/style.css?direct`). `?direct` is required for a Vite-processed CSS module — without it Vite serves the file as a JS module (`text/javascript`) and the browser refuses it as a stylesheet. When set, dev pages get a render-blocking `<link rel="stylesheet">` instead of relying on JS-injected CSS, eliminating the flash of unstyled content. Vite still hot-reloads it. Falls back to `siteConfig.devCss`. Ignored by the production build (which uses the hashed CSS from the manifest).
 */
export function grasprBuild(opts = {}) {
    const siteConfig = opts.siteConfig || {};
    const jsSrc = opts.jsSrc || '/app.js';
    const flatRoutes = resolveFlatRoutes(opts.flatRoutes ?? siteConfig.flatRoutes);
    const devCss = opts.devCss ?? siteConfig.devCss ?? null;

    return {
        name: 'graspr-build:dev-baked-pages',
        apply: 'serve',
        configureServer(server) {
            const projectRoot = process.cwd();
            const layoutsDir = opts.layoutsDir || path.join(projectRoot, 'content', 'layouts');
            const pagesDirs = toArrayOption(opts.pagesDirs, opts.pagesDir, path.join(projectRoot, 'content', 'pages'));
            const componentsDirs = toArrayOption(opts.componentsDirs, opts.componentsDir, path.join(projectRoot, 'content', 'components'));

            // Verify there are no static-route collisions across roots up front,
            // so the dev server fails loud and early instead of silently masking
            // a conflict that would blow up in `npm run build`. Async, fire on
            // first incoming request via the cache below.
            /** @type {Promise<Map<string,string>> | null} */
            let routeIndexPromise = null;
            function getRouteIndex() {
                if (routeIndexPromise === null) {
                    routeIndexPromise = buildRouteIndex(pagesDirs, projectRoot, flatRoutes);
                }
                return routeIndexPromise;
            }

            async function findStaticRoute(urlPath) {
                const p = normalizeUrlPath(urlPath);
                if (p === '/') {
                    for (const dir of pagesDirs) {
                        const indexPath = path.join(dir, 'index.html');
                        if (await fileExists(indexPath)) return indexPath;
                    }
                    return null;
                }
                const rel = p.replace(/^\/|\/$/g, '');
                for (const dir of pagesDirs) {
                    const direct = path.join(dir, `${rel}.html`);
                    if (await fileExists(direct)) return direct;
                    const index = path.join(dir, rel, 'index.html');
                    if (await fileExists(index)) return index;
                }
                return null;
            }

            async function findDynamicRoute(urlPath) {
                for (const dir of pagesDirs) {
                    try {
                        const allFiles = await listHtmlFiles(dir);
                        for (const filePath of allFiles) {
                            const rel = path.relative(dir, filePath);
                            if (matchesRoutePattern(urlPath, templatePathToRoute(rel))) return filePath;
                        }
                    } catch {}
                }
                return null;
            }

            async function resolvePagePath(urlPath) {
                const direct = await findStaticRoute(urlPath);
                if (direct) return direct;
                return await findDynamicRoute(urlPath);
            }

            server.middlewares.use(async (req, res, next) => {
                try {
                    if (req.method !== 'GET') return next();
                    const rawUrl = req.url || '/';
                    const qIdx = rawUrl.indexOf('?');
                    const url = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
                    const queryString = qIdx === -1 ? '' : rawUrl.slice(qIdx);
                    const ext = path.extname(url).toLowerCase();
                    if (ext && ext !== '.html') return next();

                    // Trigger / surface any cross-root conflicts on the first
                    // request. After this, the index is cached in-memory.
                    await getRouteIndex();

                    const pagePath = await resolvePagePath(normalizeUrlPath(url));
                    if (!pagePath) return next();

                    // Canonicalize directory-style URLs with a trailing slash.
                    // If the resolved page is an index.html (i.e., URL refers
                    // to a directory) but the request URL has no trailing
                    // slash, 301 to the canonical form. Keeps relative asset
                    // resolution and per-prefix permission checks consistent
                    // with prod (CloudFront rewrites assume the trailing slash).
                    if (!url.endsWith('/') && path.basename(pagePath).toLowerCase() === 'index.html') {
                        res.statusCode = 301;
                        res.setHeader('Location', url + '/' + queryString);
                        res.end();
                        return;
                    }

                    const html = await renderPage({
                        layoutsDir,
                        pagePath,
                        componentsDir: componentsDirs,
                        siteConfig,
                        title: titleFromUrlPath(url),
                        jsSrc,
                        cssHref: devCss,
                    });

                    const transformed = await server.transformIndexHtml(url, html);
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'text/html');
                    res.end(transformed);
                } catch (err) {
                    next(err);
                }
            });
        },
    };
}
