import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildPages } from '../src/build-pages.mjs';

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
