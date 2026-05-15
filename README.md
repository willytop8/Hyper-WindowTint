# hyper-windowtint

Give every Hyper terminal window/tab a color so you can tell them apart at a glance, while matching tabs that belong to the same project during the current Hyper session.

Groups each session by its cwd, walked up to the nearest `.git` repo root when possible, then assigns that project group a random color from a curated 12-color palette for the current Hyper run. Restarting Hyper can assign a different color. The plugin paints:

- a thin colored border around the window
- a matching accent on the active tab
- a tiny color-name badge in the top-right corner (e.g. `ROSE`, `TEAL`)

The result: two tabs opened inside the same repo use the same color while Hyper is running. A different repo or directory gets its own initially random color. If cwd resolution ever fails entirely, the plugin falls back to the session UID, so the tab still gets a color.

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

- `decorateSessionOptions(options)` runs when a new session is about to be spawned. Hyper has already resolved both `options.uid` and `options.cwd` by this point. The plugin resolves `options.cwd` through `realpath`, then walks upward looking for a `.git` directory or file; if found, that path is the project group, otherwise the raw cwd is the group. Each group gets an ephemeral random seed that is reused only for the current Hyper main-process lifetime. Result is stashed in a module-scoped `uid → seed` map with a short expiry and cached per cwd so repeat lookups are cheap.
- `onWindow(win)` wraps `win.rpc.emit` so that immediately before Hyper's own `'session add'` IPC reaches the renderer, the plugin emits a `'windowtint:session-seed'` event with `{uid, seed}`. This avoids a uid→cwd color flicker on session creation. The wrap is idempotent per window, and reload-stable state on `win.rpc` lets the persistent wrapper consume seeds from the newest plugin module after hot reloads.
- `onUnload` clears the caches.

**Renderer process:**

- `decorateConfig` injects CSS that styles `.hyper_main`, the tab bar, and the badge using CSS custom properties (`--tint-color`, `--tint-glow`, `--tint-tab-bg`, `--tint-name`).
- A `window.rpc.on('windowtint:session-seed', ...)` listener (installed lazily by the middleware and removed on renderer unload) caches `uid → seed`. If a seed somehow arrives after the session has already been tinted, the active session retints immediately.
- Redux middleware listens for `SESSION_ADD`, `SESSION_SET_ACTIVE`, and `SESSION_SET_XTERM_TITLE`, looks up the cached seed by uid (falls back to the uid itself), maps it to the palette, and writes the resulting color to the root element's CSS variables.

## Project grouping

Color assignment is intentionally not permanent. The grouping rules are:

- Inside a git repo, every tab in that repo shares the same color for the current Hyper run.
- Outside a git repo, tabs opened from the same cwd share a color for the current Hyper run.
- After restarting Hyper, those groups can receive different colors.
- If Hyper does not provide a cwd, the plugin falls back to the session UID.

## Roadmap

1. **v0.3: OSC 7 live retint.** Hook xterm.js's parser to listen for OSC 7 sequences emitted by the shell on every `cd`, so the tint updates without spawning a new tab. Requires a small zsh-side config (`chpwd` hook to emit OSC 7).
2. **Optional color labels.** Expose the current in-memory project group color so helper scripts can find matching windows without making the assignment permanent.
3. **Admin/sudo override.** Force red for elevated shells (steal this from `hyperborder`'s `adminBorderColors`).
4. **OKLCH-spaced palette generator** for any N colors with guaranteed perceptual distinctness.
5. **Window-vs-tab differentiation.** Color the border by window, the tab accent by session — within one window, tabs are sub-coded but the window has a "primary" identity.

## License

MIT
