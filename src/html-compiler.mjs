import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';

let _gitSha = null;
function getGitSha() {
    if (_gitSha === null) {
        try {
            _gitSha = `<!-- ${execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()} -->`;
        } catch {
            _gitSha = '';
        }
    }
    return _gitSha;
}

function htmlEscape(s) {
    return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function findTagEnd(src, startIdx) {
    // Finds the closing '>' for a tag starting at startIdx, respecting quoted attribute values.
    let i = startIdx;
    let quote = null;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') return i;
    }
    return -1;
}

function parseAttributes(attrSrc) {
    // Minimal HTML attribute parser:
    // - foo="bar" or foo='bar' -> string
    // - bare boolean attrs like `disabled` -> true
    const attrs = {};
    let i = 0;
    const s = attrSrc.trim();

    while (i < s.length) {
        while (i < s.length && /\s/.test(s[i])) i++;
        if (i >= s.length) break;

        // name
        let nameStart = i;
        while (i < s.length && /[^\s=]/.test(s[i])) i++;
        const name = s.slice(nameStart, i);
        if (!name) break;

        while (i < s.length && /\s/.test(s[i])) i++;

        if (s[i] !== '=') {
            attrs[name] = true;
            continue;
        }

        i++; // =
        while (i < s.length && /\s/.test(s[i])) i++;

        const q = s[i];
        if (q === '"' || q === "'") {
            i++;
            const valStart = i;
            while (i < s.length && s[i] !== q) i++;
            attrs[name] = s.slice(valStart, i);
            if (s[i] === q) i++;
        } else {
            // unquoted value
            const valStart = i;
            while (i < s.length && !/\s/.test(s[i])) i++;
            attrs[name] = s.slice(valStart, i);
        }
    }

    return attrs;
}

function renderIfBlocks(src, props) {
    // Stack-based parser; supports nesting + optional else:
    // [[#if flag]] ... [[else]] ... [[/if]]
    const tokenRe = /\[\[#if\s+([a-zA-Z0-9_-]+)\s*\]\]|\[\[else\]\]|\[\[\/if\]\]/g;

    /** @type {Array<{flag:string, thenParts:string[], elseParts:string[], inElse:boolean}>} */
    const stack = [];
    let out = '';
    let last = 0;
    let m;

    function appendText(t) {
        if (!t) return;
        if (stack.length === 0) {
            out += t;
            return;
        }
        const top = stack[stack.length - 1];
        (top.inElse ? top.elseParts : top.thenParts).push(t);
    }

    while ((m = tokenRe.exec(src))) {
        const idx = m.index;
        const tok = m[0];

        appendText(src.slice(last, idx));

        if (tok.startsWith('[[#if')) {
            const flag = m[1];
            stack.push({ flag, thenParts: [], elseParts: [], inElse: false });
            last = idx + tok.length;
            continue;
        }

        if (tok === '[[else]]') {
            if (stack.length === 0) {
                appendText(tok);
            } else {
                stack[stack.length - 1].inElse = true;
            }
            last = idx + tok.length;
            continue;
        }

        if (tok === '[[/if]]') {
            if (stack.length === 0) {
                appendText(tok);
            } else {
                const frame = stack.pop();
                const enabled = !!props[frame.flag];
                const chosen = enabled ? frame.thenParts.join('') : frame.elseParts.join('');
                appendText(chosen);
            }
            last = idx + tok.length;
            continue;
        }
    }

    appendText(src.slice(last));

    while (stack.length) {
        const frame = stack.shift();
        const literal =
            `[[#if ${frame.flag}]]` +
            frame.thenParts.join('') +
            (frame.inElse ? '[[else]]' + frame.elseParts.join('') : '');
        out = literal + out;
    }

    return out;
}

function mergeRootClass(renderedHtml, extraClass) {
    if (!extraClass) return renderedHtml;
    const extra = String(extraClass).trim();
    if (!extra) return renderedHtml;

    if (renderedHtml.includes('[[class]]') || renderedHtml.includes('[[{class}]]')) {
        return renderedHtml;
    }

    const lt = renderedHtml.indexOf('<');
    if (lt === -1) return renderedHtml;

    const isComment = renderedHtml.startsWith('<!--', lt);
    const isDoc = renderedHtml.toLowerCase().startsWith('<!doctype', lt);
    if (isComment || isDoc) return renderedHtml;

    const gt = findTagEnd(renderedHtml, lt);
    if (gt === -1) return renderedHtml;

    const openTag = renderedHtml.slice(lt, gt + 1);
    if (openTag.startsWith('</')) return renderedHtml;

    const tagMatch = openTag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)\b/);
    if (!tagMatch) return renderedHtml;
    const tagName = tagMatch[1];
    const selfClosing = openTag.endsWith('/>');

    const attrSegment = openTag.slice(tagMatch[0].length).replace(/\/?>$/, '');

    const attrs = parseAttributes(attrSegment);

    const existing = typeof attrs.class === 'string' ? attrs.class.trim() : '';
    const merged = existing ? `${existing} ${extra}` : extra;

    attrs.class = merged;
    const rebuiltAttrs = Object.entries(attrs)
        .filter(([k]) => k !== 'name' && k !== 'file')
        .map(([k, v]) => {
            if (v === true) return k;
            return `${k}="${String(v).replaceAll('"', '&quot;')}"`;
        })
        .join(' ');

    const rebuilt = `<${tagName}${rebuiltAttrs ? ' ' + rebuiltAttrs : ''}${selfClosing ? ' />' : '>'}`;
    return renderedHtml.slice(0, lt) + rebuilt + renderedHtml.slice(gt + 1);
}

function renderComponentTemplate(tplSrc, props, slotHtml) {
    let out = tplSrc;

    out = renderIfBlocks(out, props);

    out = out.replaceAll('[[slot]]', slotHtml ?? '');

    // [[prop]] escapes by default; [[{prop}]] is raw
    out = out.replace(/\[\[\{([a-zA-Z0-9_-]+)\}\]\]/g, (_, k) => String(props[k] ?? ''));
    out = out.replace(/\[\[([a-zA-Z0-9_-]+)\]\]/g, (_, k) => htmlEscape(props[k] ?? ''));

    if (typeof props.class === 'string') {
        out = mergeRootClass(out, props.class);
    }

    return out;
}

function findMatchingCloseForTag(src, tagName, fromIdx) {
    const open = `<${tagName}`;
    const close = `</${tagName}>`;
    let depth = 1;
    let i = fromIdx;

    while (i < src.length) {
        const nextOpen = src.indexOf(open, i);
        const nextClose = src.indexOf(close, i);

        if (nextClose === -1) return -1;
        if (nextOpen !== -1 && nextOpen < nextClose) {
            depth++;
            i = nextOpen + open.length;
            continue;
        }

        depth--;
        if (depth === 0) return nextClose;
        i = nextClose + close.length;
    }

    return -1;
}

function isCustomComponentTagName(tagName) {
    return /^[a-z][a-z0-9-]*-[a-z0-9-]+$/i.test(tagName);
}

function pascalFromKebab(s) {
    return s
        .split('-')
        .filter(Boolean)
        .map((p) => p[0].toUpperCase() + p.slice(1))
        .join('');
}

function toComponentsDirArray(componentsDir) {
    if (Array.isArray(componentsDir)) return componentsDir;
    return [componentsDir];
}

async function fileExists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function resolveComponentTemplatePath({ componentsDirs, componentNames, attrs, tagName }) {
    const file = typeof attrs.file === 'string' ? attrs.file : null;
    const name = typeof attrs.name === 'string' ? attrs.name : null;

    // Explicit file= attribute: try each dir in order, first match wins
    if (file) {
        for (const dir of componentsDirs) {
            const candidate = path.resolve(dir, file);
            if (await fileExists(candidate)) return candidate;
        }
        // Fall back to last candidate so the error message is meaningful
        return path.resolve(componentsDirs[componentsDirs.length - 1], file);
    }

    // <component name="foo" />: try each dir in order
    if (tagName === 'component') {
        if (!name) {
            throw new Error('Component tag missing `name` or `file`: <component ...>');
        }
        const filename = `${name}.html`;
        for (const dir of componentsDirs) {
            const candidate = path.resolve(dir, filename);
            if (await fileExists(candidate)) return candidate;
        }
        return path.resolve(componentsDirs[componentsDirs.length - 1], filename);
    }

    const lower = String(tagName).toLowerCase();
    const isKnown = componentNames?.has(lower);

    if (!isCustomComponentTagName(tagName) && !isKnown) {
        throw new Error(
            `Unknown component tag: <${tagName}> (expected <component name="...">, a custom element tag like <my-component>, or a tag with a matching template in a components directory)`
        );
    }

    // Try kebab name in each dir, then PascalCase name in each dir
    const kebabFile = `${tagName}.html`;
    const pascalFile = `${pascalFromKebab(tagName)}.html`;

    for (const dir of componentsDirs) {
        const candidate = path.resolve(dir, kebabFile);
        if (await fileExists(candidate)) return candidate;
    }
    for (const dir of componentsDirs) {
        const candidate = path.resolve(dir, pascalFile);
        if (await fileExists(candidate)) return candidate;
    }

    // Nothing found — return last kebab candidate so the error from fs.readFile is meaningful
    return path.resolve(componentsDirs[componentsDirs.length - 1], kebabFile);
}

async function expandComponents(html, { componentsDirs, componentNames, maxPasses = 50 }) {
    let src = html;

    for (let pass = 0; pass < maxPasses; pass++) {
        let changed = false;
        let idx = 0;

        while (idx < src.length) {
            const lt = src.indexOf('<', idx);
            if (lt === -1) break;

            if (
                src.startsWith('</', lt) ||
                src.startsWith('<!--', lt) ||
                src.toLowerCase().startsWith('<!doctype', lt)
            ) {
                idx = lt + 2;
                continue;
            }

            const tagEnd = findTagEnd(src, lt);
            if (tagEnd === -1) break;

            const openTag = src.slice(lt, tagEnd + 1);
            const tagMatch = openTag.match(/^<\s*([a-zA-Z][a-zA-Z0-9:-]*)\b/);
            if (!tagMatch) {
                idx = tagEnd + 1;
                continue;
            }

            const tagName = tagMatch[1];
            const tagLower = tagName.toLowerCase();
            const isComponentTag =
                tagLower === 'component' ||
                isCustomComponentTagName(tagName) ||
                (componentNames?.has(tagLower) ?? false);
            if (!isComponentTag) {
                idx = tagEnd + 1;
                continue;
            }

            const selfClosing = openTag.endsWith('/>');
            const attrText = openTag.slice(tagMatch[0].length).replace(/\/?>$/, '');
            const attrs = parseAttributes(attrText);

            const componentPath = await resolveComponentTemplatePath({
                componentsDirs,
                componentNames,
                attrs,
                tagName: tagName.toLowerCase(),
            });
            // Trim surrounding whitespace from the template so the trailing
            // newline that every editor adds doesn't bleed into the page after
            // an inline component (e.g. `<lnk>here</lnk>,` should render as
            // `here,`, not `here ,`).
            const tplSrc = (await fs.readFile(componentPath, 'utf-8')).trim();

            let slotHtml = '';
            let closeEnd = tagEnd + 1;

            if (!selfClosing) {
                const closeIdx = findMatchingCloseForTag(src, tagName, tagEnd + 1);
                if (closeIdx === -1) {
                    throw new Error(`Unclosed <${tagName}> tag near: ${openTag}`);
                }
                slotHtml = src.slice(tagEnd + 1, closeIdx);
                closeEnd = closeIdx + `</${tagName}>`.length;
            }

            const props = { ...attrs };
            for (const [k, v] of Object.entries(props)) {
                if (v === true) props[k] = true;
            }

            const rendered = renderComponentTemplate(tplSrc, props, slotHtml);

            src = src.slice(0, lt) + rendered + src.slice(closeEnd);
            changed = true;
            idx = lt + rendered.length;
        }

        if (!changed) return src;
    }

    throw new Error(`Component expansion exceeded max passes (${maxPasses}). Possible recursive component loop?`);
}

async function expandTemplateSrc(html, pageDir) {
    let src = html;
    let idx = 0;

    while (idx < src.length) {
        const lt = src.indexOf('<template', idx);
        if (lt === -1) break;

        const ch = src[lt + '<template'.length];
        if (ch && ch !== '>' && !/\s/.test(ch)) {
            idx = lt + 1;
            continue;
        }

        const tagEnd = findTagEnd(src, lt);
        if (tagEnd === -1) break;

        const openTag = src.slice(lt, tagEnd + 1);
        const attrText = openTag.slice('<template'.length).replace(/\/?>$/, '');
        const attrs = parseAttributes(attrText);

        if (!attrs.src || typeof attrs.src !== 'string') {
            idx = tagEnd + 1;
            continue;
        }

        const closeIdx = findMatchingCloseForTag(src, 'template', tagEnd + 1);
        if (closeIdx === -1) {
            throw new Error(`Unclosed <template src="${attrs.src}"> near: ${openTag}`);
        }
        const closeEnd = closeIdx + '</template>'.length;

        const filePath = path.resolve(pageDir, `${attrs.src}.html`);
        const tplSrc = await fs.readFile(filePath, 'utf-8');

        const props = { ...attrs };
        delete props.src;
        const rendered = renderComponentTemplate(tplSrc, props, '');

        const outputAttrs = Object.entries(attrs)
            .filter(([k]) => k !== 'src')
            .map(([k, v]) => {
                if (v === true) return k;
                return `${k}="${String(v).replaceAll('"', '&quot;')}"`;
            })
            .join(' ');

        const output = `<template${outputAttrs ? ' ' + outputAttrs : ''}>${rendered}</template>`;
        src = src.slice(0, lt) + output + src.slice(closeEnd);
        idx = lt + output.length;
    }

    return src;
}

function extractLayoutDeclaration(pageSrc) {
    const layoutTagRe = /^\s*<layout\s+([^>]*?)\/>\s*/i;
    const match = pageSrc.match(layoutTagRe);

    if (match) {
        const attrString = match[1];
        const attrs = parseAttributes(attrString);

        return {
            layoutName: attrs.name || 'base',
            title: attrs.title || null,
            pageContent: pageSrc.slice(match[0].length),
        };
    }

    return {
        layoutName: 'base',
        title: null,
        pageContent: pageSrc,
    };
}

function extractPageHead(pageSrc) {
    const pageHeadRe = /^\s*<page-head>([\s\S]*?)<\/page-head>\s*/i;
    const match = pageSrc.match(pageHeadRe);

    if (match) {
        return {
            pageHead: match[1].trim(),
            pageContent: pageSrc.slice(match[0].length),
        };
    }

    return {
        pageHead: '',
        pageContent: pageSrc,
    };
}

async function discoverComponentNames(componentsDirs) {
    const names = new Set();
    for (const dir of componentsDirs) {
        let entries;
        try {
            entries = await fs.readdir(dir);
        } catch {
            // Directory may not exist (e.g. an optional module dir) — skip silently
            continue;
        }
        for (const f of entries) {
            if (f.toLowerCase().endsWith('.html')) {
                names.add(f.slice(0, -'.html'.length).toLowerCase());
            }
        }
    }
    return names;
}

/**
 * Render a single page to HTML.
 *
 * @param {object} opts
 * @param {string} opts.layoutsDir
 * @param {string} opts.pagePath
 * @param {string|string[]} opts.componentsDir - Single dir or array of dirs.
 *        When an array, each is tried in order when resolving a component tag,
 *        enabling module systems to contribute partials from multiple roots.
 * @param {string} [opts.title]
 * @param {string|null} [opts.jsSrc]
 * @param {string|null} [opts.cssHref]
 * @param {object} [opts.siteConfig]
 */
export async function renderPage({ layoutsDir, pagePath, title, jsSrc, cssHref, componentsDir, siteConfig = {} }) {
    const componentsDirs = toComponentsDirArray(componentsDir);

    const pageSrcRaw = await fs.readFile(pagePath, 'utf-8');
    const { layoutName, title: layoutTitle, pageContent: afterLayoutTag } = extractLayoutDeclaration(pageSrcRaw);

    const { pageHead, pageContent: pageSrcStripped } = extractPageHead(afterLayoutTag);

    const layoutPath = path.join(layoutsDir, `${layoutName}.html`);
    const layoutSrcRaw = await fs.readFile(layoutPath, 'utf-8');

    const componentNames = await discoverComponentNames(componentsDirs);

    let pageSrc = await expandComponents(pageSrcStripped, { componentsDirs, componentNames });
    pageSrc = await expandTemplateSrc(pageSrc, path.dirname(pagePath));
    const layoutSrc = await expandComponents(layoutSrcRaw, { componentsDirs, componentNames });

    // [[title]] resolves to "PageTitle | " (with separator) or "" (empty);
    // the layout provides its own suffix in the <title> tag, e.g.
    // <title>[[title]][[siteName]]</title>
    const pageTitle = layoutTitle ?? title ?? '';
    const titlePrefix = pageTitle ? `${pageTitle} | ` : '';

    let result = layoutSrc
        .replaceAll('[[title]]', htmlEscape(titlePrefix))
        .replaceAll('[[cssHref]]', cssHref ? `<link rel="stylesheet" href="${htmlEscape(cssHref)}" />` : '')
        .replaceAll('[[jsSrc]]', jsSrc ? `<script src="${htmlEscape(jsSrc)}" type="module" defer></script>` : '')
        .replaceAll('[[pageHead]]', pageHead)
        .replace('[[app]]', pageSrc);

    for (const [key, value] of Object.entries(siteConfig)) {
        result = result.replaceAll(`[[${key}]]`, htmlEscape(String(value ?? '')));
    }

    // [[moduleAdminNav]] — inject admin nav links from modules that declare adminNav
    if (result.includes('[[moduleAdminNav]]')) {
        const modules = Array.isArray(siteConfig.modules) ? siteConfig.modules : [];
        const navLinks = modules
            .filter(mod => typeof mod === 'object' && mod.defaults?.adminNav)
            .map(mod => {
                const nav = mod.config?.adminNav ?? mod.defaults.adminNav;
                if (nav === false) return ''; // configure(mod, { adminNav: false }) disables it
                return `<a data-nav-section="${htmlEscape(nav.path)}" href="${htmlEscape(nav.path)}" data-requires-permission="${htmlEscape(nav.permission || 'admin.access')}" hidden class="hover:text-slate-300">${htmlEscape(nav.label)}</a>`;
            })
            .filter(Boolean)
            .join('\n                    ');
        result = result.replaceAll('[[moduleAdminNav]]', navLinks);
    }

    result = result.replaceAll('[[gitSha]]', getGitSha());

    return result;
}
