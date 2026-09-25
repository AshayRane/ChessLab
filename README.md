# ChessLab

ChessLab is a local-first chess opening trainer and game-review app. It runs as a single browser application, needs no build step, and keeps your chess data in your browser.

**Current release:** `v2.6.1`

---

## What ChessLab does

- **Play** — play a game against Stockfish with a chosen color and skill level.
- **Openings** — build a line by playing moves for both sides, save it, and practise from where the line ends.
- **Review** — import or paste a PGN, analyse it, and step through evaluations, best moves, and classifications.
- **Progress** — see summaries of analysed games and saved practice records.
- **Settings** — change the theme, username, review depth, engine strength, and data.

ChessLab also supports:

- Opening lines saved in the browser
- Practice from a custom line or start position
- Keyboard board navigation
- JSON export and import
- Strict validation of imported and persisted data
- An offline-friendly application shell with self-hosted `chess.js`

---

## Quick start

### Run the app

1. Download or clone this repository.
2. Open `index.html` in a modern browser.
3. Start playing in the **Play** tab.

There is no build step and no application server required for normal use.

### Optional: run the checks

You need Node.js for the test and syntax commands. Node.js 22 or newer is recommended.

```bash
npm install
npm run check
npm test
```

`npm run check` validates the inline application scripts and the checked-in `src/` files. `npm test` runs the Node/jsdom regression suite.

You can also run:

```bash
npm audit --audit-level=high
```

---

## Using the app

### 1. Play a game

Open **Play**, choose **White** or **Black**, choose an engine strength, and select **Start Game**.

The board direction is only a visual setting. Flipping the board does not change which color you own.

### 2. Practise an opening

Open **Openings** and play the moves you want to study. You can enter moves for both sides.

When you select **Practice from here** or **Practice** on a saved line:

- The last move in the line determines your color.
- The engine receives the opposite color, which is the side to move next.
- A line ending on White gives you White and gives the engine Black.
- A line ending on Black gives you Black and gives the engine White.

This makes the line itself the source of truth instead of requiring a separate color choice.

### 3. Review a game

Use **Review** to load games from a public chess.com account or paste a PGN. Analysis requires the Stockfish engine to be available.

### 4. Back up your data

Use **Settings → Export** to download a JSON backup. Use **Import** to restore a previously exported file.

---

## Architecture

The project is intentionally small and easy to run locally.

```text
Browser UI
   ↓
Board + event handling
   ↓
App state and chess rules
   ↓
Stockfish worker / analysis pipeline
   ↓
localStorage + exported JSON
```

### Main responsibilities

| Area | Responsibility |
| --- | --- |
| `index.html` | Shipped browser application, markup, styles, and the tested inline runtime |
| `chess.js` | Self-hosted chess rules and move generation |
| `Store` | Versioned state, migration, validation, and `localStorage` persistence |
| `Board` | Piece rendering, selection, dragging, overlays, and keyboard focus |
| `Play` | Live game sessions, player/engine colors, turns, and results |
| `Engine` | Stockfish Worker lifecycle, UCI parsing, serial queue, and fallback sources |
| Analysis | PGN/FEN replay, evaluations, best moves, and move classifications |
| `Review` | Analysed-game navigation and best-line branches |
| `App` and `render()` | Navigation, view selection, and event wiring |
| `Importer` | Optional chess.com game retrieval |

### Beginner diagram

Open [`chesslab-architecture.html`](chesslab-architecture.html) for an interactive HTML5 Canvas diagram. It has three views:

- **Beginner** — a plain-English overview
- **Intermediate** — the main runtime layers
- **Advanced** — live-game and review data flows, safety rails, and state contracts

You can switch views in the diagram and download the current view as a PNG.

---

## Project layout

```text
.
├── index.html                  # Main shipped app
├── chess.js                    # Self-hosted chess rules
├── chesslab-architecture.html  # Interactive Canvas architecture map
├── package.json                # Development and test commands
├── package-lock.json
├── scripts/
│   └── check-syntax.js
├── src/                        # Intended future module boundaries
├── tests/
│   └── regression.test.js
└── v1-backup.html              # Older backup kept for reference
```

### About `src/`

The files in `src/` document logical module boundaries:

- `store.js`
- `engine.js`
- `analysis.js`
- `board.js`
- `play.js`
- `review.js`
- `openings.js`
- `progress.js`
- `settings.js`
- `app.js`

They are not currently a second runtime. The shipped browser app still executes the tested inline implementation in `index.html`. The files make future extraction safer without changing the current browser contract.

---

## Data and privacy

ChessLab has no backend or account database. The main data is stored under the browser `localStorage` key `chesslab.v1`, including:

- Settings
- Saved opening lines
- Analysed games
- The current opening practice draft
- Recent practice games

Optional chess.com import uses public game data over the network. ChessLab does not need an API key for the core app. Do not put passwords, tokens, or other secrets into exported JSON files or source code.

Use **Settings → Clear all data** to remove the local data, or delete site data from your browser.

---

## Engine and offline behaviour

The application shell, board, opening builder, and saved data work locally. Stockfish is loaded as a Web Worker when engine functionality is needed. The engine has multiple source fallbacks and an offline status state.

If the engine cannot load:

- Opening practice can still be used.
- PGN analysis is unavailable until the engine is ready.
- Play uses a safe local fallback when a legal move is available.

---

## Troubleshooting

### The page looks like an older version

Check the version badge in the header. If it does not show `v2.6.1`, use a hard refresh:

- Windows: `Ctrl + Shift + R`
- macOS: `Cmd + Shift + R`

### The engine is offline

Check the Engine status chip in the header and try again after the network is available. Opening practice and the local builder do not require the engine.

### A saved line is not visible

Open **Openings** and make sure the line was saved. If the browser site data was cleared, local opening lines and analysed games will also be gone; export backups regularly.

### A move does not work

Confirm that it is your turn. The player color, current chess turn, and visual board direction are separate pieces of state. Flipping the board does not give you the other side.

---

## Releases

- `v2.6` — hardening pass and explicit module seams
- `v2.6.1` — opening side handoff, stricter analysis validation, Engine fallback improvements, and accessibility fixes

Each release is tagged in Git so a known-good version can be recovered.

---

## Contributing

Small, focused changes are welcome. Before submitting a change:

```bash
npm run check
npm test
```

Keep the app usable from a local file, preserve the separation between player ownership, board orientation, and chess turn, and avoid introducing external runtime dependencies without explaining them.
