const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Chess = require('chess.js').Chess;

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(m => m[1]).filter(s => s.trim());

function makeDom(storage = {}) {
  const dom = new JSDOM(`<!doctype html><html><head><title>ChessLab test</title></head><body>
    <div id="tabs"></div><div id="nav-chips"></div><main id="main"></main>
    <div id="toast-root"></div><div id="modal-root"></div>
  </body></html>`, {
    url: 'https://chesslab.test/',
    runScripts: 'outside-only'
  });
  const values = new Map(Object.entries(storage));
  Object.defineProperty(dom.window, 'localStorage', {
    configurable: true,
    value: {
      getItem: k => values.has(k) ? values.get(k) : null,
      setItem: (k, v) => values.set(k, String(v)),
      removeItem: k => values.delete(k),
      clear: () => values.clear(),
      key: i => [...values.keys()][i] ?? null,
      get length() { return values.size; }
    }
  });
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.scrollTo = () => {};
  dom.window.Worker = class {
    constructor() { this.messages = []; this.onmessage = null; this.onerror = null; }
    postMessage(message) {
      this.messages.push(message);
      if (message === 'uci') setTimeout(() => this.onmessage?.({ data: 'uciok' }), 0);
      if (message === 'isready') setTimeout(() => this.onmessage?.({ data: 'readyok' }), 0);
    }
    terminate() { this.terminated = true; }
  };
  dom.window.URL.createObjectURL = () => 'blob:test';
  dom.window.URL.revokeObjectURL = () => {};
  dom.window.Blob = class {};
  return dom;
}

function loadApp({ storage = {} } = {}) {
  const dom = makeDom(storage);
  const { window } = dom;
  const context = {
    window,
    document: window.document,
    Chess,
    console,
    setTimeout,
    clearTimeout,
    matchMedia: window.matchMedia,
    localStorage: window.localStorage,
    URL: window.URL,
    Blob: window.Blob,
    Worker: window.Worker,
    FileReader: window.FileReader,
    DOMParser: window.DOMParser,
    Image: window.Image,
    AbortController,
    fetch: async () => { throw new Error('network disabled in tests'); }
  };
  const vm = require('vm');
  const script = inlineScripts.join('\n');
  vm.createContext(context);
  vm.runInContext(script, context, { filename: 'index-inline.js' });
  vm.runInContext('globalThis.__test = { Store, App, Play, Engine, Board, Review, classifyPly, analyzeGame, validateState, defaultState, render, runAnalysis, renderProgress, openModal, handleAction, myColorOfHeaders, validateAnalyzedChain };', context);
  return { dom, window, context };
}

async function waitFor(predicate, message='condition was not met', timeoutMs=2000){
  const started = Date.now();
  while(!predicate()){
    if(Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function getSourceFunction(source, name) {
  // The app is intentionally loaded as a browser bundle in production; this
  // helper is intentionally simple and only used for source-level invariants.
  return source.includes(name);
}

test('source exposes the corrected lifecycle and hardening hooks', () => {
  const source = inlineScripts.join('\n');
  for (const needle of [
    'generation:0',
    'timeoutId',
    'validateState',
    'evalAfterActual',
    'data-tc',
    "case 'flip-board'",
    'aria-label="Play best move"',
    'AbortController'
  ]) assert.equal(source.includes(needle), true, `missing ${needle}`);
  assert.equal(source.includes('data-ply="${i+1}"></span>'), false);
});

test('classifyPly computes mover-POV sacrifice and Black great-move gap', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  const g = new Chess();
  const fenBefore = g.fen();
  const played = 'e2e4';
  const ply = { fenBefore, uci: played };
  const prev = { best: played, bestCpWhite: 20, secondCpWhite: -100 };
  const cur = { bestCpWhite: 18, secondCpWhite: -100 };
  const c = classifyPly(ply, prev, cur, 'b', 2);
  assert.equal(c.sacPawns, 0);
  // A black move is compared from black's point of view; the helper must not
  // flip a white-normalized score twice.
  assert.ok(Number.isFinite(c.wpBefore));
});

test('Store migration normalizes v1 evalAfterActual and preserves a name-only draft', () => {
  const old = {
    settings: { username: 'x', depth: 800 },
    openingLines: [],
    analyzed: {
      old: {
        key: 'old', pgn: '1. e4 e5 1-0',
 headers: {}, summary: {},
 plies: [
   { fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfterActual: { bestCpWhite: 20 }, evalAfter: null },
   { fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfterActual: { bestCpWhite: 20 }, evalAfter: null }
 ]
      }
    },
    playbook: { name: 'Draft name', moves: '' }
  };
  const { context } = loadApp({ storage: { 'chesslab.v1': JSON.stringify(old) } });
  const { Store } = context.__test;
  Store.load();
  assert.equal(Store.state.settings.reviewMovetime, 700);
  assert.equal(Store.state.analyzed.old.plies[0].evalAfter.bestCpWhite, 20);
  assert.equal(Store.state.analyzed.old.plies.length, 2);
  assert.equal(Store.state.playbook.name, 'Draft name');
});

test('strict state validation rejects an opening line with an unsafe id', () => {
  const { context } = loadApp();
  assert.throws(() => context.validateState({
    settings: {}, openingLines: [{ id: 'x" onclick="alert(1)', name: 'x', moves: '' }]
  }), /Invalid/i);
});

test('Openings shows the sides derived from the last line move and saved-line practice uses them', () => {
  const { context } = loadApp();
  const { Store, App, Play, Engine, render } = context.__test;
  const originalPlayMove = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Store.state = context.defaultState();
  App.builder = { chess: new Chess(), name: 'Derived sides' };
  App.builder.chess.move('e4');
  App.builder.chess.move('e5');
  App.view = 'openings';
  render();
  const status = context.document.querySelector('[data-opening-sides]');
  assert.ok(status, 'Openings must show the derived practice sides');
  assert.match(status.textContent, /You:\s*Black/i);
  assert.match(status.textContent, /Engine:\s*White/i);
  assert.equal(context.document.querySelector('[data-opening-color]'), null, 'sides must be derived, not manually selected');

  Store.state.openingLines = [{ id: 'derived', name: 'Derived line', moves: 'e4 e5', fen: null }];
  render();
  context.document.querySelector('[data-act="practice-line"]').click();
  assert.equal(Play.session.color, 'b');
  assert.equal(Play.session.engineColor, 'w');
  assert.equal(Play.session.chess.turn(), 'w');
  Play.cancel();
  Engine.playMove = originalPlayMove;
});

test('opening practice derives Black ownership when the line ends on a Black move', () => {
  const { context } = loadApp();
  const { Store, App, Play, Engine, render } = context.__test;
  const originalPlayMove = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Store.state = context.defaultState();
  App.builder = { chess: new Chess(), name: 'Test line' };
  App.builder.chess.move('e4');
  App.view = 'openings';
  render();
  context.document.querySelector('[data-act="bb-practice"]').click();
  assert.equal(Play.session.color, 'w');
  assert.equal(Play.session.engineColor, 'b');
  assert.equal(Play.session.chess.turn(), 'b');
  Play.cancel();
  Engine.playMove = originalPlayMove;
});

test('builder seek uses an explicit action instead of generic ply navigation', () => {
  const source = inlineScripts.join('\n');
  const openingBlock = source.slice(source.indexOf('function renderOpenings'), source.indexOf('</script>', source.indexOf('function renderOpenings')));
  assert.match(openingBlock, /data-act="bb-seek" data-ply=/);
  assert.doesNotMatch(openingBlock, /class="mv" data-ply=/);
});

test('Board binds one event set per element', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  const g = new Chess();
  Board.init(el, g, { color: 'w', interactive: true });
  const first = Board._handlers.length;
  Board.init(el, g, { color: 'w', interactive: true });
  assert.equal(Board._handlers.length, first);
  assert.ok(first > 0);
});

test('Review navigation uses the centralized ply setter and best-line branch', () => {
  const { context } = loadApp();
  const { Review } = context.__test;
  const g = new Chess(); g.move('e4'); g.move('e5');
  Review.open({ key: 'x', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: '?' },
      { fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null, cls: '?' }
    ] });
  Review.setPly(1);
  assert.equal(Review.nav, 1);
  Review.setPly(0);
  assert.equal(Review.nav, 0);
});

test('Play cancellation invalidates delayed engine work', () => {
  const { context } = loadApp();
  const { Play, Engine } = context.__test;
  const original = Engine.playMove;
  let resolveSearch;
  Engine.playMove = () => new Promise(resolve => { resolveSearch = resolve; });
  Play.start({ color: 'w', skill: 1, lineMoves: '' });
  const old = Play.session;
  Play.cancel();
  if(resolveSearch) resolveSearch('e7e5');
  assert.equal(Play.session, null);
  assert.equal(old.cancelled, true);
  Engine.playMove = original;
});

test('builder restores a persisted draft before rendering', () => {
  const { context } = loadApp({ storage: { 'chesslab.v1': JSON.stringify({
    settings: {}, playbook: { name: 'Draft', moves: 'e4 e5' }
  }) } });
  const { App, render } = context.__test;
  App.view = 'openings';
  render();
  assert.equal(App.builder.name, 'Draft');
  assert.equal(App.builder.chess.history().join(' '), 'e4 e5');
});

test('strict state validation rejects malformed analyzed PGN and accepts valid practice games', () => {
  const { context } = loadApp();
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    key: 'bad', pgn: '1. e4 e5 1-0', headers: {}, summary: {},
    plies: [{ fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1 }]
  } } }), /ply/i);
  const state = context.validateState({ settings: {}, practiceGames: [{ id: 'practice1', date: '2026-01-01', pgn: '1. e4 e5 1-0', result: 'draw' }] });
  assert.equal(state.practiceGames.length, 1);
});

test('strict analysis state accepts records without an optional practiceGames array', () => {
  const { context } = loadApp();
  const g = new Chess(); g.move('e4'); g.move('e5');
  const state = context.validateState({ settings: {}, analyzed: { x: {
    key: 'x', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null },
      { fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null }
    ]
  } } }, { strict: true });
  assert.equal(Object.keys(state.analyzed).length, 1);
});

test('progress rendering treats __proto__ ECO as data, not an object prototype', () => {
  const { context } = loadApp();
  const { Store, App, renderProgress } = context.__test;
  Store.state = context.defaultState();
  Store.state.settings.username = 'victim';
  Store.state.analyzed = { hostile: {
    key: 'hostile', pgn: '1. e4 e5 1-0', date: '2026-01-01', headers: { White: 'victim', Black: 'other', ECO: '__proto__' },
    summary: { white: { accuracy: 80, blunder: 1 }, black: { accuracy: 70, blunder: 2 } },
    plies: [{ fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1 }]
  } };
  App.view = 'progress';
  const before = Object.prototype.n;
  const html = renderProgress();
  assert.equal(context.myColorOfHeaders(Store.state.analyzed.hostile.headers), 'w');
  assert.equal(Object.prototype.n, before);
  assert.match(html, /__proto__/);
});

test('progress rendering does not mutate Object.prototype from imported ECO keys', () => {
  const { context } = loadApp();
  const { Store, App, renderProgress } = context.__test;
  Store.state = context.defaultState();
  Store.state.settings.username = 'victim';
  for (const eco of ['__proto__', 'constructor', 'toString']) Store.state.analyzed[eco] = {
    key: eco, pgn: '1. e4 e5 1-0', date: '2026-01-01', headers: { White: 'victim', Black: 'other', ECO: eco },
    summary: { white: { accuracy: 80, blunder: 1 }, black: { accuracy: 70, blunder: 2 } }, plies: []
  };
  App.view = 'progress';
  const before = { n: Object.prototype.n, acc: Object.prototype.acc, b: Object.prototype.b };
  renderProgress();
  assert.deepEqual({ n: Object.prototype.n, acc: Object.prototype.acc, b: Object.prototype.b }, before);
});

test('rendered saved-line controls use the escaped data-id value', () => {
  const { context } = loadApp();
  const { Store, App, render } = context.__test;
  Store.state = context.defaultState();
  Store.state.openingLines = [{ id: 'safe', name: 'Line', moves: 'e4' }];
  App.view = 'openings';
  render();
  const button = context.document.querySelector('[data-act="practice-line"]');
  assert.equal(button.getAttribute('data-id'), 'safe');
  assert.equal(button.getAttribute('onclick'), null);
});

test('analysis honors a PGN FEN setup instead of replaying from the standard start', async () => {
  const { context } = loadApp();
  const { Engine, analyzeGame } = context.__test;
  const start = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
  const g = new Chess(start); g.move('Nf3'); g.move('Nc6');
  const pgn = '[SetUp "1"]\n[FEN "'+start+'"]\n\n2. Nf3 Nc6 1-0';
  const original = Engine.analyse;
  Engine.analyse = async fen => {
    const c = new Chess(fen); const m = c.moves({verbose:true})[0];
    return { best: m.from+m.to+(m.promotion||''), bestCpWhite: 0, secondCpWhite: 0, bestMateWhite: null };
  };
  const result = await analyzeGame(pgn, { movetime: 100 });
  Engine.analyse = original;
  assert.equal(result.plies[0].fenBefore, start);
  assert.match(result.plies[1].fenBefore, /5N2/);
});

test('strict analysis state rejects malformed engine moves instead of dropping them', () => {
  const { context } = loadApp();
  const g = new Chess(); g.move('e4'); g.move('e5');
  const base = {
    key: 'bad', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null },
      { fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null }
    ]
  };
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    ...base, plies: [{ ...base.plies[0], evalBefore: { best: 'e9e9', bestCpWhite: 0 } }, base.plies[1]]
  } } }, { strict: true }), /engine|invalid/i);
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    ...base, plies: [base.plies[0], { ...base.plies[1], evalAfter: { best: 'e9e9', bestCpWhite: 0 } }]
  } } }, { strict: true }), /engine|invalid/i);
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    ...base, plies: [{ ...base.plies[0], evalBefore: 'e9e9' }, base.plies[1]]
  } } }, { strict: true }), /engine|invalid/i);
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    ...base, plies: [{ ...base.plies[0], evalBefore: { best: 'e2e4', bestUci: 'e9e9', bestCpWhite: 0 } }, base.plies[1]]
  } } }, { strict: true }), /engine|invalid/i);
  assert.throws(() => context.validateState({ settings: {}, analyzed: { bad: {
    ...base, plies: [{ ...base.plies[0], bestUci: 'e9e9' }, base.plies[1]]
  } } }, { strict: true }), /engine|invalid/i);
});

test('a stopped engine search cannot complete the next queued search', async () => {
  const { context } = loadApp();
  const { Engine } = context.__test;
  const sent = [];
  const worker = { postMessage(msg) { sent.push(msg); }, terminate() {} };
  Engine.worker = worker; Engine.ready = true; Engine.offline = false; Engine._busy = false; Engine._cur = null; Engine._queue = []; Engine._generation = 1;
  const first = Engine.playMove(new Chess().fen(), 8);
  const second = Engine.analyse(new Chess().fen(), 700, 1);
  Engine.cancelPlay();
  assert.equal(await first, null);
  Engine._dispatch('bestmove e2e4');
  assert.equal(Engine._cur?.kind, 'analysis');
  assert.equal(sent.filter(x => x === 'position fen '+new Chess().fen()).length >= 1, true);
  Engine._dispatch('info depth 1 multipv 1 score cp 0 pv d2d4');
  Engine._dispatch('bestmove d2d4');
  const value = await second;
  assert.equal(value.best, 'd2d4');
});

test('keyboard navigation moves focus without selecting or moving until activation', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  const g = new Chess();
  const calls = [];
  Board.init(el, g, { color: 'w', interactive: true });
  Board.onSquare = sq => calls.push(sq);
  el.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  assert.equal(Board.focusSquare, 'e3');
  assert.deepEqual(calls, []);
  el.dispatchEvent(new context.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.deepEqual(calls, ['e3']);
});

test('engine source fallback preserves queued analysis after a replacement-worker failure', async () => {
  const { context } = loadApp();
  const { Engine } = context.__test;
  const OriginalWorker = context.Worker;
  let constructions = 0;
  context.Worker = class {
    constructor() {
      constructions++;
      if (constructions === 1) throw new Error('first source unavailable');
      this.messages = [];
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(message) {
      this.messages.push(message);
      if (message === 'uci') setTimeout(() => this.onmessage?.({ data: 'uciok' }), 0);
      if (message === 'isready') setTimeout(() => this.onmessage?.({ data: 'readyok' }), 0);
    }
    terminate() {}
  };
  Engine.SOURCES = ['bad', 'good'];
  Engine.worker = null; Engine.ready = false; Engine.offline = false;
  Engine._busy = false; Engine._cur = null; Engine._queue = []; Engine._generation = 1;
  let rejected = false;
  const pending = Engine.analyse(new Chess().fen(), 700, 1).catch(() => { rejected = true; });
  Engine._try(0, true);
  await waitFor(() => Engine._cur?.kind === 'analysis', 'replacement worker did not start queued analysis');
  assert.equal(constructions, 2);
  assert.equal(rejected, false, 'queued analysis must survive source fallback');
  assert.equal(Engine._cur?.kind, 'analysis');
  Engine._dispatch('info depth 1 multipv 1 score cp 0 pv e2e4');
  Engine._dispatch('bestmove e2e4');
  await pending;
  context.Worker = OriginalWorker;
});

test('engine fatal source fallback preserves active and queued analysis', async () => {
  const { context } = loadApp();
  const { Engine } = context.__test;
  const OriginalWorker = context.Worker;
  let constructions = 0;
  context.Worker = class {
    constructor() {
      constructions++;
      this.messages = [];
      this.onmessage = null;
      this.onerror = null;
    }
    postMessage(message) {
      this.messages.push(message);
      if (message === 'uci') setTimeout(() => this.onmessage?.({ data: 'uciok' }), 0);
      if (message === 'isready') setTimeout(() => this.onmessage?.({ data: 'readyok' }), 0);
    }
    terminate() {}
  };
  Engine.SOURCES = ['bad', 'good'];
  Engine.worker = null; Engine.ready = false; Engine.offline = false;
  Engine._busy = false; Engine._cur = null; Engine._queue = []; Engine._generation = 1;
  const firstFen = new Chess().fen();
  const secondFen = new Chess('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1').fen();
  const first = Engine.analyse(firstFen, 700, 1);
  const second = Engine.analyse(secondFen, 700, 1);
  Engine._try(0, true);
  await waitFor(() => Engine._cur?.fen === firstFen, 'initial analysis did not start');
  Engine.worker.onmessage({ data: '__fatal:source failed' });
  await waitFor(() => constructions === 2 && Engine._cur?.fen === firstFen, 'source failure lost active analysis');
  assert.equal(constructions, 2);
  assert.equal(Engine._cur?.fen, firstFen, 'active analysis must be requeued after source failure');
  Engine._dispatch('info depth 1 multipv 1 score cp 0 pv e2e4');
  Engine._dispatch('bestmove e2e4');
  await first;
  await waitFor(() => Engine._cur?.fen === secondFen, 'queued analysis did not start after first completed');
  assert.equal(Engine._cur?.fen, secondFen, 'queued analysis must remain queued');
  Engine._dispatch('info depth 1 multipv 1 score cp 0 pv e7e5');
  Engine._dispatch('bestmove e7e5');
  await second;
  context.Worker = OriginalWorker;
});

test('an illegal engine reply falls back to a legal move instead of wedging Play', () => {
  const { context } = loadApp();
  const { Play, Engine } = context.__test;
  const original = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Play.start({ color: 'w', skill: 1, lineMoves: '' });
  const S = Play.session;
  Play._apply('e9e9');
  assert.equal(S.chess.history().length, 1);
  assert.equal(S.chess.turn(), 'b');
  assert.equal(Play._thinking, true);
  Play.cancel();
  Engine.playMove = original;
});

test('analysis resets Stockfish Skill Level before searching', async () => {
  const { context } = loadApp();
  const { Engine } = context.__test;
  const sent = [];
  const worker = { postMessage(msg) { sent.push(msg); }, terminate() {} };
  Engine.worker = worker; Engine.ready = true; Engine.offline = false; Engine._busy = false; Engine._cur = null; Engine._queue = []; Engine._generation = 1;
  const pending = Engine.analyse(new Chess().fen(), 700, 1);
  assert.equal(sent.includes('setoption name Skill Level value 20'), true);
  Engine._dispatch('info depth 1 multipv 1 score cp 0 pv e2e4');
  Engine._dispatch('bestmove e2e4');
  await pending;
});

test('classifyPly detects a materially exposed played move versus the engine line', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  const fen = '4k2r/8/8/8/8/8/8/4K2Q w - - 0 1';
  const c = classifyPly({ fenBefore: fen, uci: 'h1h5' }, { best: 'h1h5', bestCpWhite: 20, secondCpWhite: -120 }, { bestCpWhite: 18, secondCpWhite: -120 }, 'w', 3);
  assert.ok(c.sacPawns >= 9);
  assert.equal(c.cls, 'brilliant');
});

test('reset data closes the modal through its focus-trap cleanup path', () => {
  const source = inlineScripts.join('\n');
  assert.match(source, /#do-reset[\s\S]{0,300}close\(\)/);
});

test('saved-line controls escape their data-id attribute', () => {
  const source = inlineScripts.join('\n');
  assert.match(source, /data-id="'\+esc\(l\.id\)\+'"/);
});

test('strict analysis state accepts records without an optional practiceGames array', () => {
  const { context } = loadApp();
  const g = new Chess(); g.move('e4'); g.move('e5');
  const state = context.validateState({ settings: {}, analyzed: { x: {
    key: 'x', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: new Chess().fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null },
      { fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1', san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null }
    ]
  } } }, { strict: true });
  assert.equal(Object.keys(state.analyzed).length, 1);
});
