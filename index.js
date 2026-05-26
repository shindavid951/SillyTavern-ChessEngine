import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

/**
 * SillyTavern Chess Engine Extension
 *
 * Integrates a JS chess engine into any chat.  The user plays White (or Black)
 * by embedding moves in their messages; the engine plays the other side.
 * The board is displayed at the bottom of every AI message.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module identity & chess-piece glyphs
// ─────────────────────────────────────────────────────────────────────────────
const MODULE_NAME = 'chess_engine';

/** chess.js Chess class – loaded lazily from CDN */
let Chess = null;

const GLYPHS = {
    wK: '♔', wQ: '♕', wR: '♖', wB: '♗', wN: '♘', wP: '♙',
    bK: '♚', bQ: '♛', bR: '♜', bB: '♝', bN: '♞', bP: '♟',
};

const PIECE_NAMES = { p: 'Pawn', n: 'Knight', b: 'Bishop', r: 'Rook', q: 'Queen', k: 'King' };

// ─────────────────────────────────────────────────────────────────────────────
// Resignation & trigger-phrase patterns
// ─────────────────────────────────────────────────────────────────────────────

const USER_RESIGN_PATTERNS = [
    /\bI\s+resign\b/i,
    /\bI\s+concede\b/i,
    /\bI\s+forfeit\b/i,
    /\bI\s+surrender\b/i,
    /\bI\s+give\s+up\b/i,
    /\bI\s+quit\s+(?:the\s+)?(?:game|chess|match)\b/i,
    /\byou\s+win\s*[.!]/i,
];

const CHAR_RESIGN_PATTERNS = [
    /\[RESIGN\]/i,
    /\bI\s+resign\b/i,
    /\bI\s+concede\s+(?:defeat|the\s+game|this\s+match)?\b/i,
    /\bI\s+forfeit\b/i,
    /\bI\s+surrender\b/i,
];

function containsUserResignation(text) {
    return USER_RESIGN_PATTERNS.some(p => p.test(text));
}

function containsCharResignation(text) {
    return CHAR_RESIGN_PATTERNS.some(p => p.test(text));
}

function matchesTriggerPhrase(text) {
    const settings = getSettings();
    if (!settings.triggerPhraseEnabled) return false;
    const phrase = (settings.triggerPhrase || "let's play chess").trim().toLowerCase();
    return text.toLowerCase().includes(phrase);
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = Object.freeze({
    enabled:              true,
    showBoard:            true,
    autoDetectMoves:      true,
    aiLevel:              2,          
    playerColor:          'w',        
    triggerPhraseEnabled: true,
    triggerPhrase:        "let's play chess",
});

function getSettings() {
    const { extensionSettings } = getContext();
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = DEFAULT_SETTINGS[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat metadata (per-chat persistence)
// ─────────────────────────────────────────────────────────────────────────────
function getGameState() {
    const { chatMetadata } = getContext();
    return chatMetadata?.chess_engine ?? null;
}

async function saveGameState({
    fen, history, lastMoveWhite, lastMoveBlack,
    gameOver = false, gameOverReason = '', narratedEnding = false,
}) {
    const { chatMetadata, saveMetadata } = getContext();
    chatMetadata.chess_engine = {
        fen, history, lastMoveWhite, lastMoveBlack,
        gameOver, gameOverReason, narratedEnding,
    };
    await saveMetadata();
}

async function clearGameState() {
    const { chatMetadata, saveMetadata } = getContext();
    delete chatMetadata.chess_engine;
    await saveMetadata();
}

// ─────────────────────────────────────────────────────────────────────────────
// chess.js loader
// ─────────────────────────────────────────────────────────────────────────────
async function loadChessJs() {
    if (Chess) return true;
    try {
        const mod = await import('https://cdn.jsdelivr.net/npm/chess.js@1.4.0/+esm');
        Chess = mod.Chess;
        console.log(`[${MODULE_NAME}] chess.js loaded`);
        return true;
    } catch (e) {
        console.error(`[${MODULE_NAME}] Failed to load chess.js:`, e);
        toastr.error('Chess Engine: could not load chess.js from CDN.');
        return false;
    }
}

function makeGame(fen) {
    if (!Chess) return null;
    try { return fen ? new Chess(fen) : new Chess(); }
    catch (_) { return new Chess(); }
}

function loadCurrentGame() {
    const state = getGameState();
    return state ? makeGame(state.fen) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI engine  (minimax + alpha-beta pruning, piece-square tables)
// ─────────────────────────────────────────────────────────────────────────────
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };

const PST = {
    p: [
         0,  0,  0,  0,  0,  0,  0,  0,
        50, 50, 50, 50, 50, 50, 50, 50,
        10, 10, 20, 30, 30, 20, 10, 10,
         5,  5, 10, 25, 25, 10,  5,  5,
         0,  0,  0, 20, 20,  0,  0,  0,
         5, -5,-10,  0,  0,-10, -5,  5,
         5, 10, 10,-20,-20, 10, 10,  5,
         0,  0,  0,  0,  0,  0,  0,  0,
    ],
    n: [
        -50,-40,-30,-30,-30,-30,-40,-50,
        -40,-20,  0,  0,  0,  0,-20,-40,
        -30,  0, 10, 15, 15, 10,  0,-30,
        -30,  5, 15, 20, 20, 15,  5,-30,
        -30,  0, 15, 20, 20, 15,  0,-30,
        -30,  5, 10, 15, 15, 10,  5,-30,
        -40,-20,  0,  5,  5,  0,-20,-40,
        -50,-40,-30,-30,-30,-30,-40,-50,
    ],
    b: [
        -20,-10,-10,-10,-10,-10,-10,-20,
        -10,  0,  0,  0,  0,  0,  0,-10,
        -10,  0,  5, 10, 10,  5,  0,-10,
        -10,  5,  5, 10, 10,  5,  5,-10,
        -10,  0, 10, 10, 10, 10,  0,-10,
        -10, 10, 10, 10, 10, 10, 10,-10,
        -10,  5,  0,  0,  0,  0,  5,-10,
        -20,-10,-10,-10,-10,-10,-10,-20,
    ],
    r: [
         0,  0,  0,  0,  0,  0,  0,  0,
         5, 10, 10, 10, 10, 10, 10,  5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
        -5,  0,  0,  0,  0,  0,  0, -5,
         0,  0,  0,  5,  5,  0,  0,  0,
    ],
    q: [
        -20,-10,-10, -5, -5,-10,-10,-20,
        -10,  0,  0,  0,  0,  0,  0,-10,
        -10,  0,  5,  5,  5,  5,  0,-10,
         -5,  0,  5,  5,  5,  5,  0, -5,
          0,  0,  5,  5,  5,  5,  0, -5,
        -10,  5,  5,  5,  5,  5,  0,-10,
        -10,  0,  5,  0,  0,  0,  0,-10,
        -20,-10,-10, -5, -5,-10,-10,-20,
    ],
    k: [
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -30,-40,-40,-50,-50,-40,-40,-30,
        -20,-30,-30,-40,-40,-30,-30,-20,
        -10,-20,-20,-20,-20,-20,-20,-10,
         20, 20,  0,  0,  0,  0, 20, 20,
         20, 30, 10,  0,  0, 10, 30, 20,
    ],
};

function sqToIdx(sq) {
    const file = sq.charCodeAt(0) - 97;
    const rank = parseInt(sq[1]) - 1;
    return (7 - rank) * 8 + file;
}

function evalBoard(game) {
    if (game.isCheckmate()) return game.turn() === 'w' ? -99999 : 99999;
    if (game.isDraw() || game.isStalemate() || game.isInsufficientMaterial()) return 0;

    let score = 0;
    for (const row of game.board()) {
        for (const piece of row) {
            if (!piece) continue;
            const idx    = sqToIdx(piece.square);
            const pstIdx = piece.color === 'w' ? idx : 63 - idx;
            const val    = PIECE_VALUES[piece.type] + (PST[piece.type]?.[pstIdx] ?? 0);
            score += piece.color === 'w' ? val : -val;
        }
    }
    return score;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

function minimax(game, depth, alpha, beta, maximising) {
    if (depth === 0 || game.isGameOver()) return evalBoard(game);
    const moves = game.moves();
    shuffle(moves);
    if (maximising) {
        let best = -Infinity;
        for (const m of moves) {
            game.move(m);
            best  = Math.max(best, minimax(game, depth - 1, alpha, beta, false));
            game.undo();
            alpha = Math.max(alpha, best);
            if (beta <= alpha) break;
        }
        return best;
    } else {
        let best = Infinity;
        for (const m of moves) {
            game.move(m);
            best = Math.min(best, minimax(game, depth - 1, alpha, beta, true));
            game.undo();
            beta = Math.min(beta, best);
            if (beta <= alpha) break;
        }
        return best;
    }
}

function getBestMove(game, aiLevel) {
    const moves = game.moves();
    if (!moves.length) return null;
    shuffle(moves);
    if (aiLevel <= 1) return moves[0];

    const depth  = aiLevel - 1;
    const isMax  = game.turn() === 'w';
    let bestMove = moves[0];
    let bestEval = isMax ? -Infinity : Infinity;

    for (const m of moves) {
        game.move(m);
        const ev = minimax(game, depth - 1, -Infinity, Infinity, !isMax);
        game.undo();
        if (isMax ? ev > bestEval : ev < bestEval) {
            bestEval = ev;
            bestMove = m;
        }
    }
    return bestMove;
}

// ─────────────────────────────────────────────────────────────────────────────
// Move parsing
// ─────────────────────────────────────────────────────────────────────────────
function parseCoordMove(text) {
    let m = text.match(/\b([a-h][1-8])\s+to\s+([a-h][1-8])\b/i);
    if (m) return { from: m[1].toLowerCase(), to: m[2].toLowerCase() };

    m = text.match(/\b([a-h][1-8])-([a-h][1-8])\b/i);
    if (m) return { from: m[1].toLowerCase(), to: m[2].toLowerCase() };

    m = text.match(/(?<![a-z\d])([a-h][1-8])([a-h][1-8])(?![a-z\d])/i);
    if (m) return { from: m[1].toLowerCase(), to: m[2].toLowerCase() };

    return null;
}

function applyUserMove(game, text) {
    const coord = parseCoordMove(text);
    if (coord) {
        try {
            const r = game.move({ from: coord.from, to: coord.to, promotion: 'q' });
            if (r) return r;
        } catch (_) { }
    }

    const sanTokens = text.match(
        /\b([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|O-O(?:-O)?)\b/g,
    ) || [];
    for (const san of sanTokens) {
        try {
            const r = game.move(san);
            if (r) return r;
        } catch (_) { }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Game-over helpers
// ─────────────────────────────────────────────────────────────────────────────
function naturalGameOverReason(game, playerColor) {
    if (game.isCheckmate()) {
        const winner = game.turn() === 'w' ? 'Black' : 'White';
        return `Checkmate — ${winner} wins`;
    }
    if (game.isStalemate())            return 'Draw by stalemate';
    if (game.isInsufficientMaterial()) return 'Draw — insufficient material';
    if (game.isThreefoldRepetition())  return 'Draw by threefold repetition';
    if (game.isDraw())                 return 'Draw';
    return 'Game over';
}

async function endGame(reason, game, existingState) {
    const state = existingState ?? getGameState();
    if (!state) return;

    await saveGameState({
        fen:            state.fen,
        history:        state.history ?? [],
        lastMoveWhite:  state.lastMoveWhite ?? null,
        lastMoveBlack:  state.lastMoveBlack ?? null,
        gameOver:       true,
        gameOverReason: reason,
        narratedEnding: false,   
    });
    console.log(`[${MODULE_NAME}] Game ended: ${reason}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Board renderer
// ─────────────────────────────────────────────────────────────────────────────
function gameStatus(game, overrideReason) {
    if (overrideReason)              return overrideReason;
    if (game.isCheckmate())          return game.turn() === 'w' ? '⚑ Black wins by checkmate!' : '⚑ White wins by checkmate!';
    if (game.isStalemate())          return '½-½ Stalemate';
    if (game.isInsufficientMaterial()) return '½-½ Insufficient material';
    if (game.isThreefoldRepetition()) return '½-½ Threefold repetition';
    if (game.isDraw())               return '½-½ Draw';
    if (game.isCheck())              return game.turn() === 'w' ? '⚠ White is in check' : '⚠ Black is in check';
    return game.turn() === 'w' ? 'White to move' : 'Black to move';
}

function renderBoardHtml(game, state, playerColor) {
    const board = game.board();
    const fromSq = state?.lastMoveWhite ? state.lastMoveWhite.split('→')[0] : null;
    const toSqW  = state?.lastMoveWhite ? state.lastMoveWhite.split('→')[1] : null;
    const toSqB  = state?.lastMoveBlack ? state.lastMoveBlack.split('→')[1] : null;

    const flipBoard = playerColor === 'b';
    const rankOrder = flipBoard ? [0,1,2,3,4,5,6,7] : [7,6,5,4,3,2,1,0];
    const fileOrder = flipBoard ? [7,6,5,4,3,2,1,0] : [0,1,2,3,4,5,6,7];

    const isOver = state?.gameOver ?? false;
    const statusText = gameStatus(game, isOver ? state.gameOverReason : null);

    let html = `<div class="ce-wrapper${isOver ? ' ce-game-over' : ''}" data-fen="${game.fen()}">`;

    html += `<div class="ce-statusbar">`;
    html += `<span class="ce-status">${statusText}</span>`;
    if (state?.lastMoveWhite || state?.lastMoveBlack) {
        html += `<span class="ce-moves">`;
        if (state?.lastMoveWhite)
            html += `<span class="ce-move-w" title="White's move">♙ ${state.lastMoveWhite.replace('→',' → ')}</span>`;
        if (state?.lastMoveBlack)
            html += `<span class="ce-move-b" title="Black's move">♟ ${state.lastMoveBlack.replace('→',' → ')}</span>`;
        html += `</span>`;
    }
    html += `</div>`;

    html += `<div class="ce-board">`;

    for (const rIdx of rankOrder) {
        const rankNum = rIdx + 1;
        html += `<div class="ce-row">`;
        html += `<div class="ce-label ce-rank-label">${rankNum}</div>`;

        for (const fIdx of fileOrder) {
            const piece   = board[7 - rIdx][fIdx];
            const sqName  = String.fromCharCode(97 + fIdx) + rankNum;
            const light   = (rIdx + fIdx) % 2 === 0;
            const isFrom  = sqName === fromSq;
            const isToW   = sqName === toSqW;
            const isToB   = sqName === toSqB;

            let cellClass = `ce-cell ${light ? 'ce-light' : 'ce-dark'}`;
            if (isFrom) cellClass += ' ce-from';
            if (isToW)  cellClass += ' ce-to-w';
            if (isToB)  cellClass += ' ce-to-b';

            let inner = '';
            if (piece) {
                const glyph      = GLYPHS[piece.color + piece.type.toUpperCase()] || '?';
                const pieceClass = piece.color === 'w' ? 'ce-piece-w' : 'ce-piece-b';
                inner = `<span class="ce-piece ${pieceClass}">${glyph}</span>`;
            }
            html += `<div class="${cellClass}">${inner}</div>`;
        }
        html += `</div>`;
    }

    html += `<div class="ce-row ce-file-row"><div class="ce-label"></div>`;
    for (const fIdx of fileOrder) {
        html += `<div class="ce-label ce-file-label">${String.fromCharCode(97 + fIdx)}</div>`;
    }
    html += `</div></div></div>`;
    return html;
}

// ─────────────────────────────────────────────────────────────────────────────
// Board injection into DOM
// ─────────────────────────────────────────────────────────────────────────────
async function injectBoard(messageId) {
    const settings = getSettings();
    if (!settings.enabled || !settings.showBoard) return;

    const state = getGameState();
    if (!state) return;

    if (!(await loadChessJs())) return;
    const game = makeGame(state.fen);
    if (!game) return;

    const el = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
    if (!el) return;

    el.querySelector('.ce-wrapper')?.remove();

    const boardHtml = renderBoardHtml(game, state, settings.playerColor);
    const mesText   = el.querySelector('.mes_text');
    if (mesText) mesText.insertAdjacentHTML('afterend', boardHtml);
}

// ─────────────────────────────────────────────────────────────────────────────
// Core game logic — user message handler
// ─────────────────────────────────────────────────────────────────────────────
async function processUserMessage(messageText) {
    const settings = getSettings();
    if (!settings.enabled) return;

    if (!(await loadChessJs())) return;

    const state = getGameState();

    if (!state) {
        if (!settings.autoDetectMoves) return;

        if (matchesTriggerPhrase(messageText)) {
            const game = makeGame();
            await saveGameState({
                fen: game.fen(), history: [], lastMoveWhite: null, lastMoveBlack: null,
            });
            toastr.success(
                `Chess game started! You play ${settings.playerColor === 'w' ? 'White' : 'Black'}. ` +
                `Make your first move in your next message (e.g. "E2 to E4").`,
                'Chess Engine',
            );
            console.log(`[${MODULE_NAME}] Game auto-started via trigger phrase`);
        }
        return;
    }

    if (state.gameOver) return;

    if (!settings.autoDetectMoves) return;

    const game = makeGame(state.fen);
    if (!game || game.isGameOver()) return;

    const playerColor = settings.playerColor || 'w';
    if (game.turn() !== playerColor) return;

    if (containsUserResignation(messageText)) {
        const reason = playerColor === 'w'
            ? 'White resigned — Black wins'
            : 'Black resigned — White wins';
        toastr.info(`You resigned. ${reason}.`);
        await endGame(reason, game, state);
        return;
    }

    const userMoveResult = applyUserMove(game, messageText);
    if (!userMoveResult) return;

    const whiteMoveStr = `${userMoveResult.from}→${userMoveResult.to}`;
    let   blackMoveStr = null;

    if (game.isGameOver()) {
        const reason = naturalGameOverReason(game, playerColor);
        toastr.info(`${reason}!`);
        await saveGameState({
            fen:            game.fen(),
            history:        game.history(),
            lastMoveWhite:  whiteMoveStr,
            lastMoveBlack:  null,
            gameOver:       true,
            gameOverReason: reason,
            narratedEnding: false,
        });
        return;
    }

    const aiColor = playerColor === 'w' ? 'b' : 'w';
    if (game.turn() === aiColor) {
        const bestMove = getBestMove(game, settings.aiLevel);
        if (bestMove) {
            const engineResult = game.move(bestMove);
            if (engineResult) {
                blackMoveStr = `${engineResult.from}→${engineResult.to}`;
            }
        }
    }

    const engineEndedGame = game.isGameOver();
    const gameOverReason  = engineEndedGame ? naturalGameOverReason(game, playerColor) : '';

    if (engineEndedGame) {
        toastr.info(`${gameOverReason}!`);
    } else if (game.isCheck()) {
        toastr.warning(game.turn() === 'w' ? 'White is in check!' : 'Black is in check!');
    }

    await saveGameState({
        fen:            game.fen(),
        history:        game.history(),
        lastMoveWhite:  whiteMoveStr,
        lastMoveBlack:  blackMoveStr,
        gameOver:       engineEndedGame,
        gameOverReason: gameOverReason,
        narratedEnding: false,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Generate interceptor — inject board state as a system note for the LLM
// ─────────────────────────────────────────────────────────────────────────────
globalThis.chessEngineInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();
    if (!settings.enabled) return;

    const state = getGameState();
    if (!state) return;

    if (state.narratedEnding) return;

    if (!(await loadChessJs())) return;
    const game = makeGame(state.fen);
    if (!game) return;

    let boardNote;

    if (state.gameOver) {
        const reason  = state.gameOverReason || 'The game has ended';
        const lastW   = state.lastMoveWhite ? `White's last move: ${state.lastMoveWhite.replace('→',' → ')}` : '';
        const lastB   = state.lastMoveBlack ? `Black's last move: ${state.lastMoveBlack.replace('→',' → ')}` : '';

        boardNote = [
            `[Chess game CONCLUDED — ${reason}]`,
            lastW,
            lastB,
            `FEN at end: ${state.fen}`,
            ``,
            `The chess game between you (Black) and the user (White) has ended.`,
            `Narrate the conclusion naturally — describe what happened, react to the result,`,
            `and then continue the story.  Do not start a new game or make up further moves.`,
        ].filter(Boolean).join('\n');

        await saveGameState({ ...state, narratedEnding: true });

    } else {
        const pieces  = { w: [], b: [] };
        for (const row of game.board()) {
            for (const piece of row) {
                if (!piece) continue;
                pieces[piece.color].push(`${PIECE_NAMES[piece.type]} on ${piece.square.toUpperCase()}`);
            }
        }

        const status  = gameStatus(game, null);
        const lastW   = state.lastMoveWhite
            ? `White's last move: ${state.lastMoveWhite.replace('→',' → ')}`
            : '';
        const lastB   = state.lastMoveBlack
            ? `Your (Black/Engine) response: ${state.lastMoveBlack.replace('→',' → ')}`
            : '';
        const history = (state.history ?? []).slice(-10).join(', ');

        boardNote = [
            `[Chess game in progress — ${status}]`,
            lastW,
            lastB,
            `White pieces: ${pieces.w.join(', ')}`,
            `Black pieces: ${pieces.b.join(', ')}`,
            history ? `Recent PGN: ${history}` : '',
            `FEN: ${state.fen}`,
            ``,
            `You are playing Black. The chess engine has already determined your move (shown above).`,
            `Incorporate the board situation naturally into your reply — describe the move you just made,`,
            `comment on the position, and continue the story. Do not invent different moves.`,
            `If you wish to resign, include [RESIGN] somewhere in your reply.`,
        ].filter(Boolean).join('\n');
    }

    const systemNote = {
        is_user:   false,
        is_system: true,
        name:      'Chess State',
        send_date: Date.now(),
        mes:       boardNote,
        extra:     { type: 'chess_engine_state' },
    };

    if (chat.length > 0) {
        chat.splice(chat.length - 1, 0, systemNote);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Event handlers
// ─────────────────────────────────────────────────────────────────────────────
async function onMessageSent(messageId) {
    const { chat } = getContext();

    let messageText = null;
    if (typeof messageId === 'number' && chat[messageId]) {
        messageText = chat[messageId].mes;
    } else {
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i].is_user) { messageText = chat[i].mes; break; }
        }
    }

    if (!messageText) return;
    await processUserMessage(messageText);
}

async function onCharacterMessageRendered(messageId) {
    await injectBoard(messageId);

    const state = getGameState();
    if (!state || state.gameOver) return;

    const { chat } = getContext();
    const message  = chat[messageId];
    if (!message || message.is_user || message.is_system) return;

    if (containsCharResignation(message.mes)) {
        const settings    = getSettings();
        const playerColor = settings.playerColor || 'w';
        const reason      = playerColor === 'w'
            ? 'Black resigned — White wins'
            : 'White resigned — Black wins';
        toastr.info(`The character resigned! ${reason}.`);
        await endGame(reason, null, state);
        await injectBoard(messageId);
    }
}

async function onChatChanged() {
    const state = getGameState();
    if (!state) return;
    if (!(await loadChessJs())) return;

    const { chat } = getContext();
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            setTimeout(() => injectBoard(i), 300);
            break;
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Slash commands
// ─────────────────────────────────────────────────────────────────────────────
async function handleChessCommand(args, sub) {
    const cmd = (typeof sub === 'string' ? sub : (args?._ ?? '')).trim().toLowerCase();

    if (!(await loadChessJs())) return '';

    const settings = getSettings();

    if (cmd === 'new' || cmd === 'reset' || cmd === 'start') {
        const game = makeGame();
        await saveGameState({ fen: game.fen(), history: [], lastMoveWhite: null, lastMoveBlack: null });
        toastr.success(
            `New chess game started! You play ${settings.playerColor === 'w' ? 'White' : 'Black'}. ` +
            `Make your first move in your next message (e.g. "E2 to E4").`,
        );
        return 'New game started.';
    }

    if (cmd === 'flip') {
        settings.playerColor = settings.playerColor === 'w' ? 'b' : 'w';
        const { saveSettingsDebounced } = getContext();
        saveSettingsDebounced();
        updateSettingsUI();
        toastr.info(`You now play ${settings.playerColor === 'w' ? 'White' : 'Black'}.`);
        return `Player color set to ${settings.playerColor === 'w' ? 'White' : 'Black'}.`;
    }

    if (cmd === 'fen') {
        const state = getGameState();
        if (!state) return 'No active game.';
        toastr.info(state.fen, 'Current FEN', { timeOut: 8000 });
        return state.fen;
    }

    if (cmd === 'board') {
        const { chat } = getContext();
        for (let i = chat.length - 1; i >= 0; i--) {
            if (!chat[i].is_user && !chat[i].is_system) {
                await injectBoard(i);
                break;
            }
        }
        return '';
    }

    if (cmd === 'resign') {
        const state = getGameState();
        if (!state || state.gameOver) {
            toastr.warning('No active game to resign from.');
            return 'No active game.';
        }
        const playerColor = settings.playerColor || 'w';
        const reason = playerColor === 'w'
            ? 'White resigned — Black wins'
            : 'Black resigned — White wins';
        toastr.info(`You resigned. ${reason}.`);
        await endGame(reason, null, state);
        return reason;
    }

    if (cmd === 'stop' || cmd === 'end' || cmd === 'quit') {
        await clearGameState();
        toastr.info('Chess game ended and cleared.');
        return 'Game cleared.';
    }

    toastr.info(
        '/chess new — start a new game\n' +
        '/chess flip — switch your colour (White ↔ Black)\n' +
        '/chess resign — forfeit the current game\n' +
        '/chess fen — print the current FEN\n' +
        '/chess board — redraw board on the last message\n' +
        '/chess stop — end and clear the game',
        'Chess Engine commands',
        { timeOut: 8000 },
    );
    return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings panel
// ─────────────────────────────────────────────────────────────────────────────
function buildSettingsHtml() {
    return `
<div class="inline-drawer ce-settings-panel">
  <div class="inline-drawer-toggle inline-drawer-header">
    <b>Chess Engine ♟</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
  </div>
  <div class="inline-drawer-content">

    <div class="ce-row-setting">
      <label class="checkbox_label">
        <input type="checkbox" id="ce_enabled" />
        <span>Enable Chess Engine</span>
      </label>
    </div>

    <div class="ce-row-setting">
      <label class="checkbox_label">
        <input type="checkbox" id="ce_show_board" />
        <span>Show board in chat</span>
      </label>
    </div>

    <div class="ce-row-setting">
      <label class="checkbox_label">
        <input type="checkbox" id="ce_auto_detect" />
        <span>Auto-detect moves in messages</span>
      </label>
    </div>

    <div class="ce-row-setting">
      <label class="checkbox_label">
        <input type="checkbox" id="ce_trigger_enabled" />
        <span>Auto-start on trigger phrase</span>
      </label>
    </div>

    <div class="ce-row-setting" id="ce_trigger_row">
      <label for="ce_trigger_phrase">Trigger phrase</label>
      <input id="ce_trigger_phrase" type="text" class="text_pole"
             placeholder="let's play chess" style="flex:1;min-width:160px;" />
    </div>

    <div class="ce-row-setting">
      <label for="ce_ai_level">Engine strength</label>
      <select id="ce_ai_level" class="text_pole">
        <option value="1">1 – Random (very easy)</option>
        <option value="2">2 – Beginner (fast)</option>
        <option value="3">3 – Intermediate</option>
        <option value="4">4 – Advanced (slower)</option>
      </select>
    </div>

    <div class="ce-row-setting">
      <label for="ce_player_color">You play as</label>
      <select id="ce_player_color" class="text_pole">
        <option value="w">White (moves first)</option>
        <option value="b">Black</option>
      </select>
    </div>

    <div class="ce-row-setting ce-btn-row">
      <button id="ce_new_game_btn"    class="menu_button">▶ New Game</button>
      <button id="ce_resign_btn"      class="menu_button">⚑ Resign</button>
      <button id="ce_end_game_btn"    class="menu_button">■ Clear Game</button>
    </div>

  </div>
</div>`;
}

function updateSettingsUI() {
    const settings = getSettings();
    const $ = id => document.getElementById(id);

    const fields = {
        ce_enabled:         { key: 'enabled',              type: 'checkbox' },
        ce_show_board:      { key: 'showBoard',            type: 'checkbox' },
        ce_auto_detect:     { key: 'autoDetectMoves',      type: 'checkbox' },
        ce_trigger_enabled: { key: 'triggerPhraseEnabled', type: 'checkbox' },
        ce_trigger_phrase:  { key: 'triggerPhrase',        type: 'text'     },
        ce_ai_level:        { key: 'aiLevel',              type: 'select'   },
        ce_player_color:    { key: 'playerColor',          type: 'select'   },
    };

    for (const [id, { key, type }] of Object.entries(fields)) {
        const el = $(id);
        if (!el) continue;
        if (type === 'checkbox') el.checked = !!settings[key];
        else el.value = String(settings[key] ?? '');
    }

    const triggerRow = $('ce_trigger_row');
    if (triggerRow) triggerRow.style.opacity = settings.triggerPhraseEnabled ? '1' : '0.4';
}

function attachSettingsListeners() {
    const { saveSettingsDebounced } = getContext();
    const settings = getSettings();

    const bind = (id, key, transform = v => v) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('change', () => {
            settings[key] = transform(el.type === 'checkbox' ? el.checked : el.value);
            saveSettingsDebounced();
            updateSettingsUI();  
        });
    };

    bind('ce_enabled',         'enabled');
    bind('ce_show_board',      'showBoard');
    bind('ce_auto_detect',     'autoDetectMoves');
    bind('ce_trigger_enabled', 'triggerPhraseEnabled');
    bind('ce_trigger_phrase',  'triggerPhrase',   v => v.trim());
    bind('ce_ai_level',        'aiLevel',         v => parseInt(v, 10));
    bind('ce_player_color',    'playerColor');

    document.getElementById('ce_new_game_btn')?.addEventListener('click',
        () => handleChessCommand({}, 'new'));

    document.getElementById('ce_resign_btn')?.addEventListener('click',
        () => handleChessCommand({}, 'resign'));

    document.getElementById('ce_end_game_btn')?.addEventListener('click',
        () => handleChessCommand({}, 'stop'));
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────
jQuery(async () => {
    console.log(`[${MODULE_NAME}] Activating…`);

    loadChessJs();   
    getSettings();   

    // ── Settings panel ───────────────────────────────────────────────────────
    const settingsArea = document.getElementById('extensions_settings');
    if (settingsArea) {
        const div = document.createElement('div');
        div.innerHTML = buildSettingsHtml();
        settingsArea.appendChild(div);
        updateSettingsUI();
        attachSettingsListeners();
    }

    // ── Slash command ────────────────────────────────────────────────────────
    try {
        const { SlashCommandParser } = await import('../../../../slash-commands/SlashCommandParser.js');
        const { SlashCommand } = await import('../../../../slash-commands/SlashCommand.js');
        const { SlashCommandArgument, ARGUMENT_TYPE } = await import('../../../../slash-commands/SlashCommandArgument.js');

        if (SlashCommandParser && SlashCommand) {
            SlashCommandParser.addCommandObject(SlashCommand.fromProps({
                name: 'chess',
                aliases: ['ch'],
                callback: async (namedArgs, subcommand) =>
                    handleChessCommand(namedArgs, String(subcommand)),
                unnamedArgumentList: [
                    SlashCommandArgument.fromProps({
                        description: 'new | flip | resign | fen | board | stop',
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ],
                helpString:
                    'Chess Engine — <code>new</code> | <code>flip</code> | ' +
                    '<code>resign</code> | <code>fen</code> | <code>board</code> | <code>stop</code>',
            }));
        }
    } catch (e) {
        console.warn(`[${MODULE_NAME}] Could not register slash command:`, e);
    }

    // ── Event listeners ──────────────────────────────────────────────────────
    eventSource.on(event_types.MESSAGE_SENT,              onMessageSent);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED,              onChatChanged);
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        getSettings();
        updateSettingsUI();
    });

    console.log(`[${MODULE_NAME}] Ready. Trigger phrase: "${getSettings().triggerPhrase}"`);
});
