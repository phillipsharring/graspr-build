/**
 * Browser-safe module runtime helpers.
 *
 * This file MUST stay free of Node-only imports (`node:fs`, `node:path`, …) — it
 * is imported into app browser bundles via `initModules`. The build-time
 * filesystem helper `resolveModuleDirs` lives in `./module-dirs.mjs` instead.
 */

/**
 * Resolve the root directory of a module from its `import.meta.url`.
 * Works in both Node and browser contexts -- uses the URL standard, no Node-only APIs.
 *
 * @param {string} importMetaUrl - The module's `import.meta.url` (must be in a `src/` subdirectory).
 * @returns {string} Absolute path to the module root (one level up from the file).
 *
 * @example
 * // In a module's src/index.js:
 * import { moduleRoot } from '@phillipsharring/graspr-build/modules';
 * const root = moduleRoot(import.meta.url);
 * // root = '/path/to/my-module'
 */
export function moduleRoot(importMetaUrl) {
    return new URL('..', importMetaUrl).pathname;
}

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
