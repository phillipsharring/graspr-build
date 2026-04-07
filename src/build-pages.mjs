import fs from 'node:fs/promises';
import path from 'node:path';
import { renderPage } from './html-compiler.mjs';
import { titleFromUrlPath, routeAndOutDirFromPageRel } from './url-helpers.mjs';

async function readManifest(distDir) {
    const manifestPath = path.join(distDir, '.vite', 'manifest.json');
    try {
        const json = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(json);
    } catch {
        return null;
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
 */
export async function buildPages(opts = {}) {
    const root = opts.root || process.cwd();
    const distDir = opts.distDir || path.join(root, 'dist');
    const layoutsDir = opts.layoutsDir || path.join(root, 'content', 'layouts');
    const siteConfig = opts.siteConfig || {};

    const pagesDirs = toArrayOption(opts.pagesDirs, opts.pagesDir, path.join(root, 'content', 'pages'));
    const componentsDirs = toArrayOption(opts.componentsDirs, opts.componentsDir, path.join(root, 'content', 'components'));

    const manifest = await readManifest(distDir);
    const { jsSrc, cssHref } = resolveAssetsFromManifest(manifest);

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

    for (const p of pages) {
        const html = await renderPage({
            layoutsDir,
            pagePath: p.pagePath,
            title: p.title,
            componentsDir: componentsDirs,
            siteConfig,
            jsSrc,
            cssHref,
        });

        await writeFile(path.join(p.outDir, 'index.html'), html);
    }

    console.log(
        'Built pages:',
        pages.map((p) => `${p.route} -> ${path.relative(root, path.join(p.outDir, 'index.html'))}`).join(', ')
    );

    return pages;
}
