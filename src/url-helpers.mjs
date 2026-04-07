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
