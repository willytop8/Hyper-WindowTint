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
      typeof item.hex === 'string' &&
      /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(item.hex)
    ))
    : DEFAULT_PALETTE;
  return {
    palette: palette.length ? palette : DEFAULT_PALETTE,
    borderWidth: typeof u.borderWidth === 'string' ? u.borderWidth : '3px',
    showBadge: u.showBadge !== false,
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
  pendingSeedTimers.set(uid, setTimeout(() => {
    deletePendingSeed(uid);
  }, PENDING_SEED_TTL_MS));
}

function resolveProjectRoot(cwd) {
  if (!cwd) return cwd;
  if (projectRootCache.has(cwd)) return projectRootCache.get(cwd);

  let root = cwd;
  let cacheKey = cwd;
  try {
    // Lazy require so the renderer never tries to pull in node fs/path here.
    const path = require('path');
    const fs = require('fs');
    const realpath = fs.realpathSync.native || fs.realpathSync;
    let dir = realpath(cwd);
    cacheKey = dir;
    if (projectRootCache.has(cacheKey)) {
      const cachedRoot = projectRootCache.get(cacheKey);
      projectRootCache.set(cwd, cachedRoot);
      return cachedRoot;
    }
    let prev = null;
    while (dir && dir !== prev) {
      try {
        if (fs.existsSync(path.join(dir, '.git'))) {
          root = dir;
          break;
        }
      } catch (e) { /* permissions etc — keep walking */ }
      prev = dir;
      dir = path.dirname(dir);
    }
  } catch (e) {
    // If require fails for any reason, fall back to the raw cwd.
  }

  projectRootCache.set(cwd, root);
  projectRootCache.set(cacheKey, root);
  return root;
}

function createRandomSeed() {
  return `windowtint:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

function seedForProjectRoot(root) {
  if (!root) return root;
  if (!projectSeedCache.has(root)) {
    projectSeedCache.set(root, createRandomSeed());
  }
  return projectSeedCache.get(root);
}

exports.decorateSessionOptions = (options) => {
  try {
    if (options && options.uid && options.cwd) {
      setPendingSeed(options.uid, seedForProjectRoot(resolveProjectRoot(options.cwd)));
    }
  } catch (e) { /* never break session spawn over a tint lookup */ }
  return options;
};

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
        const seed = seedForProjectRoot(resolveProjectRoot(payload.cwd));
        if (seed) {
          win.rpc.emit('windowtint:session-seed', { uid: payload.uid, seed });
        }
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

exports.onUnload = () => {
  try {
    tintedWindows.forEach((win) => {
      try {
        const state = win && win.rpc && win.rpc.__windowtint_state__;
        if (
          state &&
          state.cwdListener &&
          win.rpc &&
          win.rpc.emitter &&
          typeof win.rpc.emitter.removeListener === 'function'
        ) {
          win.rpc.emitter.removeListener('windowtint:cwd-change', state.cwdListener);
        }
        if (state) {
          state.cwdListener = null;
          state.cwdListenerInstalled = false;
          state.resolveCwd = null;
        }
      } catch (e) { /* swallow */ }
    });
    tintedWindows.clear();
    projectSeedCache.clear();
    projectRootCache.clear();
  } catch (e) { /* swallow */ }
};

// ===========================================================================
// RENDERER-PROCESS SECTION
// ===========================================================================

// uid → seed, populated by the rpc listener installed lazily inside middleware.
const uidToSeed = new Map();
const uidToColor = new Map();
let rpcListenerInstalled = false;
let rpcSeedListener = null;
let currentSeed = null;

function applyTint(color, opts) {
  if (typeof document === 'undefined' || !color) return;
  const root = document.documentElement;
  root.style.setProperty('--tint-color', color.hex);
  root.style.setProperty('--tint-glow', opts.glow ? color.hex + '55' : 'transparent');
  root.style.setProperty('--tint-tab-bg', color.hex + '22');
  root.style.setProperty('--tint-name', `"${color.name}"`);
}

function updateTabAccent(uid, color) {
  if (typeof document === 'undefined' || !uid || !color) return;
  const accent = document.querySelector(`[data-windowtint-uid="${uid}"]`);
  if (!accent) return;
  accent.style.background = color.hex;
  accent.style.boxShadow = `0 0 12px ${color.hex}66`;
}

function tintForUid(uid) {
  if (!uid) return;
  const seed = uidToSeed.get(uid) || uid;
  if (seed === currentSeed) return;
  currentSeed = seed;
  const color = colorForSeed(seed);
  applyTint(color, userOpts);
  uidToColor.set(uid, color);
  updateTabAccent(uid, color);
}

function setSeedForUid(uid, seed) {
  uidToSeed.set(uid, seed);
  const color = colorForSeed(seed);
  uidToColor.set(uid, color);
  updateTabAccent(uid, color);
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
    let listenerRemoved = false;
    if (
      rpcSeedListener &&
      typeof window !== 'undefined' &&
      window.rpc &&
      typeof window.rpc.removeListener === 'function'
    ) {
      window.rpc.removeListener('windowtint:session-seed', rpcSeedListener);
      listenerRemoved = true;
    }
    if (listenerRemoved || !rpcSeedListener) {
      rpcSeedListener = null;
      rpcListenerInstalled = false;
    }
    uidToSeed.clear();
    uidToColor.clear();
    currentSeed = null;
  } catch (e) { /* swallow */ }
};

function parseOsc7Cwd(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname || '');
    if (process.platform === 'win32' && /^\/[a-zA-Z]:\//.test(pathname)) {
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
      this.installTimer = null;
    }

    tryInstallOsc7 = () => {
      if (this.osc7Disposable || !this.termComponent) return;
      if (this.termComponent.term) {
        this.osc7Disposable = installOsc7Handler(this.props.uid, this.termComponent.term);
        return;
      }
      if (!this.installTimer) {
        this.installTimer = setTimeout(() => {
          this.installTimer = null;
          this.tryInstallOsc7();
        }, 0);
      }
    };

    disposeOsc7 = () => {
      if (this.installTimer) {
        clearTimeout(this.installTimer);
        this.installTimer = null;
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

  const css = `
  /* hyper-windowtint v0.2 */
  .hyper_main {
    position: relative;
  }
  .hyper_main::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: ${userOpts.borderWidth} solid var(--tint-color, transparent);
    box-shadow: inset 0 0 28px -10px var(--tint-glow, transparent);
    z-index: 999;
    transition: border-color 0.25s ease, box-shadow 0.25s ease;
  }
  .hyper_main .tabs_title,
  .hyper_main .tabs_borderShim {
    border-top-color: var(--tint-color, transparent) !important;
  }
  .hyper_main .tab_tab.tab_active {
    background: linear-gradient(180deg, var(--tint-tab-bg, transparent), transparent);
  }
  .hyper_main .tab_tab.tab_active .windowtint_tabAccent {
    height: 3px;
    opacity: 1;
  }
  ${badgeCSS}
  `;

  return Object.assign({}, config, {
    css: `${config.css || ''}\n${css}`,
  });
};

exports.decorateTab = (Tab, { React }) => {
  return class WindowTintTab extends React.PureComponent {
    render() {
      const uid = this.props.windowTintUid;
      const color = uid ? uidToColor.get(uid) : null;
      const accent = React.createElement('span', {
        className: 'windowtint_tabAccent',
        'data-windowtint-uid': uid,
        style: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: this.props.isActive ? 3 : 2,
          background: color ? color.hex : 'transparent',
          boxShadow: color ? `0 0 12px ${color.hex}66` : 'none',
          opacity: color ? (this.props.isActive ? 1 : 0.65) : 0,
          pointerEvents: 'none',
          transition: 'background 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease, height 0.2s ease',
        },
      });
      const existing = this.props.customChildrenBefore;
      const customChildrenBefore = existing ? [accent].concat(existing) : accent;
      return React.createElement(Tab, Object.assign({}, this.props, { customChildrenBefore }));
    }
  };
};

exports.getTabProps = (tab, parentProps, props) => {
  try {
    if (!tab || !tab.uid) return props;
    return Object.assign({}, props, { windowTintUid: tab.uid });
  } catch (e) {
    return props;
  }
};

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
