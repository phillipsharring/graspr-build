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
 * Bake all pages under content/pages/ into dist/<route>/index.html.
 *
 * @param {object} [opts]
 * @param {string} [opts.root]            - Project root. Defaults to process.cwd().
 * @param {object} [opts.siteConfig]      - Site-wide values injected into layouts via [[propName]].
 * @param {string} [opts.distDir]         - Override dist output dir. Defaults to <root>/dist.
 * @param {string} [opts.pagesDir]        - Override pages dir. Defaults to <root>/content/pages.
 * @param {string} [opts.layoutsDir]      - Override layouts dir. Defaults to <root>/content/layouts.
 * @param {string|string[]} [opts.componentsDir] - Override components dir(s). Defaults to <root>/content/components.
 */
export async function buildPages(opts = {}) {
    const root = opts.root || process.cwd();
    const distDir = opts.distDir || path.join(root, 'dist');
    const pagesDir = opts.pagesDir || path.join(root, 'content', 'pages');
    const layoutsDir = opts.layoutsDir || path.join(root, 'content', 'layouts');
    const componentsDir = opts.componentsDir || path.join(root, 'content', 'components');
    const siteConfig = opts.siteConfig || {};

    const manifest = await readManifest(distDir);
    const { jsSrc, cssHref } = resolveAssetsFromManifest(manifest);

    const pageFiles = await listHtmlFilesRecursive(pagesDir);

    // Prefer directory index pages (foo/index.html) over same-route flat pages (foo.html).
    pageFiles.sort((a, b) => {
        const aBase = path.basename(a).toLowerCase();
        const bBase = path.basename(b).toLowerCase();
        if (aBase === 'index.html' && bBase !== 'index.html') return -1;
        if (bBase === 'index.html' && aBase !== 'index.html') return 1;
        return a.localeCompare(b);
    });

    /** @type {Array<{route:string, outDir:string, pagePath:string, title:string}>} */
    const pages = [];
    const seen = new Map();

    for (const filePath of pageFiles) {
        const rel = path.relative(pagesDir, filePath);
        const { route, outDir } = routeAndOutDirFromPageRel(rel, distDir);
        if (seen.has(route)) {
            console.warn(
                `Duplicate route ${route} from ${path.relative(root, filePath)}; keeping ${path.relative(
                    root,
                    seen.get(route)
                )}`
            );
            continue;
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
            componentsDir,
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
