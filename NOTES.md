# NOTES  - graspr-build

Informal scratchpad for ideas, deferred features, and design notes that don't belong in `CHANGELOG.md` (which is for shipped releases) or `README.md` (which is for current behavior).

## Deferred features

_None right now._

> Shipped in 0.4.0 (see CHANGELOG.md): `buildPages({ flatRoutes: true })`, `buildPages({ minify: true })`, and automatic `dist/.vite/manifest.json` cleanup.
>
> Deferred for later (only if the vite/cli boundary gets revisited for another reason): move the manifest read into the Vite plugin's `writeBundle` hook so graspr-build never touches the manifest file on disk at all, rather than reading-then-deleting it.

---

## Format note

Each entry should have: **What** (one-line summary), **Why** (motivation, ideally with concrete numbers or a referenced incident), **How to apply** (enough detail that picking it up later doesn't require re-deriving the design). Move entries out of this file when they ship  - they should land in `CHANGELOG.md` instead.
