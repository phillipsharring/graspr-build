/**
 * HTML minification for baked pages, backed by the optional `html-minifier-terser`
 * peer dependency. Kept in its own module so the dynamic import and the default
 * option set live in one place, and so the dep is only loaded when minify is on.
 */

// Matches the option set the pre-graspr phillipharrington.com build used.
const DEFAULT_MINIFY_OPTIONS = {
    removeAttributeQuotes: true,
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeTagWhitespace: true,
};

/**
 * Normalize the `minify` option into a concrete options object, or `null` when
 * the feature is off (the default).
 *
 * - `false`/`undefined`   -> null (no minification)
 * - `true`                -> the defaults above
 * - `{ ...overrides }`    -> defaults shallow-merged with the overrides
 *
 * @param {boolean|object} [opt]
 * @returns {object | null}
 */
export function resolveMinifyOptions(opt) {
    if (!opt) return null;
    if (opt === true) return { ...DEFAULT_MINIFY_OPTIONS };
    return { ...DEFAULT_MINIFY_OPTIONS, ...opt };
}

/**
 * Resolve a minify function for the given option, or `null` when minify is off.
 * Loads `html-minifier-terser` lazily — it's an optional peer dependency, so
 * consumers who don't minify never need it installed. Throws a clear, actionable
 * error if minify is requested but the dep isn't present.
 *
 * The `load` parameter is an injection seam for tests; production callers use
 * the default dynamic import.
 *
 * @param {boolean|object} [opt]
 * @param {() => Promise<{minify: Function, default?: {minify: Function}}>} [load]
 * @returns {Promise<((html: string) => Promise<string>) | null>}
 */
export async function createHtmlMinifier(opt, load = () => import('html-minifier-terser')) {
    const options = resolveMinifyOptions(opt);
    if (!options) return null;

    let mod;
    try {
        mod = await load();
    } catch {
        throw new Error(
            'buildPages({ minify: true }) requires the html-minifier-terser peer dependency. ' +
            'Install it: npm i -D html-minifier-terser'
        );
    }

    const minify = mod.minify ?? mod.default?.minify;
    if (typeof minify !== 'function') {
        throw new Error(
            'html-minifier-terser was found but did not export a minify() function. ' +
            'Expected version ^7.0.0.'
        );
    }

    return (html) => minify(html, options);
}
