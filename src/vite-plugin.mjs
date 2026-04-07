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
 * Vite plugin: middleware that renders Graspr pages on the fly during `vite dev`.
 *
 * Resolution order for an incoming GET:
 *   1. /                  -> content/pages/index.html
 *   2. /foo/              -> content/pages/foo.html
 *   3. /foo/              -> content/pages/foo/index.html
 *   4. /foo/123/          -> content/pages/foo/[id].html (dynamic segment)
 *
 * @param {object} [opts]
 * @param {object} [opts.siteConfig]
 * @param {string} [opts.layoutsDir]      - Defaults to <cwd>/content/layouts.
 * @param {string} [opts.pagesDir]        - Defaults to <cwd>/content/pages.
 * @param {string|string[]} [opts.componentsDir] - Defaults to <cwd>/content/components.
 * @param {string} [opts.jsSrc]           - Path to dev JS entry. Defaults to '/app.js'.
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
            const pagesDir = opts.pagesDir || path.join(projectRoot, 'content', 'pages');
            const componentsDir = opts.componentsDir || path.join(projectRoot, 'content', 'components');

            async function findDynamicRoute(urlPath) {
                try {
                    const allFiles = await listHtmlFiles(pagesDir);
                    for (const filePath of allFiles) {
                        const rel = path.relative(pagesDir, filePath);
                        if (matchesRoutePattern(urlPath, templatePathToRoute(rel))) return filePath;
                    }
                } catch {}
                return null;
            }

            async function resolvePagePath(urlPath) {
                const p = normalizeUrlPath(urlPath);
                if (p === '/') return path.join(pagesDir, 'index.html');
                const rel = p.replace(/^\/|\/$/g, '');
                const direct = path.join(pagesDir, `${rel}.html`);
                const index = path.join(pagesDir, rel, 'index.html');
                if (await fileExists(direct)) return direct;
                if (await fileExists(index)) return index;
                return await findDynamicRoute(urlPath);
            }

            server.middlewares.use(async (req, res, next) => {
                try {
                    if (req.method !== 'GET') return next();
                    const url = (req.url || '/').split('?')[0];
                    const ext = path.extname(url).toLowerCase();
                    if (ext && ext !== '.html') return next();

                    const pagePath = await resolvePagePath(normalizeUrlPath(url));
                    if (!pagePath) return next();

                    const html = await renderPage({
                        layoutsDir,
                        pagePath,
                        componentsDir,
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
