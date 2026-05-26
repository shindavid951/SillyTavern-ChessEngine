# SillyTavern Chess Engine Extension ♟

Integrate a real chess engine into any SillyTavern chat. Instead of asking the
LLM to play chess (which it does poorly), a proper engine (minimax + α-β
pruning with piece-square tables) makes every move for the character. The LLM
just narrates — it receives the board state and the engine's chosen move as
context and weaves them into the story naturally.

---

## Features

- **Real AI opponent** – minimax engine with 4 difficulty levels (random → depth-3).
- **Board rendered in chat** – a Unicode chess board appears at the bottom of every AI message.
- **Move detection in your messages** – no special command needed; just include your move naturally:
  - `"I push my pawn from E2 to E4"` → detected as E2→E4
  - `"e2-e4"` or `"e2e4"` → coordinate notation
  - Standard Algebraic Notation (`"e4"`, `"Nf3"`, `"O-O"`) tried as a fallback
- **Last-move highlighting** – the squares involved in both your move and the engine's reply are highlighted.
- **Per-chat persistence** – the game state is saved in chat metadata and survives page reloads.
- **Board flippable** – play as White or Black.
- **No server plugin required** – runs entirely in the browser; chess.js loaded from CDN.

---

## Installation

### Option A — Manual (recommended for development)

1. Clone or download this repository into:
   ```
   SillyTavern/public/scripts/extensions/third-party/SillyTavern-ChessEngine/
   ```
2. Restart SillyTavern (or press *Reload Extensions* in the Extensions menu).

### Option B — From the Extensions menu

Use *Install extension from URL* and paste:
```
https://github.com/your/SillyTavern-ChessEngine
```

> **Requires internet access on first load** — chess.js (~100 KB) is fetched from
> `cdn.jsdelivr.net` the first time the extension activates.  Subsequent page
> loads use the browser cache.

---

## Usage

### 1. Start a game

Type `/chess new` in the chat input, or click **▶ New Game** in the extension's
settings panel (Extensions → Chess Engine).

### 2. Make your move

Include your move anywhere in your message.  The extension scans the text and
applies the first valid move it finds.  Examples:

| What you type                           | Detected move |
|-----------------------------------------|---------------|
| `I move my pawn from e2 to e4.`         | e2 → e4       |
| `e2-e4`                                 | e2 → e4       |
| `e2e4`                                  | e2 → e4       |
| `Nf3` (SAN fallback)                    | g1 → f3       |
| `I castle kingside — O-O`               | O-O           |

If no valid move is found in your message the message is still sent normally
(the game state is unchanged).

### 3. Watch the story unfold

The engine instantly calculates and applies Black's response.  The LLM receives
a hidden system note describing the board and the engine's chosen move, then
narrates accordingly.  The board renders at the bottom of the reply.

### Slash commands

| Command        | Effect                                   |
|----------------|------------------------------------------|
| `/chess new`   | Start a fresh game (you play White)      |
| `/chess flip`  | Switch between playing White and Black   |
| `/chess fen`   | Print the current FEN to a toast         |
| `/chess board` | Redraw the board on the last AI message  |
| `/chess stop`  | End and clear the current game           |

---

## Settings panel

Open **Extensions → Chess Engine** to configure:

| Setting              | Description                                              |
|----------------------|----------------------------------------------------------|
| Enable Chess Engine  | Toggle the extension on/off                              |
| Show board in chat   | Hide/show the board renders                              |
| Auto-detect moves    | Turn off if you prefer to drive moves via slash commands |
| Engine strength      | 1 (random) → 4 (depth-3 minimax)                        |
| You play as          | White (default, moves first) or Black                    |

---

## Technical notes

- **chess.js** (`v1.4.0`) handles move validation, FEN serialisation, check/
  checkmate/draw detection, and SAN parsing.  Loaded from
  `https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm`.
- The **AI engine** is a plain minimax search with α-β pruning and classic
  piece-square tables.  It is entirely synchronous and runs on the main thread;
  depth-3 typically takes < 200 ms in a modern browser.
- Game state is stored in `chatMetadata.chess_engine` (FEN + history + last
  move strings) and saved via ST's `saveMetadata()`.
- The `generate_interceptor` (registered in `manifest.json`) injects a hidden
  system note into the prompt before every LLM generation while a game is
  active.  The note describes the position and the engine's chosen move so the
  character can narrate it.
- Pawn promotion always promotes to Queen automatically.

---

## License

MIT
