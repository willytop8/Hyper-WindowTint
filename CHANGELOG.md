# Changelog

All notable changes to `hyper-windowtint` will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.6] - 2026-05-16

### Changed
- README now shows a real screenshot of four Hyper windows in four projects
  (`docs/demo-hero.png`) instead of the placeholder. Image is referenced via
  full GitHub raw URL so it renders on both github.com and npmjs.com.

## [0.3.5] - 2026-05-16

### Fixed
- Color collisions across projects. Previously every project root got an
  independent random seed, and two random seeds could hash to the same
  palette index — so two unrelated projects regularly came out the same
  color. `seedForProjectRoot` now tracks which palette indices are in use
  by other active projects and rolls candidate seeds until it finds one
  that hashes to an unused slot. The first 12 distinct project roots in
  a Hyper session are now guaranteed to get 12 distinct colors; only
  projects 13+ have to collide.

## [0.3.4] - 2026-05-16

### Changed
- README now references real screenshots in `docs/` instead of a placeholder.

### Removed
- Dead code left over from 0.3.3's `decorateTab` removal: the `uidToColor`
  map, the `tintVersion` counter and its `WINDOWTINT_COLOR_CHANGE` dispatch,
  and the `reduceUI` export. None affected runtime; they only existed to
  feed the now-removed per-tab decorations. `index.js` drops from 647 to 622
  lines.

## [0.3.3] - 2026-05-16

### Changed
- Corner color-name badge now defaults to **off**. Opt back in with
  `config.windowTint.showBadge: true` in `~/.hyper.js`.

### Removed
- The bottom underline accent and the left/right edge stripes that 0.3.2
  added via `decorateTab`'s `customChildrenBefore`. Hyper 3.x's Tab
  component does not render plugin-injected children, so these decorations
  were never actually painting on most users' screens. The `decorateTab`,
  `getTabProps`, and `mapHeaderState` exports have been removed entirely
  since they only served those non-rendering decorations.
- The dead-code path that depended on those exports.

### Note
- The window-level signals — colored window border, top line in the tab
  bar, and the active-tab background gradient — all still work and remain
  the primary at-a-glance project indicator. Per-tab outlines for inactive
  tabs are deferred to a future release pending a different mechanism
  (likely a renderer-side DOM observer) that bypasses Hyper's prop-dropping.

## [0.3.2] - 2026-05-16

### Added
- Colored side stripes on each tab. Each tab now renders a 3–4px full-height
  bar on its left and right edge in the tab's project color, so the boundary
  between two tabs visibly shows both projects' colors. Tab colors are now
  legible at a glance without making a tab active.

## [0.3.1] - 2026-05-16

### Fixed
- Critical: plugin CSS no longer overrides `.hyper_main`'s `position: fixed`.
  In 0.3.0 the plugin added `position: relative`, which Hyper's CSS-in-JS
  scoping elevated to higher specificity than Hyper's own rule. `.hyper_main`
  then collapsed to its content-height (~2px) and the entire terminal area
  rendered as an unusable black rectangle (visible tint border + corner badge,
  but no tabs and no terminal canvas). The border is now drawn as an inset
  `box-shadow` directly on `.hyper_main` without touching `position`, so the
  fixed-positioning context from Hyper is preserved.

## [0.3.0] - 2026-05-16

### Added
- Project-group color assignment: tabs whose cwd resolves to the same `.git`
  root share a color for the current Hyper run.
- Live retint on `cd` for shells that emit OSC 7 cwd reports.
- Optional corner badge showing the current color name (`showBadge`).
- Optional inner glow (`glow`).
- Custom palette support with strict per-entry validation
  (non-empty `name`, 6- or 8-digit hex).
- Shell helper snippets (zsh / bash) in the README for shells that do not
  emit OSC 7 by default.

### Changed
- Color assignment is now ephemeral per Hyper main-process lifetime, not
  permanent per project.
- Project root resolution moved off the synchronous session-spawn path
  using `fs.promises`.
- Tab accents are prop-driven through `mapHeaderState`, `getTabProps`, and
  `decorateTab` instead of DOM query hacks.
- `win.rpc.emit` wrapper and `windowtint:cwd-change` listener are now
  restored / removed on `onUnload`.
- Renderer-side `windowtint:session-seed` listener removal is more
  defensive about which method Hyper exposes (`removeListener` / `off`).

### Fixed
- 8-digit hex colors in a user-supplied palette no longer produce invalid
  10-character color strings when composing glow/tab-bg/box-shadow.
- Listener removal in `onUnload` no longer assumes `rpc.emitter` —
  falls back across `rpc.removeListener`, `rpc.off`, `rpc.emitter.removeListener`.
- `parseOsc7Cwd` no longer throws when `process` is undefined in renderers
  with Electron contextIsolation enabled.
- Various silent error swallowing on the main side so a single bad cwd
  lookup cannot crash session spawn.

## [0.1.0]

### Added
- Initial release. Each session UID got a stable, deterministic color
  for its lifetime, drawn from a fixed palette.
