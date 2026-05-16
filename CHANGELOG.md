# Changelog

All notable changes to `hyper-windowtint` will be documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
