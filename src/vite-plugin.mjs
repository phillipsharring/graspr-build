import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPage } from './html-compiler.mjs';
import { normalizeUrlPath, titleFromUrlPath } from './url-helpers.mjs';

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
 * @returns {Promise<Map<string, string>>}
 */
async function buildRouteIndex(pagesDirs, projectRoot) {
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
 */
export function grasprBuild(opts = {}) {
    const siteConfig = opts.siteConfig || {};
    const jsSrc = opts.jsSrc || '/app.js';

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
                    routeIndexPromise = buildRouteIndex(pagesDirs, projectRoot);
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
                    const url = (req.url || '/').split('?')[0];
                    const ext = path.extname(url).toLowerCase();
                    if (ext && ext !== '.html') return next();

                    // Trigger / surface any cross-root conflicts on the first
                    // request. After this, the index is cached in-memory.
                    await getRouteIndex();

                    const pagePath = await resolvePagePath(normalizeUrlPath(url));
                    if (!pagePath) return next();

                    const html = await renderPage({
                        layoutsDir,
                        pagePath,
                        componentsDir: componentsDirs,
                        siteConfig,
                        title: titleFromUrlPath(url),
                        jsSrc,
                        cssHref: null,
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
