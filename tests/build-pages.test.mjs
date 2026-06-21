import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildPages } from '../src/build-pages.mjs';
import { grasprBuild } from '../src/vite-plugin.mjs';
import { createHtmlMinifier, resolveMinifyOptions } from '../src/minify.mjs';

const BIN_PATH = fileURLToPath(new URL('../bin/build-pages.mjs', import.meta.url));

// A page with an HTML comment and collapsible whitespace, so minification has
// something visible to remove.
const MINIFIABLE_PAGE = '<h1>About</h1>\n\n<!-- build comment -->\n<p>   hello   </p>';

/**
 * Drive the dev plugin's middleware once for a given URL and return either the
 * Error passed to next() (e.g. a route conflict) or the string 'ended' if the
 * page rendered and the response was flushed. Avoids standing up a real Vite
 * server while still exercising configureServer + the middleware wiring.
 */
async function runDevMiddleware({ pagesDir, layoutsDir, componentsDir, flatRoutes, siteConfig, url }) {
    const plugin = grasprBuild({ pagesDirs: [pagesDir], layoutsDir, componentsDir, flatRoutes, siteConfig });
    let middleware;
    plugin.configureServer({
        middlewares: { use: (fn) => { middleware = fn; } },
        transformIndexHtml: async (_url, html) => html,
    });
    return await new Promise((resolve) => {
        const res = { statusCode: 0, setHeader() {}, end() { resolve('ended'); } };
        const next = (err) => resolve(err instanceof Error ? err : 'next');
        middleware({ method: 'GET', url }, res, next);
    });
}

/**
 * Build a tmp project directory with the given page files distributed across
 * one or more pages roots, plus a minimal layouts dir and an empty components
 * dir. Returns the project root path.
 *
 * @param {{[rootName: string]: {[relPath: string]: string}}} pageRoots
 *   e.g. { app: { 'index.html': '...' }, 'modules/blog': { 'blog/index.html': '...' } }
 */
async function makeFixture(pageRoots) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graspr-build-test-'));

    // Minimal base layout — just enough placeholders for renderPage() to substitute.
    const layoutsDir = path.join(root, 'content', 'layouts');
    await fs.mkdir(layoutsDir, { recursive: true });
    await fs.writeFile(
        path.join(layoutsDir, 'base.html'),
        '<!doctype html><html><head><title>[[title]]TestSite</title>[[cssHref]][[jsSrc]][[pageHead]]</head><body><main id="app">[[app]]</main></body></html>',
        'utf-8'
    );

    const componentsDir = path.join(root, 'content', 'components');
    await fs.mkdir(componentsDir, { recursive: true });

    // Create dist + a fake vite manifest so resolveAssetsFromManifest doesn't
    // fall back (which would still work, but this exercises the realistic path).
    const distDir = path.join(root, 'dist');
    await fs.mkdir(path.join(distDir, '.vite'), { recursive: true });
    await fs.writeFile(
        path.join(distDir, '.vite', 'manifest.json'),
        JSON.stringify({
            'app.js': { file: 'assets/app-test.js', isEntry: true, css: ['assets/app-test.css'] },
        }),
        'utf-8'
    );

    // Now write each pages root's files.
    const pagesDirs = [];
    for (const [rootName, files] of Object.entries(pageRoots)) {
        const dir = path.join(root, rootName);
        for (const [rel, contents] of Object.entries(files)) {
            const full = path.join(dir, rel);
            await fs.mkdir(path.dirname(full), { recursive: true });
            await fs.writeFile(full, contents, 'utf-8');
        }
        pagesDirs.push(dir);
    }

    return { root, distDir, layoutsDir, componentsDir, pagesDirs };
}

async function cleanup(root) {
    await fs.rm(root, { recursive: true, force: true });
}

// ── Back-compat: singular pagesDir still works ──

test('buildPages accepts a single pagesDir (back-compat)', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        const pages = await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0], // singular form
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        const routes = pages.map((p) => p.route).sort();
        assert.deepEqual(routes, ['/', '/about/']);

        // Output files actually exist on disk.
        const home = await fs.readFile(path.join(fx.distDir, 'index.html'), 'utf-8');
        assert.match(home, /<h1>Home<\/h1>/);
        const about = await fs.readFile(path.join(fx.distDir, 'about', 'index.html'), 'utf-8');
        assert.match(about, /<h1>About<\/h1>/);
    } finally {
        await cleanup(fx.root);
    }
});

// ── Multi-root: pagesDirs[] merges files from every root ──

test('buildPages walks every directory in pagesDirs and merges results', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'about.html': '<h1>About</h1>',
        },
        'modules/blog': {
            'blog/index.html': '<h1>Blog</h1>',
            'blog/[slug]/index.html': '<h1>Post</h1>',
        },
        'modules/forum': {
            'forum/index.html': '<h1>Forum</h1>',
        },
    });
    try {
        const pages = await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDirs: fx.pagesDirs,
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        const routes = pages.map((p) => p.route).sort();
        assert.deepEqual(routes, [
            '/',
            '/about/',
            '/blog/',
            '/blog/[slug]/',
            '/forum/',
        ]);

        // Output baked from a NON-app root actually lands in the right place.
        const blog = await fs.readFile(path.join(fx.distDir, 'blog', 'index.html'), 'utf-8');
        assert.match(blog, /<h1>Blog<\/h1>/);
    } finally {
        await cleanup(fx.root);
    }
});

// ── Conflict detection: hard error with both source paths in message ──

test('buildPages throws when two roots claim the same route', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'about.html': '<h1>App About</h1>',
        },
        'modules/blog': {
            'about.html': '<h1>Blog About</h1>',
        },
    });
    try {
        await assert.rejects(
            buildPages({
                root: fx.root,
                distDir: fx.distDir,
                pagesDirs: fx.pagesDirs,
                layoutsDir: fx.layoutsDir,
                componentsDir: fx.componentsDir,
            }),
            (err) => {
                assert.match(err.message, /Route \/about\/ is declared twice/);
                assert.match(err.message, /content\/pages\/about\.html/);
                assert.match(err.message, /modules\/blog\/about\.html/);
                return true;
            }
        );
    } finally {
        await cleanup(fx.root);
    }
});

// ── Order: pagesDirs[0] is indexed first ──

test('buildPages indexes earlier pagesDirs first', async () => {
    const fx = await makeFixture({
        'content/pages': { 'index.html': '<h1>App Home</h1>' },
        'modules/blog': { 'blog/index.html': '<h1>Blog</h1>' },
    });
    try {
        const pages = await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDirs: fx.pagesDirs,
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        // Index page from the app root sorts to first via the index-html
        // preference, regardless of which root it came from.
        assert.equal(pages[0].route, '/');
    } finally {
        await cleanup(fx.root);
    }
});

// ── Inline component templates don't bleed surrounding whitespace ──

test('inline component substitution does not introduce phantom whitespace', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<p>The code is <lnk to="https://example.com">here</lnk>, if you are curious.</p>',
        },
    });
    try {
        // Component file ends with a trailing newline (POSIX, and every editor
        // adds one). Without trimming this would render as `here ,` instead of
        // `here,` because the newline collapses into a space at the inline
        // boundary.
        await fs.writeFile(
            path.join(fx.componentsDir, 'lnk.html'),
            '<a href="[[to]]">[[slot]]</a>\n',
            'utf-8'
        );

        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        const home = await fs.readFile(path.join(fx.distDir, 'index.html'), 'utf-8');
        assert.match(home, /<a href="https:\/\/example\.com">here<\/a>,/);
        assert.doesNotMatch(home, /<\/a>\s+,/);
    } finally {
        await cleanup(fx.root);
    }
});

// ── HTML5 end-tag whitespace tolerance ──

test('component close tags may contain whitespace before `>` (prettier-style)', async () => {
    // Prettier wraps long attribute lists on inline elements like:
    //   <lnk
    //       to="https://very-long-url..."
    //       blank
    //       >text</lnk
    //   >
    // The split `</lnk\n>` is valid HTML5 but used to throw "Unclosed <lnk>".
    const fx = await makeFixture({
        'content/pages': {
            'index.html':
                '<p>See <lnk\n' +
                '    to="https://example.com/very/long/path?foo=bar&baz=qux"\n' +
                '    blank\n' +
                '    >the link</lnk\n' +
                '>.</p>',
        },
    });
    try {
        await fs.writeFile(
            path.join(fx.componentsDir, 'lnk.html'),
            '<a href="[[to]]">[[slot]]</a>\n',
            'utf-8'
        );

        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        const home = await fs.readFile(path.join(fx.distDir, 'index.html'), 'utf-8');
        // The component slot rendered (would throw "Unclosed <lnk>" without
        // the whitespace tolerance fix), and the inline `.` after the link
        // sits flush with `</a>` — no phantom space.
        assert.match(home, /<a href="https:\/\/example\.com\/very\/long\/path\?[^"]+">the link<\/a>\./);
    } finally {
        await cleanup(fx.root);
    }
});

// ── pagesDirs wins over pagesDir if both provided ──

test('buildPages prefers pagesDirs over pagesDir when both are given', async () => {
    const fx = await makeFixture({
        'should/win': { 'winner.html': '<h1>Winner</h1>' },
        'should/lose': { 'loser.html': '<h1>Loser</h1>' },
    });
    try {
        const pages = await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDirs: [fx.pagesDirs[0]], // explicit array — winner only
            pagesDir: fx.pagesDirs[1], // singular — should be ignored
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        const routes = pages.map((p) => p.route).sort();
        assert.deepEqual(routes, ['/winner/']);
    } finally {
        await cleanup(fx.root);
    }
});

// ── flatRoutes: extensionless sibling files ──

test('flatRoutes: true emits extensionless files instead of dirs', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'about.html': '<h1>About</h1>',
            'blog/post.html': '<h1>Post</h1>',
        },
    });
    try {
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            flatRoutes: true,
        });

        // /about/ -> dist/about (a file), not dist/about/index.html
        const aboutStat = await fs.stat(path.join(fx.distDir, 'about'));
        assert.ok(aboutStat.isFile());
        const about = await fs.readFile(path.join(fx.distDir, 'about'), 'utf-8');
        assert.match(about, /<h1>About<\/h1>/);
        await assert.rejects(fs.stat(path.join(fx.distDir, 'about', 'index.html')));

        // nested /blog/post/ -> dist/blog/post (file); dist/blog is just a dir
        assert.ok((await fs.stat(path.join(fx.distDir, 'blog', 'post'))).isFile());
        assert.ok((await fs.stat(path.join(fx.distDir, 'blog'))).isDirectory());

        // root always stays dist/index.html
        assert.ok((await fs.stat(path.join(fx.distDir, 'index.html'))).isFile());
    } finally {
        await cleanup(fx.root);
    }
});

test('flatRoutes: false (default) still emits directory-style index.html', async () => {
    const fx = await makeFixture({
        'content/pages': { 'about.html': '<h1>About</h1>' },
    });
    try {
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            // no flatRoutes
        });

        assert.ok((await fs.stat(path.join(fx.distDir, 'about', 'index.html'))).isFile());
        // no extensionless sibling file was produced
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isDirectory());
    } finally {
        await cleanup(fx.root);
    }
});

test('flatRoutes keeps 404 extensionful by default', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            '404.html': '<h1>Not Found</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            flatRoutes: true,
        });

        // 404 -> dist/404.html (kept), NOT dist/404
        const nf = await fs.readFile(path.join(fx.distDir, '404.html'), 'utf-8');
        assert.match(nf, /Not Found/);
        await assert.rejects(fs.stat(path.join(fx.distDir, '404')));

        // everything else still flattens
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isFile());
    } finally {
        await cleanup(fx.root);
    }
});

test('flatRoutes honors a custom keepExtension list (route keys)', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'errors/offline.html': '<h1>Offline</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            flatRoutes: { keepExtension: ['errors/offline'] },
        });

        // kept by full route key -> dist/errors/offline.html
        assert.ok((await fs.stat(path.join(fx.distDir, 'errors', 'offline.html'))).isFile());
        await assert.rejects(fs.stat(path.join(fx.distDir, 'errors', 'offline')));

        // about flattens (the custom list replaces the default 404 keep)
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isFile());
    } finally {
        await cleanup(fx.root);
    }
});

test('flatRoutes hard-errors on nested-route conflicts', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'blog.html': '<h1>Blog index</h1>', // /blog/ -> dist/blog (file)
            'blog/post.html': '<h1>Post</h1>', // /blog/post/ -> needs dist/blog/ dir
        },
    });
    try {
        await assert.rejects(
            buildPages({
                root: fx.root,
                distDir: fx.distDir,
                pagesDir: fx.pagesDirs[0],
                layoutsDir: fx.layoutsDir,
                componentsDir: fx.componentsDir,
                flatRoutes: true,
            }),
            (err) => {
                assert.match(err.message, /Flattened route \/blog\/ conflicts with nested route \/blog\/post\//);
                assert.match(err.message, /blog\.html/);
                assert.match(err.message, /blog\/post\.html/);
                // suggests the keepExtension escape hatch
                assert.match(err.message, /keepExtension/);
                return true;
            }
        );
    } finally {
        await cleanup(fx.root);
    }
});

test('flatRoutes: keeping the parent extensionful resolves the conflict', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'blog.html': '<h1>Blog index</h1>',
            'blog/post.html': '<h1>Post</h1>',
        },
    });
    try {
        // Keep /blog/ as dist/blog.html so dist/blog/ is free to be a directory.
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            flatRoutes: { keepExtension: ['blog'] },
        });

        assert.ok((await fs.stat(path.join(fx.distDir, 'blog.html'))).isFile());
        assert.ok((await fs.stat(path.join(fx.distDir, 'blog'))).isDirectory());
        assert.ok((await fs.stat(path.join(fx.distDir, 'blog', 'post'))).isFile());
    } finally {
        await cleanup(fx.root);
    }
});

// ── CLI bin: flatRoutes is read from site.config.js ──
//
// The standard build path is `vite build && graspr-build-pages`, where the bin
// reads site.config.js. These run the real bin as a subprocess so the wiring
// (config load -> buildPages) is exercised end to end, not just buildPages().

test('graspr-build-pages CLI reads flatRoutes from site.config.js', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        await fs.writeFile(
            path.join(fx.root, 'site.config.js'),
            'export default { flatRoutes: true };\n',
            'utf-8'
        );

        // cwd = fixture root so the bin's process.cwd()-based defaults line up
        // with content/pages, content/layouts, dist, etc.
        execFileSync(process.execPath, [BIN_PATH], { cwd: fx.root, stdio: 'pipe' });

        // flatRoutes honored -> extensionless file, root still index.html
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isFile());
        assert.ok((await fs.stat(path.join(fx.distDir, 'index.html'))).isFile());
        await assert.rejects(fs.stat(path.join(fx.distDir, 'about', 'index.html')));
    } finally {
        await cleanup(fx.root);
    }
});

test('graspr-build-pages CLI defaults to directory-style output (no site.config.js)', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        // No site.config.js written -> loadSiteConfig returns {} -> flatRoutes off.
        execFileSync(process.execPath, [BIN_PATH], { cwd: fx.root, stdio: 'pipe' });

        assert.ok((await fs.stat(path.join(fx.distDir, 'about', 'index.html'))).isFile());
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isDirectory());
    } finally {
        await cleanup(fx.root);
    }
});

test('graspr-build-pages CLI honors a keepExtension list from site.config.js', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            '404.html': '<h1>Not Found</h1>',
            'about.html': '<h1>About</h1>',
        },
    });
    try {
        await fs.writeFile(
            path.join(fx.root, 'site.config.js'),
            'export default { flatRoutes: { keepExtension: ["404"] } };\n',
            'utf-8'
        );

        execFileSync(process.execPath, [BIN_PATH], { cwd: fx.root, stdio: 'pipe' });

        assert.ok((await fs.stat(path.join(fx.distDir, '404.html'))).isFile());
        assert.ok((await fs.stat(path.join(fx.distDir, 'about'))).isFile());
    } finally {
        await cleanup(fx.root);
    }
});

// ── Dev plugin: nested-route conflict check is gated on flatRoutes ──

test('dev middleware surfaces nested-route conflicts under flatRoutes', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'blog.html': '<h1>Blog</h1>',
            'blog/post.html': '<h1>Post</h1>',
        },
    });
    try {
        const result = await runDevMiddleware({
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            flatRoutes: true,
            url: '/',
        });
        assert.ok(result instanceof Error);
        assert.match(result.message, /conflicts with nested route/);
    } finally {
        await cleanup(fx.root);
    }
});

test('dev middleware does not flag conflicts when flatRoutes is off', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'blog.html': '<h1>Blog</h1>',
            'blog/post.html': '<h1>Post</h1>',
        },
    });
    try {
        // Same fixture that conflicts under flatRoutes — but with the feature
        // off the page just renders normally.
        const result = await runDevMiddleware({
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            url: '/blog/',
        });
        assert.equal(result, 'ended');
    } finally {
        await cleanup(fx.root);
    }
});

// Drive the dev middleware once and return the HTML written to the response.
async function renderDevHtml({ pagesDir, layoutsDir, componentsDir, siteConfig, devCss, url }) {
    const plugin = grasprBuild({ pagesDirs: [pagesDir], layoutsDir, componentsDir, siteConfig, devCss });
    let middleware;
    plugin.configureServer({
        middlewares: { use: (fn) => { middleware = fn; } },
        transformIndexHtml: async (_url, html) => html,
    });
    return await new Promise((resolve) => {
        const res = { statusCode: 0, setHeader() {}, end(body) { resolve(body ?? ''); } };
        middleware({ method: 'GET', url }, res, (e) => resolve(String(e)));
    });
}

test('dev middleware emits a render-blocking stylesheet link when devCss is set', async () => {
    const fx = await makeFixture({ 'content/pages': { 'index.html': '<h1>Home</h1>' } });
    try {
        const html = await renderDevHtml({
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            siteConfig: { devCss: '/styles/style.css?direct' },
            url: '/',
        });
        assert.match(html, /<link rel="stylesheet" href="\/styles\/style\.css\?direct" \/>/);
    } finally {
        await cleanup(fx.root);
    }
});

test('dev middleware emits no stylesheet link when devCss is unset (CSS via JS as before)', async () => {
    const fx = await makeFixture({ 'content/pages': { 'index.html': '<h1>Home</h1>' } });
    try {
        const html = await renderDevHtml({
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            url: '/',
        });
        assert.doesNotMatch(html, /rel="stylesheet"/);
    } finally {
        await cleanup(fx.root);
    }
});

test('dev middleware picks up flatRoutes from siteConfig', async () => {
    const fx = await makeFixture({
        'content/pages': {
            'index.html': '<h1>Home</h1>',
            'blog.html': '<h1>Blog</h1>',
            'blog/post.html': '<h1>Post</h1>',
        },
    });
    try {
        // flatRoutes not passed directly — only via siteConfig, mirroring a
        // project that sets it once in site.config.js.
        const result = await runDevMiddleware({
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            siteConfig: { flatRoutes: true },
            url: '/',
        });
        assert.ok(result instanceof Error);
        assert.match(result.message, /conflicts with nested route/);
    } finally {
        await cleanup(fx.root);
    }
});

// ── minify: option normalization ──

test('resolveMinifyOptions: off -> null, true -> defaults, object -> merged', () => {
    assert.equal(resolveMinifyOptions(false), null);
    assert.equal(resolveMinifyOptions(undefined), null);

    const defaults = resolveMinifyOptions(true);
    assert.equal(defaults.collapseWhitespace, true);
    assert.equal(defaults.removeComments, true);

    const merged = resolveMinifyOptions({ removeComments: false, customFlag: 1 });
    assert.equal(merged.collapseWhitespace, true); // default preserved
    assert.equal(merged.removeComments, false); // overridden
    assert.equal(merged.customFlag, 1); // extra passthrough
});

test('createHtmlMinifier returns null when minify is off (peer dep untouched)', async () => {
    const fail = () => Promise.reject(new Error('loader should not be called'));
    assert.equal(await createHtmlMinifier(false, fail), null);
    assert.equal(await createHtmlMinifier(undefined, fail), null);
});

test('createHtmlMinifier throws a clear error when the peer dep is missing', async () => {
    await assert.rejects(
        createHtmlMinifier(true, () => Promise.reject(new Error('ERR_MODULE_NOT_FOUND'))),
        (err) => {
            assert.match(err.message, /requires the html-minifier-terser peer dependency/);
            assert.match(err.message, /npm i -D html-minifier-terser/);
            return true;
        }
    );
});

// ── minify: applied through buildPages ──

test('minify: true shrinks output and strips comments', async () => {
    const fx = await makeFixture({
        'content/pages': { 'about.html': MINIFIABLE_PAGE },
    });
    const outPath = path.join(fx.distDir, 'about', 'index.html');
    const common = {
        root: fx.root,
        distDir: fx.distDir,
        pagesDir: fx.pagesDirs[0],
        layoutsDir: fx.layoutsDir,
        componentsDir: fx.componentsDir,
    };
    try {
        await buildPages(common); // no minify
        const raw = await fs.readFile(outPath, 'utf-8');

        await buildPages({ ...common, minify: true });
        const min = await fs.readFile(outPath, 'utf-8');

        assert.match(raw, /build comment/);
        assert.doesNotMatch(min, /build comment/);
        assert.ok(min.length < raw.length, 'minified output should be smaller');
    } finally {
        await cleanup(fx.root);
    }
});

test('minify: false (default) leaves output untouched', async () => {
    const fx = await makeFixture({
        'content/pages': { 'about.html': MINIFIABLE_PAGE },
    });
    try {
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });
        const out = await fs.readFile(path.join(fx.distDir, 'about', 'index.html'), 'utf-8');
        // comment retained and original whitespace preserved
        assert.match(out, /build comment/);
        assert.match(out, /\n/);
    } finally {
        await cleanup(fx.root);
    }
});

test('minify object overrides merge onto the defaults', async () => {
    const fx = await makeFixture({
        'content/pages': { 'about.html': MINIFIABLE_PAGE },
    });
    try {
        // Turn off comment removal but leave the rest of the defaults on.
        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
            minify: { removeComments: false },
        });
        const out = await fs.readFile(path.join(fx.distDir, 'about', 'index.html'), 'utf-8');
        // override honored: comment survives
        assert.match(out, /build comment/);
        // default still applied: collapseWhitespace removed the blank lines
        assert.doesNotMatch(out, /\n\n/);
    } finally {
        await cleanup(fx.root);
    }
});

test('graspr-build-pages CLI reads minify from site.config.js', async () => {
    const fx = await makeFixture({
        'content/pages': { 'about.html': MINIFIABLE_PAGE },
    });
    try {
        await fs.writeFile(
            path.join(fx.root, 'site.config.js'),
            'export default { minify: true };\n',
            'utf-8'
        );

        execFileSync(process.execPath, [BIN_PATH], { cwd: fx.root, stdio: 'pipe' });

        const out = await fs.readFile(path.join(fx.distDir, 'about', 'index.html'), 'utf-8');
        assert.doesNotMatch(out, /build comment/);
    } finally {
        await cleanup(fx.root);
    }
});

// ── Vite manifest cleanup ──

test('buildPages deletes the vite manifest after baking', async () => {
    const fx = await makeFixture({
        'content/pages': { 'index.html': '<h1>Home</h1>' },
    });
    const manifestPath = path.join(fx.distDir, '.vite', 'manifest.json');
    try {
        // makeFixture wrote a fake manifest, mirroring `vite build` output.
        assert.ok((await fs.stat(manifestPath)).isFile());

        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        // Manifest (and the now-empty .vite/ dir) are gone...
        await assert.rejects(fs.stat(manifestPath));
        await assert.rejects(fs.stat(path.join(fx.distDir, '.vite')));

        // ...but its hashed asset names were baked into the page first, proving
        // we consumed it before deleting.
        const home = await fs.readFile(path.join(fx.distDir, 'index.html'), 'utf-8');
        assert.match(home, /assets\/app-test\.(js|css)/);
    } finally {
        await cleanup(fx.root);
    }
});

test('buildPages does not throw when there is no vite manifest', async () => {
    const fx = await makeFixture({
        'content/pages': { 'index.html': '<h1>Home</h1>' },
    });
    try {
        // Simulate buildPages() called without a preceding `vite build`.
        await fs.rm(path.join(fx.distDir, '.vite'), { recursive: true, force: true });

        await buildPages({
            root: fx.root,
            distDir: fx.distDir,
            pagesDir: fx.pagesDirs[0],
            layoutsDir: fx.layoutsDir,
            componentsDir: fx.componentsDir,
        });

        // Falls back to default asset URLs, no crash.
        const home = await fs.readFile(path.join(fx.distDir, 'index.html'), 'utf-8');
        assert.match(home, /\/assets\/app\.js/);
    } finally {
        await cleanup(fx.root);
    }
});
