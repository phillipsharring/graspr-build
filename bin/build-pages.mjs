#!/usr/bin/env node
/**
 * graspr-build-pages CLI shim.
 *
 * Loads ./site.config.js (if present) from the current working directory and
 * calls buildPages(). Designed to be invoked from a package.json script:
 *
 *   "build": "vite build && graspr-build-pages"
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildPages } from '../src/build-pages.mjs';

async function loadSiteConfig() {
    const configPath = path.join(process.cwd(), 'site.config.js');
    try {
        const mod = await import(pathToFileURL(configPath).href);
        return mod.default || mod;
    } catch (err) {
        if (err && err.code === 'ERR_MODULE_NOT_FOUND') return {};
        // Surface real errors (syntax errors, broken imports, etc.)
        throw err;
    }
}

async function main() {
    const siteConfig = await loadSiteConfig();
    await buildPages({ root: process.cwd(), siteConfig });
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
