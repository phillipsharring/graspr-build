import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve an array of module entries into the directories graspr-build should
 * scan for pages and components. Called by both `vite.config.js` (dev server)
 * and the production page baker so they discover the same set.
 *
 * This is **build-time only** — it touches the filesystem (`node:fs`), so it
 * lives apart from the browser-safe runtime helpers in `./modules.mjs`. Import
 * it from `@phillipsharring/graspr-build/module-dirs` (or the package root),
 * never from a browser bundle.
 *
 * Accepts two forms:
 *   - **Module objects** (new): reads `pagesDir` / `componentsDir` directly
 *     off the object. The module self-resolves its paths via `import.meta.url`.
 *   - **Strings** (legacy): resolves by convention at `<rootDir>/modules/<name>/`.
 *
 * @param {string} rootDir - The app root (where a local `modules/` dir may live).
 * @param {Array<object|string>} [modules] - Module objects or legacy name strings.
 * @returns {{ pagesDirs: string[], componentsDirs: string[] }}
 */
export function resolveModuleDirs(rootDir, modules = []) {
    const pagesDirs = [];
    const componentsDirs = [];

    for (const mod of modules) {
        // Legacy string support: resolve by convention
        if (typeof mod === 'string') {
            const moduleRoot = path.join(rootDir, 'modules', mod);
            if (!existsSync(moduleRoot)) {
                throw new Error(
                    `Module '${mod}' is listed in site.config.modules but ${path.relative(rootDir, moduleRoot)} does not exist.`
                );
            }
            const pagesDir = path.join(moduleRoot, 'pages');
            if (existsSync(pagesDir)) pagesDirs.push(pagesDir);
            const componentsDir = path.join(moduleRoot, 'components');
            if (existsSync(componentsDir)) componentsDirs.push(componentsDir);
            continue;
        }

        // Module object: read paths directly
        if (!mod || !mod.name) {
            throw new Error('Module entry must be a string or an object with a `name` property.');
        }

        if (mod.pagesDir && existsSync(mod.pagesDir)) {
            pagesDirs.push(mod.pagesDir);
        }

        if (mod.componentsDir && existsSync(mod.componentsDir)) {
            componentsDirs.push(mod.componentsDir);
        }
    }

    return { pagesDirs, componentsDirs };
}
