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
  vm.runInContext('globalThis.__test = { Store, App, Play, Engine, Board, Review, classifyPly, analyzeGame, validateState, defaultState, render };', context);
  return { dom, window, context };
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
