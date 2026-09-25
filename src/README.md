# Source layout

`index.html` remains the shipped offline application so ChessLab works from a local file without a build step or server.

The `src/` files document the intended module boundaries:

- `store.js` — state, migration, validation, and persistence
- `engine.js` — Stockfish worker lifecycle and queue
- `analysis.js` — PGN/FEN replay, evaluation, and classification
- `board.js` — board rendering and keyboard interaction
- `play.js` — play-session lifecycle
- `review.js` — review navigation and best-line branches
- `openings.js` — opening builder and saved lines
- `progress.js` — progress summaries
- `settings.js` — settings and data controls
- `app.js` — composition, navigation, and boot

They are intentionally dependency-free boundary markers rather than a second runtime: the current release keeps the tested inline implementation intact while making the extraction seams explicit. The next structural refactor can move each block without changing the public browser contract.
