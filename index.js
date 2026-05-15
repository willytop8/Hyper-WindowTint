'use strict';

/**
 * hyper-windowtint
 *
 * Assigns each Hyper session a deterministic color from a curated palette,
 * then paints the window border, tab accent, and (optionally) a small
 * corner badge with the color's name.
 *
 * v0.1: seeded color by session UID (each new tab got a stable color for
 * its lifetime).
 *
 * v0.2: seeds color by the project root of the session's cwd, so the same
 * project always opens in the same color across sessions ("Bobber is always
 * teal"). The project root is found by walking up from cwd to the nearest
 * directory containing `.git`; if none, the raw cwd is used. Falls back to
 * session UID if cwd never arrives.
 *
 * Roadmap:
 *   - v0.3: hook xterm.js parser for OSC 7, retint live on `cd`.
 *
 * This module is loaded in BOTH Hyper processes. decorateSessionOptions /
 * onWindow / onUnload run in main; decorateConfig / middleware run in
 * renderer. The two sides communicate via win.rpc — we piggyback a
 * `windowtint:session-seed` event onto the normal `session add` rpc emit
 * so the renderer has the cwd-derived seed before SESSION_ADD reaches the
 * Redux store (no uid→cwd color flicker).
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
// Deterministic hash → palette index (FNV-1a, no native deps).
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
  return {
    palette: Array.isArray(u.palette) && u.palette.length ? u.palette : DEFAULT_PALETTE,
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

// uid → seed, populated in decorateSessionOptions, drained when the
// matching `session add` rpc emit fires for that uid in onWindow's wrap.
const pendingSeeds = new Map();
const pendingSeedTimers = new Map();

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

exports.decorateSessionOptions = (options) => {
  try {
    if (options && options.uid && options.cwd) {
      setPendingSeed(options.uid, resolveProjectRoot(options.cwd));
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

    const state = win.rpc.__windowtint_state__ || {};
    state.consumeSeed = (uid) => {
      const seed = pendingSeeds.get(uid);
      if (seed) deletePendingSeed(uid);
      return seed;
    };
    win.rpc.__windowtint_state__ = state;

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
    pendingSeedTimers.forEach((timer) => clearTimeout(timer));
    pendingSeedTimers.clear();
    pendingSeeds.clear();
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
  root.style.setProperty('--tint-glow', opts.glow ? color.hex + '55' : 'transparent');
  root.style.setProperty('--tint-tab-bg', color.hex + '22');
  root.style.setProperty('--tint-name', `"${color.name}"`);
}

function tintForUid(uid) {
  if (!uid) return;
  const seed = uidToSeed.get(uid) || uid;
  if (seed === currentSeed) return;
  currentSeed = seed;
  const color = pickColor(seed, userOpts.palette);
  applyTint(color, userOpts);
}

function installRpcListener(store) {
  if (rpcListenerInstalled) return;
  if (typeof window === 'undefined' || !window.rpc || typeof window.rpc.on !== 'function') return;
  rpcListenerInstalled = true;

  rpcSeedListener = (payload) => {
    try {
      if (!payload || !payload.uid || !payload.seed) return;
      uidToSeed.set(payload.uid, payload.seed);

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
    if (
      rpcSeedListener &&
      typeof window !== 'undefined' &&
      window.rpc &&
      typeof window.rpc.removeListener === 'function'
    ) {
      window.rpc.removeListener('windowtint:session-seed', rpcSeedListener);
    }
    rpcSeedListener = null;
    rpcListenerInstalled = false;
    uidToSeed.clear();
    currentSeed = null;
  } catch (e) { /* swallow */ }
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
  .tabs_title,
  .tabs_borderShim {
    border-top-color: var(--tint-color, transparent) !important;
  }
  .tab_tab.tab_active {
    background: linear-gradient(180deg, var(--tint-tab-bg, transparent), transparent) !important;
  }
  ${badgeCSS}
  `;

  return Object.assign({}, config, {
    css: `${config.css || ''}\n${css}`,
  });
};

// Redux middleware: re-tint when sessions are added or switched, using the
// cwd-derived seed if available, falling back to session UID.
exports.middleware = (store) => (next) => (action) => {
  installRpcListener(store);

  const result = next(action);

  if (
    action.type === 'SESSION_ADD' ||
    action.type === 'SESSION_SET_ACTIVE' ||
    action.type === 'SESSION_SET_XTERM_TITLE'
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
