# hyper-windowtint

Give every Hyper terminal window/tab a deterministic color so you can tell them apart at a glance — and so the same project always lives in the same color.

Hashes the session's cwd (walked up to the nearest `.git` repo root) against a curated 12-color palette (Tailwind 400s, picked for distinctness on dark backgrounds), then paints:

- a thin colored border around the window
- a matching accent on the active tab
- a tiny color-name badge in the top-right corner (e.g. `ROSE`, `TEAL`)

The result: `~/Projects/Bobber` is always teal. `~/Projects/TOKKYU` is always magenta. Open a new tab in any subdirectory of Bobber and it still comes up teal. Open something outside a git repo (like a tab in `~/Downloads`) and the color is hashed from the cwd directly. If cwd resolution ever fails entirely (older Hyper, plugin reload races), it falls back to the session UID — same behavior as v0.1.

## Install (local dev)

Hyper supports local plugins out of the box. Drop this folder into:

```
~/.hyper_plugins/local/hyper-windowtint
```

Then in `~/.hyper.js`:

```js
module.exports = {
  config: {
    // ...your existing config
  },
  plugins: [],
  localPlugins: ['hyper-windowtint'],
};
```

Restart Hyper (or `Cmd+Shift+R` to reload the renderer).

## Config

All options live under `config.windowTint` in `~/.hyper.js`:

```js
module.exports = {
  config: {
    windowTint: {
      borderWidth: '3px',      // CSS string
      showBadge: true,         // tiny color-name pill in the corner
      glow: true,              // inner glow effect
      palette: [               // optional — override the default palette
        { name: 'red',   hex: '#ef4444' },
        { name: 'green', hex: '#22c55e' },
        { name: 'blue',  hex: '#3b82f6' },
      ],
    },
  },
  localPlugins: ['hyper-windowtint'],
};
```

## How it works

**Main process:**

- `decorateSessionOptions(options)` runs when a new session is about to be spawned. Hyper has already resolved both `options.uid` and `options.cwd` by this point. The plugin resolves `options.cwd` through `realpath`, then walks upward looking for a `.git` directory or file; if found, that path is the seed, otherwise the raw cwd is the seed. Result is stashed in a module-scoped `uid → seed` map with a short expiry and cached per cwd so repeat lookups are free.
- `onWindow(win)` wraps `win.rpc.emit` so that immediately before Hyper's own `'session add'` IPC reaches the renderer, the plugin emits a `'windowtint:session-seed'` event with `{uid, seed}`. This avoids a uid→cwd color flicker on session creation. The wrap is idempotent per window, and reload-stable state on `win.rpc` lets the persistent wrapper consume seeds from the newest plugin module after hot reloads.
- `onUnload` clears the caches.

**Renderer process:**

- `decorateConfig` injects CSS that styles `.hyper_main`, the tab bar, and the badge using CSS custom properties (`--tint-color`, `--tint-glow`, `--tint-tab-bg`, `--tint-name`).
- A `window.rpc.on('windowtint:session-seed', ...)` listener (installed lazily by the middleware and removed on renderer unload) caches `uid → seed`. If a seed somehow arrives after the session has already been tinted, the active session retints immediately.
- Redux middleware listens for `SESSION_ADD`, `SESSION_SET_ACTIVE`, and `SESSION_SET_XTERM_TITLE`, looks up the cached seed by uid (falls back to the uid itself), hashes with FNV-1a, and writes the resulting palette color to the root element's CSS variables.

## cwd → color mapping

The "seed" is the string that gets hashed. The mapping is:

| cwd                              | seed used to hash      | reason                          |
|----------------------------------|------------------------|---------------------------------|
| `~/Projects/Bobber/src/api`      | `~/Projects/Bobber`    | walked up to nearest `.git`     |
| `~/Projects/TOKKYU`              | `~/Projects/TOKKYU`    | already at repo root            |
| `~/Downloads`                    | `~/Downloads`          | no `.git` ancestor, use cwd     |
| (no cwd — older Hyper / race)    | session UID            | v0.1 fallback                   |

To see what your seed will be for the current tab, run `git rev-parse --show-toplevel` (or just `pwd` if you're not in a repo).

## Roadmap

1. **v0.3: OSC 7 live retint.** Hook xterm.js's parser to listen for OSC 7 sequences emitted by the shell on every `cd`, so the tint updates without spawning a new tab. Requires a small zsh-side config (`chpwd` hook to emit OSC 7).
2. **Persisted color labels.** Store the resolved `cwd → color name` mapping in `~/.hyper_plugins/windowtint.json` so a launcher script can ask "where's the teal one?"
3. **Admin/sudo override.** Force red for elevated shells (steal this from `hyperborder`'s `adminBorderColors`).
4. **OKLCH-spaced palette generator** for any N colors with guaranteed perceptual distinctness.
5. **Window-vs-tab differentiation.** Color the border by window, the tab accent by session — within one window, tabs are sub-coded but the window has a "primary" identity.

## License

MIT
