#!/usr/bin/env node
/**
 * Real-Testing Regression Replay & Systematic Property-Based Explorer
 * Replay command:
 *   node tests/regression-and-explore.js [--seed=20261018] [--games=20] [--metamorphic=60]
 *
 * Operates the real `index.html` + `app.js` code in a lightweight DOM harness and:
 * 1. Verifies HTML contract invariants (inline favicon present, no orphaned <label for>).
 * 2. Replays all 6 concrete failures discovered during real-testing:
 *    - F1: Stop-Early via manual board clicks omitted `[Stop Early]` in notation (`finishInteractiveChain`).
 *    - F2: Clicking "Apply" in the sidebar while an interactive chain was in progress saved the
 *          half-mutated mid-chain board into the Undo snapshot (`commitFullTurn` / `saveSnapshotForUndo`).
 *    - F3: Clicking "Switch Active Turn" mid-chain left `state.board` half-mutated.
 *    - F4: Clicking "Setup Custom Board" mid-chain left `state.board` half-mutated.
 *    - F5: Canceling a mid-chain step via `Undo` when `history` was empty left `#btn-undo` enabled.
 *    - F6: Reloading from `localStorage` left `state.filterStartSq` undefined, filtering out all legal moves.
 * 3. Explores reachable multi-turn game states against an independent first-principles Fanorona reference oracle.
 * 4. Explores metamorphic equivalence between step-by-step interactive board clicks and 1-click turn application.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// Parse CLI flags
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);
const SEED = Number(args.seed || 20261018);
const NUM_GAMES = Number(args.games || 20);
const METAMORPHIC_STEPS = Number(args.metamorphic || 60);

// 1. Verify HTML contract invariants (F7: favicon & valid <label for="..."> targets)
function verifyHtmlContract() {
  assert(
    indexHtml.includes('<link rel="icon"'),
    'Expected inline SVG favicon in index.html to prevent /favicon.ico 404'
  );
  const labelForMatches = [...indexHtml.matchAll(/<label[^>]*\bfor="([^"]+)"/g)];
  for (const [, targetId] of labelForMatches) {
    const idRegex = new RegExp(`<(select|input|textarea)[^>]*\\bid="${targetId}"`);
    assert(
      idRegex.test(indexHtml),
      `<label for="${targetId}"> must reference a valid form control (select/input/textarea)`
    );
  }
}

// 2. Minimal DOM + Web Worker + localStorage harness to run the unmodified `app.js`
function createBrowserContext() {
  const elementsById = new Map();
  const storage = new Map();

  class MockElement {
    constructor(tagName = 'div', id = '') {
      this.tagName = tagName.toUpperCase();
      this.id = id;
      this.className = '';
      this.textContent = '';
      this._innerHTML = '';
      this.disabled = false;
      this.value = '';
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.children = [];
      this.listeners = new Map();
      this.classList = {
        _set: new Set(),
        add: (...cls) => cls.forEach(c => this.classList._set.add(c)),
        remove: (...cls) => cls.forEach(c => this.classList._set.delete(c)),
        toggle: (c, force) => {
          const shouldHave = force !== undefined ? Boolean(force) : !this.classList._set.has(c);
          if (shouldHave) this.classList._set.add(c);
          else this.classList._set.delete(c);
        },
        contains: c => this.classList._set.has(c)
      };
    }
    set innerHTML(val) {
      this._innerHTML = String(val);
      this.children = [];
    }
    get innerHTML() {
      return this._innerHTML;
    }
    setAttribute(k, v) {
      this.attributes.set(k, String(v));
      if (k === 'id') {
        this.id = String(v);
        elementsById.set(this.id, this);
      }
    }
    getAttribute(k) {
      return this.attributes.get(k) ?? null;
    }
    appendChild(child) {
      this.children.push(child);
      if (child && child.id) elementsById.set(child.id, child);
      return child;
    }
    append(...nodes) {
      for (const n of nodes) this.appendChild(n);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      const fns = this.listeners.get('click') || [];
      for (const fn of fns) fn({ stopPropagation() {}, preventDefault() {}, target: this });
    }
    querySelector() {
      return new MockElement('button');
    }
    querySelectorAll() {
      return [];
    }
  }

  // Pre-populate all IDs present in index.html
  for (const [, id] of indexHtml.matchAll(/\bid="([^"]+)"/g)) {
    const el = new MockElement('div', id);
    if (id === 'solver-depth') el.value = '900';
    if (id === 'editor-next-turn') el.value = 'player';
    elementsById.set(id, el);
  }

  const windowListeners = new Map();
  const context = {
    console,
    Math,
    Date,
    Set,
    Map,
    Array,
    Object,
    Number,
    String,
    Boolean,
    JSON,
    Infinity,
    setTimeout,
    clearTimeout,
    Blob: class {
      constructor(parts) {
        this.source = parts.join('\n');
      }
    },
    URL: {
      createObjectURL: blob => blob
    },
    Worker: class {
      constructor() {}
      postMessage() {}
      terminate() {}
    },
    localStorage: {
      getItem: k => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      clear: () => storage.clear()
    },
    document: {
      getElementById: id => {
        if (!elementsById.has(id)) {
          elementsById.set(id, new MockElement('div', id));
        }
        return elementsById.get(id);
      },
      createElement: tag => new MockElement(tag),
      createElementNS: (_ns, tag) => new MockElement(tag),
      querySelectorAll: () => []
    },
    window: {
      addEventListener: (type, fn) => {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
      dispatchKey: (key, opts = {}) => {
        const fns = windowListeners.get('keydown') || [];
        for (const fn of fns) {
          fn({ key, preventDefault() {}, target: { tagName: 'BODY' }, ...opts });
        }
      }
    }
  };

  vm.createContext(context);
  vm.runInContext(appJs, context, { filename: 'app.js' });
  context.state = vm.runInContext('state', context);

  // Trigger DOMContentLoaded initialization
  const domLoadedFns = windowListeners.get('DOMContentLoaded') || [];
  for (const fn of domLoadedFns) fn();

  return context;
}

// 3. Independent Reference Oracle for Fanorona Ruleset (structurally separate from app.js)
function generateReferenceTurns(board, activeColor) {
  const DIRS = [
    [-1, 0], [1, 0], [0, -1], [0, 1],
    [-1, -1], [-1, 1], [1, -1], [1, 1]
  ];
  const inBounds = (r, c) => r >= 0 && r < 5 && c >= 0 && c < 9;
  const sq = (r, c) => r * 9 + c;
  const rc = s => [Math.floor(s / 9), s % 9];
  const isStrong = (r, c) => (r + c) % 2 === 0;
  const enemy = activeColor === 1 ? 2 : 1;

  function walkLine(b, startR, startC, dr, dc) {
    const captured = [];
    let r = startR + dr;
    let c = startC + dc;
    while (inBounds(r, c) && b[sq(r, c)] === enemy) {
      captured.push(sq(r, c));
      r += dr;
      c += dc;
    }
    return captured;
  }

  const captureTurns = [];

  function dfs(curBoard, fromSq, visitedSet, lastDirIndex, stepsAcc, capturedAcc) {
    const [r, c] = rc(fromSq);
    const maxD = isStrong(r, c) ? 8 : 4;
    const continuations = [];

    for (let d = 0; d < maxD; d++) {
      if (d === lastDirIndex) continue;
      const [dr, dc] = DIRS[d];
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const toSq = sq(nr, nc);
      if (curBoard[toSq] !== 0 || visitedSet.has(toSq)) continue;

      const app = walkLine(curBoard, nr, nc, dr, dc);
      const wit = walkLine(curBoard, r, c, -dr, -dc);
      if (app.length > 0) continuations.push({ toSq, d, type: 'approach', cap: app });
      if (wit.length > 0) continuations.push({ toSq, d, type: 'withdraw', cap: wit });
    }

    if (stepsAcc.length > 0) {
      captureTurns.push({
        isCapture: true,
        steps: stepsAcc.slice(),
        totalCaptured: capturedAcc.slice(),
        finalBoard: curBoard.slice(),
        stoppedEarly: continuations.length > 0
      });
    }

    for (const move of continuations) {
      const nextBoard = curBoard.slice();
      nextBoard[move.toSq] = nextBoard[fromSq];
      nextBoard[fromSq] = 0;
      for (const k of move.cap) nextBoard[k] = 0;
      const nextVis = new Set(visitedSet);
      nextVis.add(move.toSq);
      dfs(
        nextBoard,
        move.toSq,
        nextVis,
        move.d,
        [...stepsAcc, { from: fromSq, to: move.toSq, type: move.type, captured: move.cap }],
        [...capturedAcc, ...move.cap]
      );
    }
  }

  for (let s = 0; s < 45; s++) {
    if (board[s] === activeColor) {
      dfs(board, s, new Set([s]), -1, [], []);
    }
  }

  if (captureTurns.length > 0) return captureTurns;

  const paikaTurns = [];
  for (let s = 0; s < 45; s++) {
    if (board[s] !== activeColor) continue;
    const [r, c] = rc(s);
    const maxD = isStrong(r, c) ? 8 : 4;
    for (let d = 0; d < maxD; d++) {
      const [dr, dc] = DIRS[d];
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const toSq = sq(nr, nc);
      if (board[toSq] !== 0) continue;
      const nextBoard = board.slice();
      nextBoard[toSq] = activeColor;
      nextBoard[s] = 0;
      paikaTurns.push({
        isCapture: false,
        steps: [{ from: s, to: toSq, type: 'paika', captured: [] }],
        totalCaptured: [],
        finalBoard: nextBoard,
        stoppedEarly: false
      });
    }
  }
  return paikaTurns;
}

// 4. Replay saved regressions F1..F6
function runSavedRegressions(ctx) {
  const {
    state,
    idx,
    sqName,
    startNewGame,
    generateAllLegalTurns,
    commitFullTurn,
    handleSquareClick,
    finishInteractiveChain,
    formatTurnNotation,
    undoMove,
    updateUndoRedoButtons,
    document
  } = ctx;

  ctx.localStorage.clear();
  startNewGame();

  // Play opening F4 -> E3
  commitFullTurn(generateAllLegalTurns(state.board, 1).find(t => sqName(t.steps[0].from) === 'F4'));
  state.history = [];
  updateUndoRedoButtons();
  const preAiBoard = state.board.slice();

  // Regression F5: Mid-chain Undo when history is empty must disable #btn-undo afterward
  handleSquareClick(idx(0, 3)); // D1
  handleSquareClick(idx(1, 3)); // D2 (chainInProgress === true)
  assert.strictEqual(document.getElementById('btn-undo').disabled, false, 'F5: Undo enabled during chain');
  undoMove();
  assert.strictEqual(document.getElementById('btn-undo').disabled, true, 'F5: Undo disabled after canceling chain with empty history');

  // Regression F1: Stop-Early via manual board clicks must include [Stop Early] in notation
  const stopEarlyTurn = generateAllLegalTurns(state.board, 2).find(
    t => sqName(t.steps[0].from) === 'D1' && t.stoppedEarly
  );
  const expectedStopEarlyNotation = formatTurnNotation(stopEarlyTurn);
  handleSquareClick(idx(0, 3)); // D1
  handleSquareClick(idx(1, 3)); // D2
  finishInteractiveChain();
  assert.strictEqual(
    state.moveLog[0]?.notation,
    expectedStopEarlyNotation,
    'F1: finishInteractiveChain notation must match stop-early turn notation'
  );

  // Regression F2: Mid-chain Sidebar Apply must roll back uncommitted chain before saving Undo snapshot
  undoMove();
  handleSquareClick(idx(0, 3)); // D1
  handleSquareClick(idx(1, 3)); // D2
  commitFullTurn(generateAllLegalTurns(preAiBoard, 2)[0]);
  undoMove();
  assert.strictEqual(
    state.board.join(''),
    preAiBoard.join(''),
    'F2: Undo after mid-chain sidebar Apply must restore start-of-turn board'
  );

  // Regression F3: Mid-chain Switch Active Turn must roll back uncommitted chain
  handleSquareClick(idx(0, 3)); // D1
  handleSquareClick(idx(1, 3)); // D2
  document.getElementById('btn-switch-turn-now').click();
  assert.strictEqual(
    state.board.join(''),
    preAiBoard.join(''),
    'F3: Switch Active Turn mid-chain must roll back uncommitted chain'
  );

  // Regression F4: Mid-chain Enter Edit Mode must roll back uncommitted chain
  state.activeTurnOwner = 'ai';
  handleSquareClick(idx(0, 3)); // D1
  handleSquareClick(idx(1, 3)); // D2
  document.getElementById('btn-toggle-edit').click();
  assert.strictEqual(
    state.board.join(''),
    preAiBoard.join(''),
    'F4: Entering Custom Board Editor mid-chain must roll back uncommitted chain'
  );
  document.getElementById('btn-finish-edit').click();

  // Regression F6: Reloading from localStorage must initialize filterStartSq to null and show all legal moves
  const savedRaw = ctx.localStorage.getItem('fanorona_ac4_state_v1');
  const freshCtx = createBrowserContext();
  freshCtx.localStorage.setItem('fanorona_ac4_state_v1', savedRaw);
  freshCtx.loadStateFromStorage();
  freshCtx.recomputeAndRender();
  assert.strictEqual(freshCtx.state.filterStartSq, null, 'F6: filterStartSq must be null after reload');
  assert.strictEqual(
    freshCtx.document.getElementById('legal-moves-count').textContent,
    String(freshCtx.generateAllLegalTurns(freshCtx.state.board, freshCtx.getActiveColor()).length),
    'F6: Legal moves count badge must equal all legal turns after reload from localStorage'
  );
}

// 5. Seeded PRNG (mulberry32)
function mulberry32(seed) {
  let a = seed;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 6. Systematic Exploration against Independent Reference Oracle + Metamorphic UI Checks
function runSystematicExploration(ctx) {
  const rand = mulberry32(SEED);
  const {
    state,
    createInitialBoard,
    generateAllLegalTurns,
    getActiveColor,
    handleSquareClick,
    executeInteractiveStep,
    finishInteractiveChain,
    commitFullTurn,
    undoMove,
    startNewGame
  } = ctx;

  let statesChecked = 0;
  let turnsVerified = 0;

  for (let g = 0; g < NUM_GAMES; g++) {
    let board = createInitialBoard(g % 2 === 0 ? 1 : 2, g % 3 === 0);
    let color = g % 2 === 0 ? 1 : 2;
    for (let ply = 0; ply < 12; ply++) {
      const appTurns = generateAllLegalTurns(board, color);
      const refTurns = generateReferenceTurns(board, color);
      statesChecked++;
      turnsVerified += refTurns.length;

      const sig = t =>
        `${t.steps.map(s => `${s.from}-${s.to}-${s.type}`).join(',')}#${t.stoppedEarly}#${t.finalBoard.join('')}`;
      const appSigs = new Set(appTurns.map(sig));
      const refSigs = new Set(refTurns.map(sig));

      assert.strictEqual(
        appTurns.length,
        refTurns.length,
        `Oracle turn count mismatch at game=${g} ply=${ply}`
      );
      for (const s of refSigs) {
        assert(appSigs.has(s), `Missing reference turn signature ${s} at game=${g} ply=${ply}`);
      }

      if (appTurns.length === 0) break;
      const chosen = appTurns[Math.floor(rand() * appTurns.length)];
      board = chosen.finalBoard.slice();
      color = color === 1 ? 2 : 1;
    }
  }

  // Metamorphic equivalence between step-by-step interactive board clicks and 1-click Apply
  startNewGame();
  let metamorphicChecked = 0;
  for (let i = 0; i < METAMORPHIC_STEPS; i++) {
    const activeColor = getActiveColor();
    const legalTurns = generateAllLegalTurns(state.board, activeColor);
    if (legalTurns.length === 0) {
      startNewGame();
      continue;
    }
    const interesting = legalTurns.filter(
      t => t.steps.length > 1 || t.stoppedEarly || t.steps.some(s => s.ambiguous)
    );
    const pool = interesting.length > 0 ? interesting : legalTurns;
    const chosen = pool[Math.floor(rand() * pool.length)];

    const startBoard = state.board.slice();
    const startOwner = state.activeTurnOwner;

    for (let sIdx = 0; sIdx < chosen.steps.length; sIdx++) {
      const step = chosen.steps[sIdx];
      if (sIdx === 0) handleSquareClick(step.from);
      handleSquareClick(step.to);
      if (state.pendingAmbiguousStep) {
        executeInteractiveStep(state.pendingAmbiguousStep, step.type);
      }
    }
    if (state.chainInProgress) {
      finishInteractiveChain();
    }

    const boardAfterClicks = state.board.join('');
    const notationAfterClicks = state.moveLog[0]?.notation;
    const ownerAfterClicks = state.activeTurnOwner;

    undoMove();
    assert.strictEqual(state.board.join(''), startBoard.join(''), `Undo board mismatch at step ${i}`);
    assert.strictEqual(state.activeTurnOwner, startOwner, `Undo owner mismatch at step ${i}`);

    commitFullTurn(chosen);
    assert.strictEqual(boardAfterClicks, state.board.join(''), `Metamorphic board mismatch at step ${i}`);
    assert.strictEqual(
      notationAfterClicks,
      state.moveLog[0]?.notation,
      `Metamorphic notation mismatch at step ${i}`
    );
    assert.strictEqual(ownerAfterClicks, state.activeTurnOwner, `Metamorphic owner mismatch at step ${i}`);
    metamorphicChecked++;
  }

  return { statesChecked, turnsVerified, metamorphicChecked };
}

function main() {
  verifyHtmlContract();
  const ctx = createBrowserContext();
  runSavedRegressions(ctx);
  const stats = runSystematicExploration(ctx);
  console.log(
    JSON.stringify(
      {
        status: 'PASS',
        seed: SEED,
        regressionsVerified: ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'],
        ...stats
      },
      null,
      2
    )
  );
}

main();
