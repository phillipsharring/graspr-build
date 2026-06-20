import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { moduleRoot, configure, initModules } from '../src/modules.mjs';
import { resolveModuleDirs } from '../src/module-dirs.mjs';

// ── Browser-safety guard ──
//
// modules.mjs is imported into app browser bundles via initModules(). If it ever
// pulls in a Node-only module again (the bug that broke binder-quest's prod
// build — `import { existsSync } from 'node:fs'`), rollup can't externalize it
// and the browser build dies. Keep the runtime side free of `node:` imports.

test('modules.mjs has no Node-only imports (stays browser-safe)', async () => {
    const src = await fs.readFile(
        fileURLToPath(new URL('../src/modules.mjs', import.meta.url)),
        'utf-8'
    );
    // Match actual import/require of a node: builtin, not prose in comments.
    const importsNode = /^\s*import\b[^\n]*\bfrom\s*['"]node:/m.test(src);
    const requiresNode = /\brequire\(\s*['"]node:/.test(src);
    assert.equal(importsNode, false, 'modules.mjs must not import a node: builtin');
    assert.equal(requiresNode, false, 'modules.mjs must not require a node: builtin');
});

// ── moduleRoot (URL standard, browser-safe) ──

test('moduleRoot resolves one level up from a src/ file', () => {
    assert.equal(moduleRoot('file:///a/b/c/src/index.js'), '/a/b/c/');
});

// ── configure (pure merge) ──

test('configure merges overrides onto module defaults', () => {
    const mod = { name: 'm', defaults: { a: 1, b: 2 } };
    const out = configure(mod, { b: 3, c: 4 });
    assert.deepEqual(out.config, { a: 1, b: 3, c: 4 });
    assert.equal(out.name, 'm');
    // original is untouched
    assert.equal(mod.config, undefined);
});

test('configure tolerates a module with no defaults', () => {
    const out = configure({ name: 'm' }, { x: 1 });
    assert.deepEqual(out.config, { x: 1 });
});

// ── initModules (pure runtime) ──

test('initModules calls init() on objects that have it, skips the rest', () => {
    const called = [];
    const mods = [
        { name: 'a', init: () => called.push('a') },
        { name: 'b' }, // no init — skipped
        'legacy-string', // not an object — skipped
        configure({ name: 'c', defaults: {}, init: () => called.push('c') }),
    ];
    initModules(mods);
    assert.deepEqual(called.sort(), ['a', 'c']);
});

test('initModules with no args does not throw', () => {
    assert.doesNotThrow(() => initModules());
});

// ── resolveModuleDirs (build-time, from module-dirs.mjs) ──

async function makeModuleFixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'graspr-modules-test-'));
    // Legacy convention: <root>/modules/foo/{pages,components}
    await fs.mkdir(path.join(root, 'modules', 'foo', 'pages'), { recursive: true });
    await fs.mkdir(path.join(root, 'modules', 'foo', 'components'), { recursive: true });
    return root;
}

test('resolveModuleDirs resolves a legacy string module by convention', async () => {
    const root = await makeModuleFixture();
    try {
        const { pagesDirs, componentsDirs } = resolveModuleDirs(root, ['foo']);
        assert.deepEqual(pagesDirs, [path.join(root, 'modules', 'foo', 'pages')]);
        assert.deepEqual(componentsDirs, [path.join(root, 'modules', 'foo', 'components')]);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('resolveModuleDirs throws for a legacy string module that does not exist', async () => {
    const root = await makeModuleFixture();
    try {
        assert.throws(() => resolveModuleDirs(root, ['nope']), /does not exist/);
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('resolveModuleDirs reads module objects and skips missing dirs', async () => {
    const root = await makeModuleFixture();
    try {
        const mod = {
            name: 'm',
            pagesDir: path.join(root, 'modules', 'foo', 'pages'), // exists
            componentsDir: path.join(root, 'modules', 'foo', 'nope'), // missing
        };
        const { pagesDirs, componentsDirs } = resolveModuleDirs(root, [mod]);
        assert.deepEqual(pagesDirs, [mod.pagesDir]);
        assert.deepEqual(componentsDirs, []); // missing dir silently skipped
    } finally {
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('resolveModuleDirs rejects a module object with no name', () => {
    assert.throws(() => resolveModuleDirs('/tmp', [{ pagesDir: '/x' }]), /name/);
});
