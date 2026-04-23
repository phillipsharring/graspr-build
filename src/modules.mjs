import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Configure a graspr module with site-specific overrides.
 *
 * Modules export an object with `defaults` containing their default config.
 * `configure()` merges site-specific overrides on top and stores the result
 * in `config`. Modules that are registered without `configure()` use their
 * own defaults at runtime.
 *
 * @param {object} mod - The module object (must have a `name` property).
 * @param {object} [overrides={}] - Site-specific config to merge over defaults.
 * @returns {object} A new module object with merged `config`.
 *
 * @example
 * import { configure } from '@phillipsharring/graspr-build';
 * import { landing } from '@phillipsharring/handlr-module-landing';
 *
 * // In site.config.js:
 * modules: [
 *     landing,                                         // uses defaults
 *     configure(landing, { adminNav: false }),          // overridden
 * ]
 */
export function configure(mod, overrides = {}) {
    return {
        ...mod,
        config: { ...(mod.defaults || {}), ...overrides },
    };
}

/**
 * Resolve an array of module entries into the directories graspr-build should
 * scan for pages and components. Called by both `vite.config.js` (dev server)
 * and `build-pages.mjs` (production bake) so they discover the same set.
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

/**
 * Initialize all modules that provide an `init()` method.
 * Call this once from the app's entry JS after core setup is complete.
 *
 * @param {Array<object|string>} [modules] - The modules array from site.config.js.
 */
export function initModules(modules = []) {
    for (const mod of modules) {
        if (typeof mod === 'object' && typeof mod.init === 'function') {
            mod.init();
        }
    }
}
