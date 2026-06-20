import path from 'node:path';

export function normalizeUrlPath(urlPath) {
    if (!urlPath) return '/';
    if (urlPath === '/') return '/';
    return urlPath.endsWith('/') ? urlPath : `${urlPath}/`;
}

export function titleFromUrlPath(urlPath) {
    const p = normalizeUrlPath(urlPath);
    if (p === '/') return '';
    const segs = p
        .replace(/^\/|\/$/g, '')
        .split('/')
        .filter(Boolean);
    const last = segs[segs.length - 1] || 'Page';
    return last
        .split(/[-_]+/g)
        .filter(Boolean)
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Convert a page file's relative path under content/pages/ into a route + output dir.
 *
 * - `index.html`           -> `/`               -> distDir
 * - `about.html`           -> `/about/`         -> distDir/about
 * - `blog/index.html`      -> `/blog/`          -> distDir/blog
 * - `blog/post.html`       -> `/blog/post/`     -> distDir/blog/post
 */
export function routeAndOutDirFromPageRel(relPath, distDir) {
    const rel = relPath.replaceAll(path.sep, '/');
    if (rel === 'index.html') {
        return { route: '/', outDir: distDir };
    }

    const dir = path.posix.dirname(rel);
    const base = path.posix.basename(rel);

    if (base === 'index.html') {
        const route = `/${dir}/`.replaceAll('//', '/');
        return { route, outDir: path.join(distDir, dir) };
    }

    const name = base.slice(0, -'.html'.length);
    const route = `/${dir === '.' ? '' : `${dir}/`}${name}/`.replaceAll('//', '/');
    const outDir = path.join(distDir, dir === '.' ? '' : dir, name);
    return { route, outDir };
}

/**
 * Normalize a route into its key form: no leading/trailing slashes.
 *
 * - `/`            -> `''`
 * - `/about/`      -> `'about'`
 * - `/blog/post/`  -> `'blog/post'`
 *
 * This is the form used to match `flatRoutes.keepExtension` entries, so a
 * consumer writes `keepExtension: ['404']` or `['errors/404']` rather than
 * worrying about slashes.
 */
export function routeKey(route) {
    return route.replace(/^\/|\/$/g, '');
}

function routeSegments(route) {
    return routeKey(route).split('/').filter(Boolean);
}

function isProperPrefix(a, b) {
    if (a.length >= b.length) return false;
    return a.every((seg, i) => seg === b[i]);
}

/**
 * Normalize the `flatRoutes` option into a settings object, or `null` when the
 * feature is off (the default).
 *
 * - `false`/`undefined`            -> null (directory-style output, no change)
 * - `true`                         -> defaults: keep `404` extensionful
 * - `{ keepExtension: [...] }`     -> custom keep list (route keys)
 *
 * @param {boolean|{keepExtension?: string[]}} [opt]
 * @returns {{keepExtension: Set<string>} | null}
 */
export function resolveFlatRoutes(opt) {
    if (!opt) return null;
    const keep = opt === true ? undefined : opt.keepExtension;
    return { keepExtension: new Set(keep ?? ['404']) };
}

/**
 * Resolve the on-disk output file path for a baked page.
 *
 * - root `/` is always `dist/index.html` (it can't be an extensionless file).
 * - `flatRoutes` off: `<outDir>/index.html` (directory-style, the default).
 * - `flatRoutes` on, route kept: `<outDir>.html` (e.g. `dist/404.html`).
 * - `flatRoutes` on, normal: `<outDir>` (extensionless file, e.g. `dist/about`).
 *
 * @param {string} route
 * @param {string} outDir   - directory-form output dir from routeAndOutDirFromPageRel
 * @param {string} distDir
 * @param {{keepExtension: Set<string>} | null} flatRoutes
 * @returns {string}
 */
export function outFileFromRoute(route, outDir, distDir, flatRoutes) {
    if (route === '/') return path.join(distDir, 'index.html');
    if (!flatRoutes) return path.join(outDir, 'index.html');
    if (flatRoutes.keepExtension.has(routeKey(route))) return `${outDir}.html`;
    return outDir;
}

/**
 * Hard-error on nested-route conflicts under `flatRoutes`. A page that flattens
 * to an extensionless file (`dist/blog`) cannot coexist with a nested page that
 * needs that same path to be a directory (`dist/blog/post`). On a real
 * filesystem `dist/blog` is either a file or a directory, never both.
 *
 * Kept-extension pages (e.g. `dist/404.html`) and the root page never claim a
 * bare path, so they can't be the file side of a conflict — but they can still
 * be the nested side that forces a parent directory.
 *
 * @param {Array<{route: string, filePath: string, keep: boolean}>} entries
 * @param {string} projectRoot - for relative paths in the error message
 */
export function assertNoFlatRouteConflicts(entries, projectRoot) {
    const withSegs = entries.map((e) => ({ ...e, segs: routeSegments(e.route) }));
    const fileRoutes = withSegs.filter((e) => e.route !== '/' && !e.keep);

    for (const file of fileRoutes) {
        for (const other of withSegs) {
            if (!isProperPrefix(file.segs, other.segs)) continue;
            const bare = file.segs.join('/');
            throw new Error(
                `Flattened route ${file.route} conflicts with nested route ${other.route}:\n` +
                `  - ${path.relative(projectRoot, file.filePath)} would be written as the file dist/${bare}\n` +
                `  - ${path.relative(projectRoot, other.filePath)} needs dist/${bare}/ to be a directory\n` +
                `A page route cannot be both a file and a parent directory when flatRoutes is enabled. ` +
                `Move one of the pages, or add '${routeKey(file.route)}' to flatRoutes.keepExtension ` +
                `to keep it as dist/${bare}.html.`
            );
        }
    }
}
