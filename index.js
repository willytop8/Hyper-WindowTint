'use strict';

/**
 * hyper-windowtint
 *
 * Assigns each Hyper project group an ephemeral random color from a curated
 * palette, then paints the window border, tab accent, and (optionally) a
 * small corner badge with the color's name.
 *
 * v0.1: seeded color by session UID (each new tab got a stable color for
 * its lifetime).
 *
 * v0.2: groups sessions by the project root of the session's cwd, then gives
 * each project root a random color seed for the current Hyper main-process
 * lifetime. Two open terminals in the same project match; restarting Hyper
 * can assign that project a different color. The project root is found by
 * walking up from cwd to the nearest `.git`; if none, the raw cwd is used.
 * Falls back to session UID if cwd never arrives.
 *
 * This module is loaded in BOTH Hyper processes. decorateSessionOptions /
 * onWindow / onUnload run in main; decorateConfig / middleware / decorateTerm
 * / decorateTab / getTabProps run in renderer. The two sides communicate via
 * win.rpc — we piggyback a `windowtint:session-seed` event onto the normal
 * `session add` rpc emit so the renderer has the project-group seed before
 * SESSION_ADD reaches the Redux store (no uid→project color flicker).
 * Renderer-side OSC 7 handling updates the seed when a tab changes
 * directories.
 */

// ---------------------------------------------------------------------------
// Curated palette — Tailwind 400s, picked for distinctness on dark backgrounds.
// ---------------------------------------------------------------------------
const DEFAULT_PALETTE = [
  { name: 'rose',    hex: '#fb7185' },
  { name: 'orange',  hex: '#fb923c' },
  { name: 'amber',   hex: '#fbbf24' },
  { name: 'lime',    hex: '#a3e635' },
  { name: 'emerald', hex: '#34d399' },
  { name: 'teal',    hex: '#2dd4bf' },
  { name: 'cyan',    hex: '#22d3ee' },
  { name: 'sky',     hex: '#38bdf8' },
  { name: 'indigo',  hex: '#818cf8' },
  { name: 'violet',  hex: '#a78bfa' },
  { name: 'fuchsia', hex: '#e879f9' },
  { name: 'pink',    hex: '#f472b6' },
];

// ---------------------------------------------------------------------------
// Seed hash → palette index (FNV-1a, no native deps).
// ---------------------------------------------------------------------------
function hashToIndex(str, mod) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

function pickColor(seed, palette) {
  return palette[hashToIndex(String(seed || 'default'), palette.length)];
}

function colorForSeed(seed) {
  return pickColor(seed, userOpts.palette);
}

// Normalize a possibly-8-digit hex (#RRGGBBAA) to #RRGGBB and append an
// explicit 2-char alpha. Without this, composing `color.hex + '55'` against a
// user-supplied 8-digit hex produced an invalid 10-char color string.
function withAlpha(hex, alpha) {
  if (typeof hex !== 'string') return hex;
  const m = hex.match(/^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/);
  if (!m) return hex;
  return '#' + m[1] + alpha;
}

// ---------------------------------------------------------------------------
// User config (read at decorateConfig time, captured in module scope).
// ---------------------------------------------------------------------------
let userOpts = {
  palette: DEFAULT_PALETTE,
  borderWidth: '3px',
  showBadge: true,
  glow: true,
};

function readUserConfig(config) {
  const u = (config && config.windowTint) || {};
  const palette = Array.isArray(u.palette)
    ? u.palette.filter((item) => (
      item &&
      typeof item.name === 'string' &&
      item.name.trim().length > 0 &&
      typeof item.hex === 'string' &&
      /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(item.hex)
    ))
    : DEFAULT_PALETTE;
  return {
    palette: palette.length ? palette : DEFAULT_PALETTE,
    borderWidth: typeof u.borderWidth === 'string' ? u.borderWidth : '3px',
    showBadge: u.showBadge === true,
    glow: u.glow !== false,
  };
}

// ===========================================================================
// MAIN-PROCESS SECTION
// ===========================================================================
// decorateSessionOptions, onWindow, onUnload are only invoked in main.
// Module-scope maps declared here live in the main process when populated
// from main-side hooks.
// ===========================================================================

// cwd → resolved project root (walk up to .git, else cwd itself). Cached so
// repeat sessions in the same tree don't redo the fs walk.
const projectRootCache = new Map();
const projectRootPromises = new Map();

// project root → ephemeral random seed. This intentionally does not persist
// across Hyper restarts; it only keeps same-project terminals matched while
// the app is running.
const projectSeedCache = new Map();

// uid → seed, populated in decorateSessionOptions, drained when the
// matching `session add` rpc emit fires for that uid in onWindow's wrap.
const pendingSeeds = new Map();
const pendingSeedTimers = new Map();
const tintedWindows = new Set();

const PENDING_SEED_TTL_MS = 30000;

function deletePendingSeed(uid) {
  const timer = pendingSeedTimers.get(uid);
  if (timer) {
    clearTimeout(timer);
    pendingSeedTimers.delete(uid);
  }
  pendingSeeds.delete(uid);
}

function setPendingSeed(uid, seed) {
  deletePendingSeed(uid);
  pendingSeeds.set(uid, seed);
  const timer = setTimeout(() => {
    deletePendingSeed(uid);
  }, PENDING_SEED_TTL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
  pendingSeedTimers.set(uid, timer);
}

async function resolveProjectRootAsync(cwd) {
  if (!cwd) return cwd;
  if (projectRootCache.has(cwd)) return projectRootCache.get(cwd);
  if (projectRootPromises.has(cwd)) return projectRootPromises.get(cwd);

  const promise = (async () => {
    let root = cwd;
    let cacheKey = cwd;
    try {
      const path = require('path');
      const fs = require('fs');
      let dir = cwd;
      try {
        dir = await fs.promises.realpath(cwd);
        cacheKey = dir;
      } catch (e) {
        // Fall back to the provided cwd if realpath fails.
      }
      if (projectRootCache.has(cacheKey)) {
        const cachedRoot = projectRootCache.get(cacheKey);
        projectRootCache.set(cwd, cachedRoot);
        return cachedRoot;
      }

      let prev = null;
      while (dir && dir !== prev) {
        try {
          await fs.promises.access(path.join(dir, '.git'));
          root = dir;
          break;
        } catch (e) { /* keep walking */ }
        prev = dir;
        dir = path.dirname(dir);
      }
    } catch (e) {
      // If require or fs access fails, fall back to the raw cwd.
    }

    projectRootCache.set(cwd, root);
    projectRootCache.set(cacheKey, root);
    return root;
  })();

  projectRootPromises.set(cwd, promise);
  try {
    return await promise;
  } finally {
    projectRootPromises.delete(cwd);
  }
}

function createRandomSeed(salt) {
  return `windowtint:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}${salt != null ? ':' + salt : ''}`;
}

// Main-process palette-size hint for collision avoidance. The user can
// override the palette in their renderer-side config, but main can't see
// that, so we assume the default 12-slot palette here. If a user shrinks
// their palette, the worst case is that we'll still allocate indices 0–11
// uniformly — they just won't all be reachable in the renderer.
const COLLISION_AVOIDANCE_PALETTE_SIZE = DEFAULT_PALETTE.length;

function seedForProjectRoot(root) {
  if (!root) return root;
  if (projectSeedCache.has(root)) return projectSeedCache.get(root);

  // Figure out which palette indices are currently taken by other projects
  // so we can prefer a slot that isn't already in use.
  const paletteSize = COLLISION_AVOIDANCE_PALETTE_SIZE;
  const usedIndices = new Set();
  projectSeedCache.forEach((existingSeed) => {
    usedIndices.add(hashToIndex(existingSeed, paletteSize));
  });

  // Brute-force candidate seeds until one hashes to an unused index, or we
  // run out of attempts. Probability of a single attempt being clean is
  // (paletteSize - usedIndices.size) / paletteSize, so 200 attempts is more
  // than enough until ~11 colors are taken.
  let seed = null;
  if (usedIndices.size < paletteSize) {
    for (let i = 0; i < 200; i++) {
      const candidate = createRandomSeed(i);
      if (!usedIndices.has(hashToIndex(candidate, paletteSize))) {
        seed = candidate;
        break;
      }
    }
  }
  // Fallback: more projects than colors, or 200 attempts didn't find a clean
  // index — just take a random seed and accept the collision.
  if (!seed) seed = createRandomSeed();

  projectSeedCache.set(root, seed);
  return seed;
}

exports.decorateSessionOptions = (options) => {
  try {
    if (options && options.uid && options.cwd) {
      resolveProjectRootAsync(options.cwd).then((root) => {
        const seed = seedForProjectRoot(root);
        if (!seed) return;
        setPendingSeed(options.uid, seed);
        broadcastSessionSeed(options.uid, seed);
      }).catch(() => {});
    }
  } catch (e) { /* never break session spawn over a tint lookup */ }
  return options;
};

function broadcastSessionSeed(uid, seed) {
  tintedWindows.forEach((win) => {
    try {
      if (win && win.rpc && typeof win.rpc.emit === 'function') {
        win.rpc.emit('windowtint:session-seed', { uid, seed });
      }
    } catch (e) { /* swallow */ }
  });
}

// Wrap win.rpc.emit once per window so we can inject `windowtint:session-seed`
// immediately before Hyper's own `session add` reaches the renderer. The
// per-rpc state object survives plugin reloads, so the persistent wrapper can
// consume seeds from the newest module instance instead of a stale closure.
exports.onWindow = (win) => {
  try {
    if (!win || !win.rpc || typeof win.rpc.emit !== 'function') return;
    tintedWindows.add(win);

    const state = win.rpc.__windowtint_state__ || {};
    state.consumeSeed = (uid) => {
      const seed = pendingSeeds.get(uid);
      if (seed) deletePendingSeed(uid);
      return seed;
    };
    state.resolveCwd = (payload) => {
      try {
        if (!payload || !payload.uid || !payload.cwd) return;
        resolveProjectRootAsync(payload.cwd).then((root) => {
          const seed = seedForProjectRoot(root);
          if (seed) win.rpc.emit('windowtint:session-seed', { uid: payload.uid, seed });
        }).catch(() => {});
      } catch (e) { /* swallow */ }
    };
    win.rpc.__windowtint_state__ = state;

    if (!state.cwdListenerInstalled && typeof win.rpc.on === 'function') {
      state.cwdListener = (payload) => {
        const rpcState = win.rpc.__windowtint_state__;
        if (rpcState && rpcState.resolveCwd) rpcState.resolveCwd(payload);
      };
      win.rpc.on('windowtint:cwd-change', state.cwdListener);
      state.cwdListenerInstalled = true;
    }

    if (state.wrappedEmit) return;
    if (win.rpc.emit.__windowtint_wrapped__ && win.rpc.emit.__windowtint_uses_state__) {
      state.wrappedEmit = win.rpc.emit;
      return;
    }

    const originalEmit = win.rpc.emit;
    const wrappedEmit = function (...args) {
      const channel = args[0];
      const payload = args[1];
      try {
        if (channel === 'session add' && payload && payload.uid) {
          const rpcState = win.rpc.__windowtint_state__;
          const seed = rpcState && rpcState.consumeSeed && rpcState.consumeSeed(payload.uid);
          if (seed) {
            Reflect.apply(originalEmit, this, ['windowtint:session-seed', { uid: payload.uid, seed }]);
          }
        }
      } catch (e) { /* swallow — the original emit must still run */ }
      return Reflect.apply(originalEmit, this, args);
    };
    wrappedEmit.__windowtint_wrapped__ = true;
    wrappedEmit.__windowtint_uses_state__ = true;
    wrappedEmit.__windowtint_original__ = originalEmit;
    state.wrappedEmit = wrappedEmit;
    win.rpc.emit = wrappedEmit;
  } catch (e) { /* swallow */ }
};

function removeRpcListener(rpc, event, listener) {
  if (!rpc || !listener) return;
  // Hyper exposes the listener on `rpc` directly; older shapes used
  // `rpc.emitter`. Try the documented paths in order and stop at the first
  // that actually accepts the call.
  const targets = [
    [rpc, 'removeListener'],
    [rpc, 'off'],
    [rpc.emitter, 'removeListener'],
    [rpc.emitter, 'off'],
  ];
  for (const [target, method] of targets) {
    if (target && typeof target[method] === 'function') {
      try { target[method](event, listener); return; } catch (e) { /* try next */ }
    }
  }
}

exports.onUnload = () => {
  try {
    tintedWindows.forEach((win) => {
      try {
        const state = win && win.rpc && win.rpc.__windowtint_state__;
        if (state && state.cwdListener && win && win.rpc) {
          removeRpcListener(win.rpc, 'windowtint:cwd-change', state.cwdListener);
        }
        if (state) {
          state.cwdListener = null;
          state.cwdListenerInstalled = false;
          state.resolveCwd = null;
          if (
            state.wrappedEmit &&
            state.wrappedEmit.__windowtint_original__ &&
            win.rpc &&
            win.rpc.emit === state.wrappedEmit
          ) {
            win.rpc.emit = state.wrappedEmit.__windowtint_original__;
          }
          state.wrappedEmit = null;
          state.consumeSeed = null;
        }
      } catch (e) { /* swallow */ }
    });
    tintedWindows.clear();
    projectSeedCache.clear();
    projectRootPromises.clear();
    projectRootCache.clear();
  } catch (e) { /* swallow */ }
};

// ===========================================================================
// RENDERER-PROCESS SECTION
// ===========================================================================

// uid → seed, populated by the rpc listener installed lazily inside middleware.
const uidToSeed = new Map();
let rpcListenerInstalled = false;
let rpcSeedListener = null;
let currentSeed = null;

function applyTint(color, opts) {
  if (typeof document === 'undefined' || !color) return;
  const root = document.documentElement;
  root.style.setProperty('--tint-color', color.hex);
  root.style.setProperty('--tint-glow', opts.glow ? withAlpha(color.hex, '55') : 'transparent');
  root.style.setProperty('--tint-tab-bg', withAlpha(color.hex, '22'));
  root.style.setProperty('--tint-name', `"${color.name}"`);
}

function tintForUid(uid) {
  if (!uid) return;
  const seed = uidToSeed.get(uid) || uid;
  if (seed === currentSeed) return;
  currentSeed = seed;
  applyTint(colorForSeed(seed), userOpts);
}

function setSeedForUid(uid, seed) {
  uidToSeed.set(uid, seed);
}

function installRpcListener(store) {
  if (rpcListenerInstalled) return;
  if (typeof window === 'undefined' || !window.rpc || typeof window.rpc.on !== 'function') return;
  rpcListenerInstalled = true;

  rpcSeedListener = (payload) => {
    try {
      if (!payload || !payload.uid || !payload.seed) return;
      setSeedForUid(payload.uid, payload.seed);

      // If the seed arrived after the session was already tinted (race —
      // shouldn't happen in practice because we emit seed before `session
      // add`, but cheap insurance), retint the active session now.
      const state = store.getState();
      const activeUid = state.sessions && state.sessions.activeUid;
      if (activeUid === payload.uid) {
        currentSeed = null; // force re-eval
        tintForUid(activeUid);
      }
    } catch (e) { /* swallow */ }
  };

  window.rpc.on('windowtint:session-seed', rpcSeedListener);
}

exports.onRendererUnload = () => {
  try {
    if (rpcSeedListener && typeof window !== 'undefined' && window.rpc) {
      removeRpcListener(window.rpc, 'windowtint:session-seed', rpcSeedListener);
    }
    rpcSeedListener = null;
    rpcListenerInstalled = false;
    uidToSeed.clear();
    currentSeed = null;
  } catch (e) { /* swallow */ }
};

function parseOsc7Cwd(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname || '');
    // Guard `process`: with Electron contextIsolation the renderer may not
    // have a `process` global. Without the guard this throws a ReferenceError
    // and we silently fail to update on cwd change.
    const isWin32 =
      typeof process !== 'undefined' && process && process.platform === 'win32';
    if (isWin32 && /^\/[a-zA-Z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || null;
  } catch (e) {
    return null;
  }
}

function sendCwdChange(uid, cwd) {
  if (
    !uid ||
    !cwd ||
    typeof window === 'undefined' ||
    !window.rpc ||
    typeof window.rpc.emit !== 'function'
  ) {
    return;
  }
  try {
    window.rpc.emit('windowtint:cwd-change', { uid, cwd });
  } catch (e) { /* swallow */ }
}

function installOsc7Handler(uid, term) {
  try {
    if (!uid || !term || !term.parser || typeof term.parser.registerOscHandler !== 'function') return null;
    return term.parser.registerOscHandler(7, (value) => {
      const cwd = parseOsc7Cwd(value);
      if (cwd) sendCwdChange(uid, cwd);
      return true;
    });
  } catch (e) {
    return null;
  }
}

exports.decorateTerm = (Term, { React }) => {
  return class WindowTintTerm extends React.PureComponent {
    constructor(props) {
      super(props);
      this.osc7Disposable = null;
      this.termComponent = null;
      this.installInterval = null;
      this.installStartedAt = 0;
    }

    tryInstallOsc7 = () => {
      if (this.osc7Disposable || !this.termComponent) return;
      if (this.termComponent.term) {
        this.osc7Disposable = installOsc7Handler(this.props.uid, this.termComponent.term);
        if (this.installInterval) {
          clearInterval(this.installInterval);
          this.installInterval = null;
        }
        return;
      }
      if (!this.installInterval) {
        this.installStartedAt = Date.now();
        this.installInterval = setInterval(() => {
          if (Date.now() - this.installStartedAt > 5000) {
            clearInterval(this.installInterval);
            this.installInterval = null;
            return;
          }
          this.tryInstallOsc7();
        }, 50);
      }
    };

    disposeOsc7 = () => {
      if (this.installInterval) {
        clearInterval(this.installInterval);
        this.installInterval = null;
      }
      if (this.osc7Disposable && typeof this.osc7Disposable.dispose === 'function') {
        this.osc7Disposable.dispose();
      }
      this.osc7Disposable = null;
    };

    onDecorated = (termComponent) => {
      if (this.props.onDecorated) {
        this.props.onDecorated(termComponent);
      }
      this.termComponent = termComponent;
      if (!termComponent) {
        this.disposeOsc7();
        return;
      }
      this.tryInstallOsc7();
    };

    componentDidMount() {
      this.tryInstallOsc7();
    }

    componentWillUnmount() {
      this.disposeOsc7();
      this.termComponent = null;
    }

    render() {
      return React.createElement(Term, Object.assign({}, this.props, { onDecorated: this.onDecorated }));
    }
  };
};

exports.decorateConfig = (config) => {
  userOpts = readUserConfig(config);

  const badgeCSS = userOpts.showBadge ? `
  .hyper_main::after {
    content: var(--tint-name, '');
    position: absolute;
    top: 6px;
    right: 14px;
    font: 600 10px/1 -apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--tint-color, transparent);
    opacity: 0.55;
    pointer-events: none;
    z-index: 1000;
  }` : '';

  // Render the border as an inset box-shadow directly on `.hyper_main`. Hyper
  // sets `.hyper_main` to `position: fixed; inset: 0` so it fills the window;
  // we must NOT override `position` here, or the element collapses to its
  // content-height (~2px) and the entire terminal disappears. The badge
  // pseudo-element below stays inside `.hyper_main`'s fixed positioning
  // context, so `position: absolute` on the badge still anchors correctly.
  const borderWidth = userOpts.borderWidth || '3px';
  const css = `
  /* hyper-windowtint v0.3 */
  .hyper_main {
    box-shadow:
      inset 0 0 0 ${borderWidth} var(--tint-color, transparent),
      inset 0 0 28px -10px var(--tint-glow, transparent);
    transition: box-shadow 0.25s ease;
  }
  .hyper_main .tabs_title,
  .hyper_main .tabs_borderShim {
    border-top-color: var(--tint-color, transparent) !important;
  }
  .hyper_main .tab_tab.tab_active {
    background: linear-gradient(180deg, var(--tint-tab-bg, transparent), transparent);
  }
  ${badgeCSS}
  `;

  return Object.assign({}, config, {
    css: `${config.css || ''}\n${css}`,
  });
};

// No `decorateTab` export in this version. Hyper 3.x's Tab component drops
// most plugin-injected props (`customChildrenBefore`, `style`, `className`,
// `borderColor` all observed dropped on this user's build), so per-tab
// decoration via the documented API doesn't actually paint. The window-level
// CSS variables set by the middleware already communicate the active
// project's color via the window border, the active-tab background gradient,
// and the colored top line in the tab bar — that's enough for now.
// Per-tab outlines for inactive tabs may come back in a future release using
// a different mechanism (e.g. a renderer-side DOM observer).

// Redux middleware: re-tint when sessions are added or switched, using the
// project-group seed if available, falling back to session UID.
exports.middleware = (store) => (next) => (action) => {
  installRpcListener(store);

  const result = next(action);

  if (
    action.type === 'SESSION_ADD' ||
    action.type === 'SESSION_SET_ACTIVE'
  ) {
    try {
      const state = store.getState();
      const activeUid =
        (state.sessions && state.sessions.activeUid) ||
        action.uid ||
        null;
      tintForUid(activeUid);
    } catch (e) {
      // Decoration only — never crash the terminal over a tint.
    }
  }

  return result;
};
