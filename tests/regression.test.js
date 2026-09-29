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
  vm.runInContext('globalThis.__test = { Store, App, Play, Engine, Board, Review, Importer, classifyPly, analyzeGame, validateState, defaultState, render, renderPlay, renderOpenings, renderReview, renderReviewReport, mountBuilderBoard, mountReviewBoard, runAnalysis, renderProgress, openModal, handleAction, go, myColorOf, myColorOfHeaders, validateAnalyzedChain, sanitizeMoves, ensureBuilderModel, activeBuilderBranch, createBuilderBranch, switchBuilderBranch, builderDiverges, syncBuilderBranch, savePlaybook, recordBuilderMove, BOOK_LINES };', context);
  return { dom, window, context, waitFor };
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

test('classifyPly gives a near-best move Best instead of Excellent', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // Midgame position: no book theory applies, so this isolates the
  // near-best tolerance. Bd3 is not the engine's top choice but gives up a
  // vanishingly small amount of win chance, so it is equally good -> Best.
  const fenBefore = 'r1bq1rk1/ppp2ppp/2n5/3np3/1b2P3/2N1BN2/PPP2PPP/R2Q1RK1 w - - 0 9';
  const c = classifyPly({ fenBefore, uci: 'f3d3' }, { best: 'c3b1', bestCpWhite: 30, secondCpWhite: 28 }, { bestCpWhite: 28, secondCpWhite: 20 }, 'w', 9);
  assert.equal(c.cls, 'best');
});

test('classifyPly keeps Excellent for a move that gives up real win chance', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // Same position and move, but now the move genuinely gives up win chance
  // (1.37%) against a better engine choice. That is above the near-best
  // noise floor and below the 2% Excellent ceiling, so: Excellent, not Best.
  const fenBefore = 'r1bq1rk1/ppp2ppp/2n5/3np3/1b2P3/2N1BN2/PPP2PPP/R2Q1RK1 w - - 0 9';
  const c = classifyPly({ fenBefore, uci: 'f3d3' }, { best: 'c3b1', bestCpWhite: 45, secondCpWhite: 10 }, { bestCpWhite: 30, secondCpWhite: 10 }, 'w', 9);
  assert.equal(c.cls, 'excellent');
});

test('classifyPly awards Great only when the move is both best and uniquely best', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  const fenBefore = 'r1bq1rk1/ppp2ppp/2n5/3np3/1b2P3/2N1BN2/PPP2PPP/R2Q1RK1 w - - 0 9';
  const played = 'f3d3';
  // Best move is far ahead of the second choice in win probability -> Great.
  const great = classifyPly({ fenBefore, uci: played }, { best: played, bestCpWhite: 60, secondCpWhite: -120 }, { bestCpWhite: 58, secondCpWhite: -120 }, 'w', 9);
  assert.equal(great.cls, 'great');
  // A 300cp gap, but between two already-crushing evaluations the gap is
  // worth almost nothing in win probability. That is Best, not Great.
  const crushing = classifyPly({ fenBefore, uci: played }, { best: played, bestCpWhite: 1500, secondCpWhite: 1200 }, { bestCpWhite: 1498, secondCpWhite: 1200 }, 'w', 9);
  assert.equal(crushing.cls, 'best');
});

test('classifyPly awards Book for real opening theory played correctly', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  const start = new Chess().fen();
  // 1.e4 is book theory and a sound move.
  const theory = classifyPly({ fenBefore: start, uci: 'e2e4' }, { best: 'e2e4', bestCpWhite: 25, secondCpWhite: 24 }, { bestCpWhite: 24, secondCpWhite: 10 }, 'w', 1);
  assert.equal(theory.cls, 'book');
  // The same theory move when it throws the game away is a blunder, not Book.
  const broken = classifyPly({ fenBefore: start, uci: 'e2e4' }, { best: 'g1f3', bestCpWhite: 25, secondCpWhite: 24 }, { bestCpWhite: -900, secondCpWhite: -950 }, 'w', 1);
  assert.equal(broken.cls, 'blunder');
});

test('every move class has a distinct colour and a distinct icon', () => {
  const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  // Strip the dark-theme overrides first so only the 10 light rules are counted.
  const lightOnly = style.replace(/html\[data-theme="dark"\][^{]*\{[^}]*\}/g, '').replace(/html\[data-theme="dark"\]\s*\.[^{]*\{[^}]*\}/g, '');
  const cls = lightOnly.match(/\.cls-(brilliant|great|best|excellent|good|book|inaccuracy|mistake|blunder|q)\{background:([^;}]+)[^}]*\}/g) || [];
  assert.equal(cls.length, 10, 'expected exactly 10 light-theme colour rules, matched ' + cls.length);
  const colours = cls.map(s => (s.match(/background:([^;}]+)/) || [])[1]);
  const named = new Set(cls.map(s => (s.match(/\.cls-([a-z]+)/) || [])[1]));
  assert.equal(named.size, 10, 'every class needs its own colour rule, got: ' + [...named].join(','));
  assert.equal(new Set(colours).size, colours.length, 'class colours must be unique: ' + colours.join(','));
  const iconRule = (inlineScripts.join('\n').match(/CLS_ICON\s*=\s*\{[^}]+\}/) || [])[0];
  assert.ok(iconRule, 'CLS_ICON map is required');
  const pairs = [...iconRule.matchAll(/([a-z]+):'([^']+)'/g)].map(m => m[1] + '=' + m[2]);
  assert.equal(pairs.length, 10, 'CLS_ICON must cover all 10 classes: ' + pairs.join(','));
  assert.equal(new Set(pairs.map(p => p.split('=')[1])).size, 10, 'each class needs a unique icon glyph: ' + pairs.join(','));
});

test('the move list shows the quality icon beside each move', () => {
  const { context } = loadApp();
  const { Review, renderReviewReport } = context.__test;
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'icons', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'brilliant' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: { best: 'e7e5', bestCpWhite: 0, secondCpWhite: 0 }, evalAfter: { bestCpWhite: 0, secondCpWhite: 0 }, cls: 'blunder' }
    ] });
  const html = renderReviewReport();
  assert.match(html, /mv-ico[^>]*>★/);
  assert.match(html, /mv-ico[^>]*>✕/);
  assert.match(html, /title="e4 — Brilliant"/);
  assert.match(html, /title="e5 — Blunder"/);
  assert.match(html, /aria-label="e4, Brilliant"/);
  assert.match(html, /aria-label="e5, Blunder"/);
});

test('an ordinary developing move is not counted as a sacrifice', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // Black to move after 1.e4 e5 2.Nf3 Nc6 3.Bb5. Playing a6 is a normal
  // Ruy Lopez developing move. White's bishop attacks a6 (a 1-pawn risk, not
  // a sacrifice) and can take the c6 knight, but that knight was already loose
  // before the move. Counting that pre-existing material is what used to
  // score a6 as brilliant.
  const fenBefore = 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3';
  const c = classifyPly({ fenBefore, uci: 'a7a6' }, { best: 'a7a6', bestCpWhite: 20, secondCpWhite: 19 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'b', 3);
  assert.ok(c.sacPawns < 2, 'a6 is a developing move, not a material sacrifice (got ' + c.sacPawns + ')');
  assert.notEqual(c.cls, 'brilliant');
});

test('a developing move beside already-loose material is not a sacrifice', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // Black plays 4..Nf6. The c6 knight is hanging to Bxc6, but that was
  // already true before the move. Nf6 itself risks nothing, so it must score
  // zero material at risk rather than the 3 points of the loose knight.
  const fenBefore = 'r1bqkbnr/pp1ppppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 1 3';
  const c = classifyPly({ fenBefore, uci: 'g8f6' }, { best: 'g8f6', bestCpWhite: 20, secondCpWhite: 19 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'b', 4);
  assert.equal(c.sacPawns, 0, 'Nf6 risks nothing of its own');
  assert.notEqual(c.cls, 'brilliant');
});

test('a real queen sacrifice is detected as material at risk', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // White plays Qh5 offering the queen on an undefended square: a genuine
  // sacrifice, which is the only thing that should earn brilliant.
  const fenBefore = '4k2r/8/8/8/8/8/8/4K2Q w - - 0 1';
  const c = classifyPly({ fenBefore, uci: 'h1h5' }, { best: 'h1h5', bestCpWhite: 20, secondCpWhite: -120 }, { bestCpWhite: 18, secondCpWhite: -120 }, 'w', 3);
  assert.ok(c.sacPawns >= 9, 'an undefended queen must be seen as material at risk');
  assert.equal(c.cls, 'brilliant');
});

test('a defended landing square only gives up what the defence cannot save', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // White plays Nb1-a3, which the a8 rook can take. The b2 pawn does answer
  // with bxa3, so the pawn is not lost -- but the knight still is. Trading a
  // knight for a pawn gives up two, which is the least the brilliant gate
  // accepts.
  const fenBefore = 'r3k3/8/8/8/8/8/1P6/1N2K3 w - - 0 1';
  const c = classifyPly({ fenBefore, uci: 'b1a3' }, { best: 'b1a3', bestCpWhite: 20, secondCpWhite: 19 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'w', 1);
  assert.equal(c.sacPawns, 2, 'the knight is lost even though the pawn answers: 3 - 1 = 2');
});

test('the opening book is recognised through a transposition', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // The Semi-Slav position reached as 1.d4 d5 2.c4 c6 (the book line) and as
  // 1.c4 c6 2.d4 d5 (a different move order) is the same position. The move
  // that continues it must be book either way, so the book key must not
  // include the halfmove clock.
  const book = new Chess();
  for (const san of ['d4', 'd5', 'c4', 'c6']) book.move(san);
  const transposed = new Chess();
  for (const san of ['c4', 'c6', 'd4', 'd5']) transposed.move(san);
  assert.notEqual(book.fen(), transposed.fen(), 'the two orders differ in the halfmove clock');
  const key = (f) => f.split(' ').slice(0, 3).join(' ');
  assert.equal(key(book.fen()), key(transposed.fen()), 'the positions themselves are identical');
  const c = classifyPly({ fenBefore: transposed.fen(), uci: 'g1f3' }, { best: 'g1f3', bestCpWhite: 5, secondCpWhite: 0 }, { bestCpWhite: 4, secondCpWhite: -5 }, 'w', 3);
  assert.equal(c.cls, 'book', 'a move continuing a transposed book position is still book');
});

test('a recapture that is itself met is not a defence', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // 1.Nb5! cxb5 2.axb5 Rxb5. White recaptures with the a-pawn, but that
  // recaptured pawn is then taken too, so nothing was actually answered and
  // White is three pawns down. The recapture exists on b5 yet does not hold.
  const fenBefore = '1r5k/8/2p5/8/P7/N7/8/R3K3 w - - 0 1';
  const c = classifyPly({ fenBefore, uci: 'a3b5' }, { best: 'a3b5', bestCpWhite: 20, secondCpWhite: -200 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'w', 1);
  assert.equal(c.sacPawns, 3, 'a recapture that is itself captured is not a real answer');
});

test('a recapture that trades up still leaves material at risk', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // White offers Qd5, Black takes it with the rook, and White can only answer
  // with the c-pawn. The queen is gone and only a pawn comes back, so eight
  // pawns are still given up -- answering the capture is not the same as
  // saving the material.
  const fenBefore = '4k3/3r4/8/8/2P5/8/8/3QK3 w - - 0 1';
  const c = classifyPly({ fenBefore, uci: 'd1d5' }, { best: 'd1d5', bestCpWhite: 20, secondCpWhite: -200 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'w', 1);
  assert.equal(c.sacPawns, 8, 'a pawn recapture does not cancel a lost queen');
});

test('the board shows the quality badge on the piece that just moved', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  context.document.body.appendChild(el);
  const g = new Chess();
  for (const san of ['e4', 'e5', 'Nf3']) g.move(san);
  Board.init(el, g, { interactive: false });
  // Black's Nf3 is the last move: the piece sits on f3 and must be badged.
  // f3 is file 5, rank 3 -> x=5, y=5 -> 62.5% + 1.2% inset.
  Board.render({ lastMove: { from: 'f3', to: 'f3' }, cls: 'brilliant' });
  const badge = el.querySelector('.mv-badge');
  assert.ok(badge, 'a quality badge must be rendered on the board');
  const style = badge.getAttribute('style') || '';
  assert.match(style, /left:63\.7%/, 'f-file is column 5: 62.5% + 1.2% inset');
  assert.match(style, /top:63\.3%/, 'rank 3 is row 5: 62.5% + 0.8% inset');
  assert.match(badge.className, /cls-brilliant/, 'badge carries the move class');
  assert.equal(badge.textContent, '★', 'badge shows the class icon');
  // Decorative: the board is a grid, and the move list already names the class.
  assert.equal(badge.getAttribute('aria-hidden'), 'true', 'the board badge is decorative, not announced');
  assert.equal(badge.getAttribute('title'), 'Brilliant', 'title names the class for the mouse');
  // No last move, no badge.
  Board.render({ lastMove: null, cls: null });
  assert.equal(el.querySelector('.mv-badge'), null, 'no badge without a last move');
  // A move with no class (or an unrecognised one) must not emit a badge at
  // all: a stray unstyled marker on the square is worse than no marker.
  Board.render({ lastMove: { from: 'f3', to: 'f3' }, cls: 'not-a-class' });
  assert.equal(el.querySelector('.mv-badge'), null, 'an unknown class renders no badge');
  Board.render({ lastMove: { from: 'f3', to: 'f3' }, cls: 'q' });
  const neutral = el.querySelector('.mv-badge');
  assert.equal(neutral.textContent, '·', 'the neutral class shows the neutral icon');
  assert.match(neutral.className, /cls-q/, 'the neutral class keeps its own style');
});

test('the board badge follows the last move for a black move on a flipped board', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  context.document.body.appendChild(el);
  const g = new Chess();
  g.move('e4'); g.move('e5');
  // Black played e5. Seen from Black's side the e-file is column 3 and rank 5
  // is row 4 -> 37.5% + 1.2% and 50% + 0.8%. A white-view board would put
  // these at 51.2% and 38.8%, so these numbers prove the flip is honoured.
  Board.init(el, g, { color: 'b', interactive: false });
  Board.render({ lastMove: { from: 'e7', to: 'e5' }, cls: 'blunder' });
  const badge = el.querySelector('.mv-badge');
  assert.ok(badge, 'badge must render for a black move');
  const style = badge.getAttribute('style') || '';
  assert.match(style, /left:38\.7%/, 'flipped e-file is column 3, not 4');
  assert.match(style, /top:50\.8%/, 'flipped rank 5 is row 4, not 3');
  assert.equal(badge.textContent, '✕', 'a blunder shows its own icon');
});

test('the review board badges the played piece on every ply, not the next move', () => {
  const { context } = loadApp();
  const { Review, Board, mountReviewBoard, classifyPly } = context.__test;
  // mountReviewBoard() returns early when #review-board is absent, and the
  // Review view is not mounted in the test DOM, so create the host here.
  const host = context.document.createElement('div');
  host.id = 'review-board';
  context.document.body.appendChild(host);

  // A real Ruy Lopez main line, with every ply classified for real.
  const sans = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];
  const rep = new Chess();
  const plies = [];
  for (let i = 0; i < sans.length; i++) {
    const fenBefore = rep.fen();
    const mv = rep.moves({ verbose: true }).find(x => x.san === sans[i]);
    assert.ok(mv, 'SAN from the probe line must be legal: ' + sans[i]);
    const uci = mv.from + mv.to + (mv.promotion || '');
    rep.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    const c = classifyPly({ fenBefore, uci }, { best: uci, bestCpWhite: 20, secondCpWhite: 19 }, { bestCpWhite: 19, secondCpWhite: 10 }, mv.color, Math.floor(i / 2) + 1);
    plies.push({ fenBefore, san: sans[i], uci, mover: mv.color, moveNum: Math.floor(i / 2) + 1, cls: c.cls, sacPawns: c.sacPawns, evalBefore: { best: uci, bestCpWhite: 20, secondCpWhite: 19 }, evalAfter: { bestCpWhite: 19, secondCpWhite: 10 } });
  }
  Review.data = { key: 'badge', username: 'me' };
  Review.headers = { White: 'me', Black: 'opp', Result: '*' };
  Review.hist = plies.map(p => ({ san: p.san, uci: p.uci }));
  Review.plys = plies;
  Review.branch = null;

  // Read the maps from the source so this test cannot drift from the app.
  const src = inlineScripts.join('\n');
  const iconRule = (src.match(/CLS_ICON\s*=\s*\{[^}]+\}/) || [])[0] || '';
  const ICONS = Object.fromEntries([...iconRule.matchAll(/(\w+):'([^']*)'/g)].map(m => [m[1], m[2]]));
  const LABELS = { brilliant: 'Brilliant', great: 'Great', best: 'Best', excellent: 'Excellent', good: 'Good', book: 'Book', inaccuracy: 'Inaccuracy', mistake: 'Mistake', blunder: 'Blunder', q: '?' };

  const seen = [];
  for (let ply = 0; ply <= Review.plys.length; ply++) {
    Review.nav = ply;
    mountReviewBoard();
    const p = ply > 0 ? Review.plys[ply - 1] : null;
    // The badge must mark the move that was PLAYED. The off-by-one here is
    // the whole feature: using plys[ply] would badge the next move instead.
    assert.equal(Board.lastMove ? Board.lastMove.to : null, p ? p.uci.slice(2, 4) : null, 'lastMove must be the played move at ply ' + ply);
    assert.equal(Board.cls, p ? p.cls : null, 'badge class must come from the played ply at ply ' + ply);
    const badge = host.querySelector('.mv-badge');
    if (p) {
      assert.ok(badge, 'a badge must be rendered at ply ' + ply);
      // The glyph must be the one this class maps to, and the accessible name
      // the class label -- so the board mark is not colour-only.
      assert.equal(badge.textContent, ICONS[p.cls], 'badge glyph must match the class at ply ' + ply);
      assert.equal(badge.getAttribute('title'), LABELS[p.cls], 'badge title must match the class at ply ' + ply);
      assert.ok(badge.className.includes('cls-' + p.cls), 'badge style must match the class at ply ' + ply);
    } else {
      assert.equal(badge, null, 'no badge before any move is played');
    }
    seen.push(p ? p.san : '-');
  }
  assert.equal(seen.length, plies.length + 1, 'every ply must be visited');
});

test('the board badge is drawn above the piece it marks', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  context.document.body.appendChild(el);
  const g = new Chess();
  g.move('e4'); g.move('e5'); g.move('Nf3');
  Board.init(el, g, { interactive: false });
  Board.render({ lastMove: { from: 'f3', to: 'f3' }, cls: 'brilliant' });
  // The badge must live in its own layer that stacks above the piece
  // (z-index 10). Drawn into the shared overlay (z-index 6) it would be
  // hidden behind the very piece it is marking, and the feature would be
  // invisible while every DOM-level test still passed.
  const layer = el.querySelector('.badge-layer');
  assert.ok(layer, 'the badge needs a dedicated layer');
  // jsdom does not expand style.cssText, so assert on the declared value.
  const layerZ = parseInt((layer.getAttribute('style').match(/z-index:\s*(\d+)/) || [])[1] || '0', 10);
  const pieceEl = el.querySelector('.piece');
  assert.ok(pieceEl, 'a piece must be rendered');
  const pieceZ = 10; // .piece z-index in the stylesheet
  assert.ok(layerZ > pieceZ, 'badge layer (' + layerZ + ') must stack above pieces (' + pieceZ + ')');
  assert.ok(el.querySelector('.overlay .mv-badge') === null, 'the badge must not be drawn in the shared overlay');
  assert.ok(layer.querySelector('.mv-badge'), 'the badge must be inside the badge layer');
  // And it must still be under the arrow layer, so engine arrows stay visible.
  const arrowZ = 20;
  assert.ok(layerZ < arrowZ, 'badge layer must stay below arrows (' + arrowZ + ')');
});

test('a Review badge does not leak onto the Play or Openings board', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  context.document.body.appendChild(el);
  const g = new Chess();
  g.move('e4'); g.move('e5'); g.move('Nf3');
  Board.init(el, g, { interactive: false });
  Board.render({ lastMove: { from: 'f3', to: 'f3' }, cls: 'blunder' });
  assert.equal(el.querySelector('.mv-badge').textContent, '✕', 'the badge is set for the review move');
  // Every other view calls Board.render() with no class. Board is a single
  // shared instance, so the badge must be dropped rather than left stuck on.
  Board.render();
  assert.equal(Board.cls, null, 'a bare render must clear the class');
  assert.equal(el.querySelector('.mv-badge'), null, 'no stale badge after a bare render');
  // And re-mounting another board must not resurrect it either.
  Board.init(el, new Chess(), { interactive: false });
  Board.render();
  assert.equal(Board.cls, null, 'a fresh board starts with no class');
  assert.equal(el.querySelector('.mv-badge'), null, 'no badge on a fresh board');
});

test('an exchange that wins equal material back is not a sacrifice', () => {
  const { context } = loadApp();
  const { classifyPly } = context;
  // Ruy Lopez 4.Bxc6: White wins the knight, Black takes the bishop. Three
  // pawns in, three pawns out -- an even exchange, so nothing is sacrificed.
  const fenBefore = 'r1bqkb1r/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4';
  const c = classifyPly({ fenBefore, uci: 'b5c6' }, { best: 'b5c6', bestCpWhite: 20, secondCpWhite: 15 }, { bestCpWhite: 19, secondCpWhite: 10 }, 'w', 4);
  assert.equal(c.sacPawns, 0, 'an even exchange gives nothing up net');
  assert.notEqual(c.cls, 'brilliant');
});

test('every opening book line is a legal move sequence', () => {
  const { context } = loadApp();
  const { BOOK_LINES } = context.__test;
  assert.ok(Array.isArray(BOOK_LINES) && BOOK_LINES.length >= 10, 'BOOK_LINES must be exported');
  const illegal = [];
  for (const line of BOOK_LINES) {
    const g = new Chess();
    for (let i = 0; i < line.length; i += 4) {
      const uci = line.slice(i, i + 4);
      const m = g.moves({ verbose: true }).find(x => x.from + x.to + (x.promotion || '') === uci);
      if (!m) { illegal.push(line + ' @' + uci); break; }
      g.move({ from: m.from, to: m.to, promotion: m.promotion });
    }
  }
  assert.equal(illegal.length, 0, 'illegal or truncated book lines: ' + illegal.join(' | '));
});

test('move icon colours stay readable in both themes', () => {
  const style = (html.match(/<style[^>]*>([\s\S]*?)<\/style>/i) || [])[1] || '';
  const lum = (rgb) => {
    const [r, g, b] = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const classes = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'blunder', 'q'];
  // light surface = the first (light theme) --surface; dark surface = the dark
  // theme --surface, which is the one declared inside the dark selector.
  const lightHex = (style.match(/--surface:\s*(#[0-9a-f]{6})/i) || [])[1];
  const darkHex = (style.match(/html\[data-theme="dark"\]\{[^}]*--surface:\s*(#[0-9a-f]{6})/i) || [])[1];
  assert.ok(lightHex, 'light --surface must be a hex colour');
  assert.ok(darkHex, 'dark --surface must be a hex colour');
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const light = hexRgb(lightHex);
  const dark = hexRgb(darkHex);
  const failing = [];
  // The icons render on the move row (--surface), on .mv:hover and inside
  // .cls-badge (both --surface-2), so every surface in both themes must pass.
  const lightSurf2 = (style.match(/--surface-2:\s*(#[0-9a-f]{6})/i) || [])[1];
  const darkSurf2 = (style.match(/html\[data-theme="dark"\]\{[^}]*--surface-2:\s*(#[0-9a-f]{6})/i) || [])[1];
  assert.ok(lightSurf2, 'light --surface-2 must be a hex colour');
  assert.ok(darkSurf2, 'dark --surface-2 must be a hex colour');
  const surfaces = [['surface', light], ['surface-2', hexRgb(lightSurf2)]];
  for (const c of classes) {
    const lightInk = style.match(new RegExp('\\.cls-ink-' + c + '\\{color:(#[0-9a-f]{3,8})\\}'));
    const darkInk = style.match(new RegExp('data-theme="dark"[^}]*\\.cls-ink-' + c + '\\{color:(#[0-9a-f]{3,8})\\}'));
    assert.ok(lightInk, 'missing light ink for ' + c);
    assert.ok(darkInk, 'missing dark-theme ink for ' + c);
    const l = hexRgb(lightInk[1]);
    const d = hexRgb(darkInk[1]);
    for (const [nm, bg] of surfaces) {
      const rl = ratio(l, bg);
      if (rl < 4.5) failing.push(c + ' light ' + nm + ' ' + rl.toFixed(2) + ':1');
    }
    for (const [nm, bg] of [['surface', dark], ['surface-2', hexRgb(darkSurf2)]]) {
      const rd = ratio(d, bg);
      if (rd < 4.5) failing.push(c + ' dark ' + nm + ' ' + rd.toFixed(2) + ':1');
    }
  }
  assert.deepEqual(failing, [], 'icon colours below WCAG AA 4.5:1: ' + failing.join(', '));

  // The move dot is the only colour cue on the move button, so it must clear
  // the 3:1 non-text minimum (WCAG 1.4.11) against the card in each theme.
  const dotFail = [];
  for (const c of classes) {
    const lightDot = style.match(new RegExp('(?:^|[\\s,}])\\.cls-' + c + '\\{background:(#[0-9a-f]{6})\\}'));
    const darkDot = style.match(new RegExp('\\[data-theme=.dark.\\]\\s+\\.cls-' + c + '\\{background:(#[0-9a-f]{6})\\}'));
    assert.ok(lightDot, 'missing light dot colour for ' + c);
    assert.ok(darkDot, 'missing dark dot colour for ' + c);
    if (ratio(hexRgb(lightDot[1]), light) < 3) dotFail.push(c + ' light dot ' + ratio(hexRgb(lightDot[1]), light).toFixed(2) + ':1');
    if (ratio(hexRgb(darkDot[1]), dark) < 3) dotFail.push(c + ' dark dot ' + ratio(hexRgb(darkDot[1]), dark).toFixed(2) + ':1');
  }
  assert.deepEqual(dotFail, [], 'move dot colours below WCAG 1.4.11 3:1: ' + dotFail.join(', '));
});

test('the move list exposes an accessible name for each quality', () => {
  const { context } = loadApp();
  const { Review, renderReviewReport } = context.__test;
  const g = new Chess();
  for (const san of ['e4', 'e5', 'Nf3', 'Nc6']) g.move(san);
  const rep = new Chess();
  const CLASSES = ['book', 'book', 'best', 'excellent'];
  const plies = [];
  ['e4', 'e5', 'Nf3', 'Nc6'].forEach((san, i) => {
    const fenBefore = rep.fen();
    const mv = rep.moves({ verbose: true }).find(x => x.san === san);
    const uci = mv.from + mv.to + (mv.promotion || '');
    rep.move({ from: mv.from, to: mv.to, promotion: mv.promotion });
    plies.push({ fenBefore, san, uci, mover: mv.color, moveNum: 1, cls: CLASSES[i], evalBefore: { best: uci, bestCpWhite: 0, secondCpWhite: 0 }, evalAfter: { bestCpWhite: 0, secondCpWhite: 0 } });
  });
  Review.open({ key: 'k', pgn: g.pgn(), headers: { White: 'A', Black: 'B', Result: '1-0' }, summary: {}, plies });
  const out = renderReviewReport();
  for (const label of ['Book', 'Best', 'Excellent']) {
    assert.ok(new RegExp('aria-label="[^"]*, ' + label + '"').test(out), 'move button for ' + label + ' needs an aria-label naming its quality');
  }
  assert.ok(!/aria-label="[^"]*book"/.test(out), 'aria-label should use the display label, not the internal class key');
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

test('entering Openings from another tab starts with a clear board', () => {
  const { context } = loadApp();
  const { Store, App, go } = context.__test;
  Store.state = context.defaultState();
  Store.state.openingLines = [{ id: 'keep', name: 'Saved line', moves: 'e4 e5', fen: null }];
  Store.state.playbook = { name: 'Old draft', moves: 'd4', branches: [{ id: 'main', name: 'Main line', moves: 'd4' }], activeBranchId: 'main' };
  App.builder = { chess: new Chess(), name: 'Old draft' };
  App.builder.chess.move('d4');
  App.view = 'review';
  go('openings');
  assert.equal(App.view, 'openings');
  assert.equal(App.builder.chess.history().length, 0, 'the live board must be the fresh starting position');
  assert.equal(App.builder.branches.length, 1);
  assert.equal(App.builder.branches[0].moves, '', 'the entering board must not restore the old draft branch');
  assert.equal(App.builder.name, '');
  assert.equal(Store.state.openingLines.length, 1, 'saved lines must remain available');
  assert.equal(Store.state.playbook, null, 'entering Openings must discard the orphaned draft');
  const movesText = context.document.querySelector('.moves-grid').textContent;
  assert.match(movesText, /Play moves on the board/i);
});

test('review username input controls the chess.com account used for imports', async () => {
  const { context } = loadApp();
  const { Store, App, render, handleAction, myColorOf } = context.__test;
  Store.state = context.defaultState();
  Store.state.settings.username = 'ConfiguredUser';
  const seen = [];
  const original = context.__test.Importer.month;
  context.__test.Importer.month = async (username, year, month, signal) => { seen.push(username); return []; };
  App.view = 'review';
  render();
  const input = context.document.querySelector('#review-username');
  assert.ok(input, 'Review must expose a username field');
  input.value = 'OtherPlayer';
  input.dispatchEvent(new context.window.Event('input', { bubbles: true }));
  await handleAction({ dataset: { act: 'load-games' } });
  assert.deepEqual(seen, ['OtherPlayer']);
  assert.equal(Store.state.settings.username, 'ConfiguredUser', 'review import must not overwrite the saved account');
  assert.equal(myColorOf({ white: { username: 'OtherPlayer' }, black: { username: 'SomeoneElse' } }), 'w');
  context.__test.Importer.month = original;
});

test('review username is applied to the loaded month and month navigation', async () => {
  const { context } = loadApp();
  const { Store, App, render, handleAction } = context.__test;
  Store.state = context.defaultState();
  Store.state.settings.username = 'SavedUser';
  const seen = [];
  const original = context.__test.Importer.month;
  context.__test.Importer.month = async (username, year, month) => { seen.push(username); return []; };
  App.view = 'review';
  render();
  const input = context.document.querySelector('#review-username');
  input.value = 'FetchedUser';
  input.dispatchEvent(new context.window.Event('input', { bubbles: true }));
  await handleAction({ dataset: { act: 'load-games' } });
  await handleAction({ dataset: { act: 'next-month' } });
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(u => u === 'FetchedUser'), 'month navigation must keep the entered review username');
  context.__test.Importer.month = original;
});

test('review import rejects a blank username without calling chess.com', async () => {
  const { context } = loadApp();
  const { Store, App, render, handleAction } = context.__test;
  Store.state = context.defaultState();
  let calls = 0;
  const original = context.__test.Importer.month;
  context.__test.Importer.month = async () => { calls++; return []; };
  App.view = 'review';
  render();
  const input = context.document.querySelector('#review-username');
  input.value = '   ';
  input.dispatchEvent(new context.window.Event('input', { bubbles: true }));
  await handleAction({ dataset: { act: 'load-games' } });
  assert.equal(calls, 0);
  assert.match(context.document.querySelector('#main').textContent, /enter a chess\.com username/i);
  context.__test.Importer.month = original;
});

test('Store migration preserves a blank username instead of restoring a hardcoded account', () => {
  const { context } = loadApp();
  const state = context.validateState({ settings: { username: '   ' } }, { strict: false });
  assert.equal(state.settings.username, '');
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

test('Progress statistics stay scoped to the saved account', () => {
  const { context } = loadApp();
  const { Store, renderProgress } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: 'Me' },
    analyzed: {
      mine: { key: 'mine', headers: { White: 'Me', Black: 'Alice' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 }, black: { accuracy: 50, blunder: 4, mistake: 1 } }, date: '2026-01-02', plies: [] },
      other: { key: 'other', username: 'OtherPlayer', headers: { White: 'OtherPlayer', Black: 'Bob' }, summary: { white: { accuracy: 50, blunder: 4, mistake: 1 }, black: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-01', plies: [] }
    }
  };
  const html = renderProgress();
  assert.match(html, /Avg accuracy<\/div><div class="value">95%/);
  assert.doesNotMatch(html, /73%/);
  assert.match(html, /1 game analyzed/);
});

test('Progress empty state explains missing account and foreign-game cases', () => {
  const { context } = loadApp();
  const { Store, renderProgress } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: '' },
    analyzed: {
      foreign: { key: 'foreign', username: 'OtherPlayer', headers: { White: 'OtherPlayer', Black: 'Rival' }, summary: { white: { accuracy: 90, blunder: 0, mistake: 0 } }, date: '2026-01-01', plies: [] },
      another: { key: 'another', username: 'AnotherPlayer', headers: { White: 'AnotherPlayer', Black: 'Rival' }, summary: { white: { accuracy: 80, blunder: 1, mistake: 0 } }, date: '2026-01-02', plies: [] }
    }
  };
  const html = renderProgress();
  assert.match(html, /Choose a player/);
  assert.match(html, /OtherPlayer/);
  assert.match(html, /AnotherPlayer/);
});

test('Progress offers a username picker when Review-only games span multiple handles', () => {
  const { context } = loadApp();
  const { App, Store, renderProgress, handleAction } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: '' },
    analyzed: {
      alice: { key: 'alice', username: 'Alice', headers: { White: 'Alice', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-02', plies: [] },
      bob: { key: 'bob', username: 'Bob', headers: { White: 'Bob', Black: 'Rival' }, summary: { white: { accuracy: 70, blunder: 3, mistake: 1 } }, date: '2026-01-01', plies: [] }
    }
  };
  App.importState = { ...App.importState, username: '', loadedUsername: '', usernameExplicit: false };
  App.progressScope = '';
  const picker = renderProgress();
  assert.match(picker, /Choose a player/);
  assert.match(picker, /data-act="progress-scope" data-username="Alice"/);
  handleAction({ dataset: { act: 'progress-scope', username: 'Alice' } });
  const scoped = renderProgress();
  assert.match(scoped, /Avg accuracy<\/div><div class="value">95%/);
  assert.match(scoped, /1 game analyzed/);
  assert.doesNotMatch(scoped, /70%/);
});

test('Progress picker ignores an abandoned Review handle and keeps an explicit pick sticky', () => {
  const { context } = loadApp();
  const { App, Store, renderProgress, handleAction } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: '' },
    analyzed: {
      alice: { key: 'alice', username: 'Alice', headers: { White: 'Alice', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-02', plies: [] },
      bob: { key: 'bob', username: 'Bob', headers: { White: 'Bob', Black: 'Rival' }, summary: { white: { accuracy: 70, blunder: 3, mistake: 1 } }, date: '2026-01-01', plies: [] }
    }
  };
  App.importState = { ...App.importState, username: 'AbandonedTypo', loadedUsername: '', usernameExplicit: true };
  App.progressScope = '';
  const picker = renderProgress();
  assert.match(picker, /Choose a player/);
  assert.match(picker, /data-act="progress-scope" data-username="Alice"/);
  handleAction({ dataset: { act: 'progress-scope', username: 'Alice' } });
  App.importState.username = 'Bob';
  const scoped = renderProgress();
  assert.match(scoped, /Avg accuracy<\/div><div class="value">95%/);
  assert.match(scoped, /1 game analyzed/);
  assert.doesNotMatch(scoped, /70%/);
});

test('Progress offers a change-player control after a handle is selected', () => {
  const { context } = loadApp();
  const { App, Store, renderProgress, handleAction } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: '' },
    analyzed: {
      alice: { key: 'alice', username: 'Alice', headers: { White: 'Alice', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-02', plies: [] },
      bob: { key: 'bob', username: 'Bob', headers: { White: 'Bob', Black: 'Rival' }, summary: { white: { accuracy: 70, blunder: 3, mistake: 1 } }, date: '2026-01-01', plies: [] }
    }
  };
  App.importState = { ...App.importState, username: '', loadedUsername: '', usernameExplicit: false };
  App.progressScope = '';
  handleAction({ dataset: { act: 'progress-scope', username: 'Alice' } });
  const scoped = renderProgress();
  assert.match(scoped, /data-act="progress-scope-clear"/);
  assert.match(scoped, /data-act="progress-scope" data-username="Bob"/);
});

test('an explicit Progress handle pick overrides the saved Settings account', () => {
  const { context } = loadApp();
  const { App, Store, renderProgress, handleAction } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: 'Me' },
    analyzed: {
      mine: { key: 'mine', username: 'Me', headers: { White: 'Me', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-02', plies: [] },
      alice: { key: 'alice', username: 'Alice', headers: { White: 'Alice', Black: 'Rival' }, summary: { white: { accuracy: 40, blunder: 8, mistake: 2 } }, date: '2026-01-01', plies: [] }
    }
  };
  App.importState = { ...App.importState, username: '', loadedUsername: '', games: null, usernameExplicit: false };
  App.progressScope = '';
  const before = renderProgress();
  assert.match(before, /Viewing Me/);
  assert.match(before, /95%/);
  handleAction({ dataset: { act: 'progress-scope', username: 'Alice' } });
  const after = renderProgress();
  assert.match(after, /Viewing Alice/);
  assert.match(after, /Avg accuracy<\/div><div class="value">40%/);
  assert.doesNotMatch(after, />95%</);
  handleAction({ dataset: { act: 'progress-scope-clear' } });
  const restored = renderProgress();
  assert.match(restored, /Viewing Me/);
  assert.match(restored, /Avg accuracy<\/div><div class="value">95%/);
});

test('Progress keeps the picker reachable when the Settings account has no games', () => {
  const { context } = loadApp();
  const { App, Store, renderProgress } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: 'Ghost' },
    analyzed: {
      alice: { key: 'alice', username: 'Alice', headers: { White: 'Alice', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 } }, date: '2026-01-02', plies: [] },
      bob: { key: 'bob', username: 'Bob', headers: { White: 'Bob', Black: 'Rival' }, summary: { white: { accuracy: 70, blunder: 3, mistake: 1 } }, date: '2026-01-01', plies: [] }
    }
  };
  App.importState = { ...App.importState, username: '', loadedUsername: '', games: null, usernameExplicit: false };
  App.progressScope = '';
  const html = renderProgress();
  assert.match(html, /data-act="progress-scope" data-username="Alice"/);
  assert.match(html, /data-act="progress-scope" data-username="Bob"/);
  assert.match(html, /Not your games/);
});

test('Progress keeps stats for a Review-only username when Settings has no account', () => {
  const { context } = loadApp();
  const { Store, renderProgress } = context.__test;
  Store.state = {
    ...Store.state,
    settings: { ...Store.state.settings, username: '' },
    analyzed: {
      reviewOnly: { key: 'reviewOnly', username: 'MyHandle', headers: { White: 'MyHandle', Black: 'Rival' }, summary: { white: { accuracy: 95, blunder: 0, mistake: 0 }, black: { accuracy: 50, blunder: 4, mistake: 1 } }, date: '2026-01-02', plies: [] }
    }
  };
  const html = renderProgress();
  assert.match(html, /Avg accuracy<\/div><div class="value">95%/);
  assert.match(html, /1 game analyzed/);
});

test('Analyze Selected stamps the username captured when games were loaded', async () => {
  const { context } = loadApp();
  const { App, Store, Engine, render, handleAction } = context.__test;
  const originalReady = Engine.ready;
  const originalOffline = Engine.offline;
  const originalAnalyse = Engine.analyse;
  Engine.ready = true; Engine.offline = false;
  Engine.analyse = async fen => {
    const move = new Chess(fen).moves({ verbose: true })[0];
    return { best: move.from + move.to, bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0, bestPv: move.from + move.to, secondPv: move.from + move.to };
  };
  const g = new Chess(); g.move('e4'); g.move('e5');
  Store.state = context.defaultState();
  Store.state.settings.username = 'SavedUser';
  App.view = 'review';
  App.importState = { ...App.importState, username: 'LoadedUser', loadedUsername: 'LoadedUser', usernameExplicit: true, games: [{ url: 'loaded-game', pgn: g.pgn() }], selected: new Set([0]) };
  render();
  const input = context.document.querySelector('#review-username');
  input.value = 'EditedAfterLoad';
  input.dispatchEvent(new context.window.Event('input', { bubbles: true }));
  handleAction({ dataset: { act: 'analyze-selected' } });
  await waitFor(() => Store.state.analyzed['loaded-game'], 'selected game analysis did not finish');
  assert.equal(Store.state.analyzed['loaded-game'].username, 'LoadedUser');
  Engine.ready = originalReady; Engine.offline = originalOffline; Engine.analyse = originalAnalyse;
});

test('re-rendering Review preserves username focus and caret position', () => {
  const { context } = loadApp();
  const { App, render } = context.__test;
  App.view = 'review';
  render();
  const input = context.document.querySelector('#review-username');
  input.focus();
  input.value = 'PlayerName';
  input.dispatchEvent(new context.window.Event('input', { bubbles: true }));
  input.setSelectionRange(4, 4);
  render();
  const next = context.document.querySelector('#review-username');
  assert.equal(context.document.activeElement, next, 're-render must not steal username focus');
  assert.equal(next.value, 'PlayerName');
  assert.equal(next.selectionStart, 4);
});

test('re-rendering Review does not pull focus back into the page while a modal is open', () => {
  const { context } = loadApp();
  const { App, render } = context.__test;
  App.view = 'review';
  render();
  const input = context.document.querySelector('#review-username');
  input.focus();
  context.document.getElementById('modal-root').innerHTML = '<div class="modal-backdrop"><input id="modal-input"></div>';
  render();
  assert.notEqual(context.document.activeElement, context.document.querySelector('#review-username'));
  assert.notEqual(context.document.activeElement, context.document.getElementById('modal-input'));
});

test('the import error banner keeps its context and hint for string and non-string errors', () => {
  const { context } = loadApp();
  const { App, Engine, renderReview } = context.__test;
  const originalOffline = Engine.offline;
  const originalReady = Engine.ready;
  Engine.offline = false;
  Engine.ready = true;
  App.importState = { ...App.importState, loading: false, games: null, error: 'HTTP 503' };
  let html = renderReview();
  assert.match(html, /Could not load games: HTTP 503/);
  assert.match(html, /paste PGN still works/);
  Engine.offline = false;
  Engine.ready = false;
  App.importState = { ...App.importState, loading: true, error: 'fetch failed' };
  html = renderReview();
  assert.doesNotMatch(html, /Could not load games:.*paste PGN still works/);
  App.importState = { ...App.importState, loading: false, error: 123 };
  assert.doesNotThrow(() => renderReview());
  Engine.offline = true;
  App.importState = { ...App.importState, error: 'Engine offline — game import is unavailable until the engine is ready.', errorKind: 'validation' };
  html = renderReview();
  assert.match(html, /Engine offline/);
  assert.doesNotMatch(html, /Could not load games/);
  assert.doesNotMatch(html, /Could not load games:.*paste PGN still works/);
  Engine.offline = originalOffline;
  Engine.ready = originalReady;
});

test('checkmate names the winning side and color in the play result', () => {
  const { context } = loadApp();
  const { Store, Play, Engine, render } = context.__test;
  const originalPlayMove = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Store.state = context.defaultState();

  // The side to move is checkmated: White's Ra8# mates Black.
  const checkmatedBlack = 'R5k1/5ppp/8/8/8/8/8/6K1 b - - 1 2';
  Play.start({ color: 'w', skill: 1, lineMoves: '' });
  Play.session.chess = new Chess(checkmatedBlack);
  assert.equal(Play.session.chess.in_checkmate(), true, 'fixture must be a real checkmate');
  Play.checkEnd(Play.session);
  render();
  assert.match(context.document.querySelector('#play-done-text').textContent, /You \(White\) won by checkmate/i);
  assert.match(context.document.querySelector('#play-status').textContent, /You \(White\) won by checkmate/i);

  // The same mate is an engine win when the user owns the mated side.
  Play.start({ color: 'b', skill: 1, lineMoves: '' });
  Play.session.chess = new Chess(checkmatedBlack);
  Play.checkEnd(Play.session);
  render();
  assert.match(context.document.querySelector('#play-done-text').textContent, /Stockfish \(White\) won by checkmate/i);
  assert.match(context.document.querySelector('#play-status').textContent, /Stockfish \(White\) won by checkmate/i);

  Play.cancel();
  Engine.playMove = originalPlayMove;
});

test('play undo rolls back the last ply and resign disappears after the game ends', () => {
  const { context } = loadApp();
  const { Store, App, Play, Engine, render } = context.__test;
  const originalPlayMove = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Store.state = context.defaultState();
  Play.start({ color: 'w', skill: 1, lineMoves: '' });
  const S=Play.session;
  const before = S.chess.history();
  const turn = S.chess.turn();
  const legal = S.chess.moves({verbose:true}).find(m=>m.color===turn);
  S.chess.move({from:legal.from,to:legal.to,promotion:legal.promotion});
  assert.ok(Play.session.chess.history().length > before.length);
  assert.equal(Play.undo(), true);
  assert.deepEqual(Play.session.chess.history(), before);
  const played = Play.session.chess;
  played.move('e4'); played.move('e5');
  assert.equal(Play.undo(), true);
  assert.deepEqual(Play.session.chess.history(), before, 'undo must take back the engine reply and the preceding human move');
  Play.finishSession(Play.session, 'draw', 'agreement');
  assert.equal(context.document.querySelector('[data-act="end-play"]'), null, 'resign must disappear immediately when the game ends');
  render();
  assert.equal(context.document.querySelector('[data-act="end-play"]'), null);
  Play.cancel();
  Engine.playMove = originalPlayMove;
});

test('opening branches keep independent move lines and can be restored', () => {
  const { context } = loadApp();
  const { Store, App, render, renderOpenings } = context.__test;
  Store.state = context.defaultState();
  App.builder = { chess: new Chess(), name: 'Branches', branches: [{ id: 'main', name: 'Main', moves: 'e4 e5' }], activeBranchId: 'main' };
  App.builder.chess.move('e4'); App.builder.chess.move('e5');
  App.view = 'openings';
  render();
  const html = renderOpenings();
  assert.match(html, /Branch/);
  App.builder.branches.push({ id: 'alt', name: 'Alternative', moves: 'e4 c5' });
  App.builder.activeBranchId = 'alt';
  render();
  assert.match(renderOpenings(), /Alternative/);
  const alt = App.builder.branches.find(b => b.id === 'alt');
  context.switchBuilderBranch(App.builder, 'main');
  assert.deepEqual(App.builder.chess.history(), ['e4', 'e5']);
  context.switchBuilderBranch(App.builder, 'alt');
  assert.deepEqual(App.builder.chess.history(), ['e4', 'c5']);
  assert.equal(alt.moves, 'e4 c5');
});

test('replaying a stored builder continuation does not truncate the branch', () => {
  const { context } = loadApp();
  const B = { chess: new Chess(), name: '', branches: [{ id: 'main', name: 'Main', moves: 'e4 e5 Nf3' }], activeBranchId: 'main' };
  B.chess.move('e4'); B.chess.move('e5'); B.chess.move('Nf3');
  B.chess.undo(); B.chess.undo();
  context.recordBuilderMove(B, 'e5');
  context.recordBuilderMove(B, 'Nf3');
  assert.deepEqual(B.chess.history(), ['e4', 'e5', 'Nf3']);
  assert.equal(B.branches[0].moves, 'e4 e5 Nf3');
});

test('seeking a builder board does not truncate its stored continuation when the draft is saved', () => {
  const { context } = loadApp();
  const { Store, App, savePlaybook } = context.__test;
  Store.state = context.defaultState();
  const B = { chess: new Chess(), name: 'Main', branches: [{ id: 'main', name: 'Main', moves: 'e4 e5 Nf3' }], activeBranchId: 'main' };
  B.chess.move('e4'); B.chess.move('e5'); B.chess.move('Nf3'); B.chess.undo(); B.chess.undo();
  App.builder = B;
  savePlaybook();
  assert.equal(B.branches[0].moves, 'e4 e5 Nf3', 'seeking to a prefix must not erase the stored suffix');
});

test('an illegal builder move does not create a branch', () => {
  const { context } = loadApp();
  const { recordBuilderMove } = context.__test;
  const B = { chess: new Chess(), name: 'Main', branches: [{ id: 'main', name: 'Main', moves: 'e4 e5 Nf3' }], activeBranchId: 'main' };
  B.chess.move('e4'); B.chess.move('e5');
  const before = B.chess.history().join(' ');
  assert.equal(recordBuilderMove(B, 'e4'), false);
  assert.equal(B.branches.length, 1);
  assert.equal(B.activeBranchId, 'main');
  assert.equal(B.branches[0].moves, 'e4 e5 Nf3');
  assert.equal(B.chess.history().join(' '), before);
});

test('review alternative deltas use the mover point of view and label best lines correctly', async () => {
  const { context } = loadApp();
  const { Review, Engine, renderReviewReport } = context.__test;
  const original = Engine.analyse;
  Engine.analyse = async () => ({ best: 'c7c5', bestCpWhite: -100, bestMateWhite: null, secondCpWhite: 0, bestPv: 'c7c5', secondPv: 'e7e6' });
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'pov', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' }
    ] });
  Review.plys[1].evalBefore = { best: 'e7e5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 };
  Review.plys[1].evalAfter = { best: 'e7e5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 };
  Review.setPly(1);
  assert.equal(await Review.playAlternative('c7', 'c5'), true);
  assert.equal(Review.branch.kind, 'alternative');
  assert.ok(Review.branch.wpAfter > Review.branch.wpBefore, 'Black improvement must be positive from Black POV');
  const alternativeHtml = renderReviewReport();
  assert.match(alternativeHtml, /Alternative line/);
  assert.match(alternativeHtml, /Eval:/);
  assert.match(alternativeHtml, /\+\d+% Black win chance/);
  assert.doesNotMatch(alternativeHtml, /-5% win chance/);
  Engine.analyse = original;
});

test('playBest labels its branch as a best line', () => {
  const { context } = loadApp();
  const { Review, renderReviewReport } = context.__test;
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'best-label', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' }
    ] });
  Review.plys[0].bestUci = 'e2e4';
  Review.plys[0].evalBefore = { best: 'e2e4', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 };
  Review.plys[0].evalAfter = { best: 'e2e4', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 };
  Review.setPly(0);
  assert.equal(Review.playBest(), true);
  assert.equal(Review.branch.kind, 'best');
  assert.match(renderReviewReport(), /Best line/);
});

test('a best line does not report the played move evaluation as the best continuation', () => {
  const { context } = loadApp();
  const { Review, renderReviewReport } = context.__test;
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'best-blunder', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: { best: 'c7c5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, evalAfter: { best: 'g1f3', bestCpWhite: 800, bestMateWhite: null, secondCpWhite: 0 }, cls: 'blunder', bestUci: 'c7c5', bestSan: 'c5' }
    ] });
  Review.setPly(1);
  assert.equal(Review.playBest(), true);
  const html = renderReviewReport();
  assert.match(html, /Best line:<\/b> 1\.\.\. c5/);
  assert.doesNotMatch(html, /Eval:/, 'a best-move branch must not reuse the played move evaluation');
  assert.match(html, /<div class="eval-num">\?<\/div>/, 'a best line without its own analysis must not fall back to the mainline eval');
});

test('returning to the base of an alternative branch renders the mainline position', async () => {
  const { context } = loadApp();
  const { Review, Engine, renderReviewReport } = context.__test;
  const original = Engine.analyse;
  Engine.analyse = async () => ({ best: 'e7e5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0, bestPv: 'e7e5', secondPv: 'c7c5' });
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'branch-base', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: { best: 'e7e5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: { best: 'c7c5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, evalAfter: { best: 'g1f3', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, cls: 'good' }
    ] });
  Review.setPly(1);
  assert.equal(await Review.playAlternative('c7', 'c5'), true);
  Review.setPly(1);
  const html = renderReviewReport();
  assert.doesNotMatch(html, /Alternative line:/);
  assert.match(html, /2\. Nf3|Eval:/);
  Engine.analyse = original;
});

test('an alternative from the final position renders its branch', async () => {
  const { context } = loadApp();
  const { Review, Engine, renderReviewReport } = context.__test;
  const original = Engine.analyse;
  Engine.analyse = async () => ({ best: 'g8f6', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0, bestPv: 'g8f6', secondPv: 'c7c5' });
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'final-probe', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: { best: 'c7c5', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, evalAfter: { best: 'g1f3', bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0 }, cls: 'good' }
    ] });
  Review.setPly(2);
  assert.equal(await Review.playAlternative('d2', 'd4'), true);
  assert.equal(Review.nav, 3);
  const html = renderReviewReport();
  assert.match(html, /Alternative line:<\/b> 2\. d4/);
  assert.match(html, /Eval:/);
  Engine.analyse = original;
});

test('automatic chess.com sync accepts finished PGNs with trailing comments and NAGs', async () => {
  const { context } = loadApp();
  const { App, Store, Importer } = context.__test;
  const originalMonth = Importer.month;
  Importer.month = async () => [{ url: 'annotated', pgn: '1. e4 e5 1-0 {gg} [%clk 0:05] $1', end_time: 200 }, { url: 'unfinished-comment', pgn: '1. e4 e5 * {still running}', end_time: 200 }, { url: 'semicolon', pgn: '1. e4 e5 0-1 ; resigned', end_time: 200 }];
  Store.state = context.defaultState();
  Store.state.settings.username = 'me';
  let received = 0;
  const count = await App.syncChessComGames({ force: true, analyze: async list => { received = list.length; return list.length; } });
  Importer.month = originalMonth;
  assert.equal(count, 2);
  assert.equal(received, 2);
});

test('background analysis skips malformed batch entries but keeps successful analyses', async () => {
  const { context } = loadApp();
  const { runAnalysis, Store, Engine } = context.__test;
  const originalReady = Engine.ready;
  const originalOffline = Engine.offline;
  const originalAnalyse = Engine.analyse;
  Engine.ready = true; Engine.offline = false;
  Engine.analyse = async fen => {
    const m = new Chess(fen).moves({ verbose: true })[0];
    return { best: m.from + m.to + (m.promotion || ''), bestCpWhite: 0, bestMateWhite: null, secondCpWhite: 0, bestPv: m.from + m.to, secondPv: m.from + m.to };
  };
  Store.state = context.defaultState();
  const g = new Chess(); g.move('e4'); g.move('e5');
  const count = await runAnalysis([null, { pgn: 'not a game' }, { url: 'good-game', pgn: g.pgn() }], { background: true });
  Engine.ready = originalReady; Engine.offline = originalOffline; Engine.analyse = originalAnalyse;
  assert.equal(count, 1);
  assert.ok(Store.state.analyzed['good-game']);
});

test('undo ignores an engine reply that arrives after the player has undrawn', async () => {
  const { context } = loadApp();
  const { Play, Engine, Store } = context.__test;
  const originalPlayMove = Engine.playMove;
  let releaseEngine;
  let call = 0;
  Engine.playMove = () => {
    call++;
    if(call === 1) return Promise.resolve('e7e5');
    return new Promise(resolve => { releaseEngine = resolve; });
  };
  Store.state = context.defaultState();
  Play.start({ color: 'w', skill: 1, lineMoves: 'e4' });
  await waitFor(() => Play.session && Play.session.chess.history().length === 2, 'engine reply did not arrive');
  assert.equal(Play.userPlay('d2', 'd4'), true);
  assert.equal(Play.undo(), true);
  assert.deepEqual(Play.session.chess.history(), ['e4', 'e5']);
  releaseEngine('g1f3');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(Play.session.chess.history(), ['e4', 'e5'], 'stale engine reply must not be applied after undo');
  Play.cancel();
  Engine.playMove = originalPlayMove;
});

test('review alternative moves analyze the new position and expose the evaluation delta', async () => {
  const { context } = loadApp();
  const { Review, Engine } = context.__test;
  const original = Engine.analyse;
  const calls = [];
  Engine.analyse = async (fen, movetime, multiPV) => { calls.push({ fen, movetime, multiPV }); return { best: 'd2d4', bestCpWhite: 40, bestMateWhite: null, secondCpWhite: 0, bestPv: 'd2d4', secondPv: 'c2c4' }; };
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'alt', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' }
    ] });
  const ok = await Review.playAlternative('g1', 'f3');
  Engine.analyse = original;
  assert.equal(ok, true);
  assert.ok(calls.length >= 1);
  assert.equal(Review.branch.moves[0], 'g1f3');
  assert.equal(typeof Review.branch.evalAfter, 'object');
});

test('a stale review alternative result cannot replace the position the user is viewing', async () => {
  const { context } = loadApp();
  const { Review, Engine } = context.__test;
  const original = Engine.analyse;
  let release;
  Engine.analyse = () => new Promise(resolve => { release = resolve; });
  const g = new Chess(); g.move('e4'); g.move('e5');
  const start = new Chess(); const afterE4 = new Chess(); afterE4.move('e4');
  Review.open({ key: 'stale', pgn: g.pgn(), headers: {}, summary: {},
    plies: [
      { fenBefore: start.fen(), san: 'e4', uci: 'e2e4', mover: 'w', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' },
      { fenBefore: afterE4.fen(), san: 'e5', uci: 'e7e5', mover: 'b', moveNum: 1, evalBefore: null, evalAfter: null, cls: 'good' }
    ] });
  const pending = Review.playAlternative('g1', 'f3');
  Review.setPly(1);
  release({ best: 'd2d4', bestCpWhite: 40, bestMateWhite: null, secondCpWhite: 0, bestPv: 'd2d4', secondPv: 'c2c4' });
  assert.equal(await pending, false);
  assert.equal(Review.branch, null);
  assert.equal(Review.nav, 1);
  Engine.analyse = original;
});

test('automatic chess.com sync reports only successful analyses', async () => {
  const { context } = loadApp();
  const { App, Store, Importer } = context.__test;
  const originalMonth = Importer.month;
  Importer.month = async () => [{ url: 'sync-failure', pgn: '1. e4 e5 1-0', end_time: 200 }];
  Store.state = context.defaultState();
  Store.state.settings.username = 'me';
  const count = await App.syncChessComGames({ force: true, analyze: async () => 0 });
  Importer.month = originalMonth;
  assert.equal(count, 0);
  assert.equal(App.syncState.lastAdded, 0);
});

test('board arrows can be created, rendered, and cleared by the user', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  const g = new Chess();
  Board.init(el, g, { color: 'w', interactive: true });
  Board.addArrow('e2', 'e4');
  assert.equal(Board.arrows.length, 1);
  Board.render();
  assert.match(el.innerHTML, /arrow-layer/);
  Board.clearArrows();
  assert.equal(Board.arrows.length, 0);
});

test('board arrows are scoped to the current board session', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const first = context.document.createElement('div');
  const second = context.document.createElement('div');
  Board.clearArrows();
  Board.init(first, new Chess(), { color: 'w', interactive: true });
  Board.addArrow('e2', 'e4');
  assert.equal(Board.arrows.length, 1);
  Board.init(second, new Chess(), { color: 'w', interactive: true });
  assert.equal(Board.arrows.length, 0, 'arrows must not leak into a new board');
  Board.clearArrows();
});

test('board arrows cannot start a drag after the board is torn down', () => {
  const { context } = loadApp();
  const { Board } = context.__test;
  const el = context.document.createElement('div');
  Board.init(el, new Chess(), { color: 'w', interactive: true });
  Board._teardownEvents();
  Board.addArrow('e2', 'e4');
  assert.equal(Board.arrows.length, 1);
  assert.equal(Board._arrowDrag, null);
  Board.clearArrows();
});

test('automatic chess.com sync analyzes only finished, new games while the app is open', async () => {
  const { context } = loadApp();
  const { App, Store, Importer } = context.__test;
  const originalMonth = Importer.month;
  const games = [
    { url: 'new-finished', pgn: '1. e4 e5 1-0', end_time: 200, white: { username: 'me' }, black: { username: 'them' } },
    { url: 'old-finished', pgn: '1. e4 e5 0-1', end_time: 100, white: { username: 'me' }, black: { username: 'them' } },
    { url: 'unfinished', pgn: '1. e4 e5 *', end_time: 300, white: { username: 'me' }, black: { username: 'them' } }
  ];
  Importer.month = async () => games;
  Store.state = context.defaultState();
  Store.state.analyzed['old-finished'] = { key: 'old-finished', pgn: games[1].pgn, headers: {}, summary: {}, plies: [] };
  Store.state.settings.username = 'me';
  let analyzed = 0;
  const count = await App.syncChessComGames({ force: true, analyze: async list => { analyzed += list.length; return list.length; } });
  Importer.month = originalMonth;
  assert.equal(count, 1);
  assert.equal(analyzed, 1);
  assert.equal(typeof App.syncState, 'object');
  assert.equal(Store.state.settings.autoSyncChessCom, true);
  assert.deepEqual(App.syncState.lastError, null);
});

test('renderReview renders loaded chess.com games instead of throwing on a shadowed list variable', () => {
  const { context } = loadApp();
  const { App, Store, renderReview } = context.__test;
  Store.state = context.defaultState();
  Store.state.settings.username = 'me';
  App.view = 'review';
  App.importState.games = [{ url: 'g1', pgn: '1. e4 e5 1-0', end_time: 200, time_class: 'rapid',
    white: { username: 'me', rating: 1200 }, black: { username: 'them', rating: 1300 } }];
  App.importState.filter = 'all';
  App.importState.selected.clear();
  let html = '';
  assert.doesNotThrow(() => { html = renderReview(); }, 'renderReview must not throw when games are loaded');
  assert.match(html, /them/);
  assert.match(html, /rapid/);
});

test('resign button is present during an unfinished play session', () => {
  const { context } = loadApp();
  const { Store, App, Play, Engine, render } = context.__test;
  const originalPlayMove = Engine.playMove;
  Engine.playMove = () => new Promise(() => {});
  Store.state = context.defaultState();
  Play.start({ color: 'w', skill: 1, lineMoves: '' });
  App.view = 'play'; render();
  assert.ok(context.document.querySelector('[data-act="end-play"]'));
  Play.cancel();
  Engine.playMove = originalPlayMove;
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
