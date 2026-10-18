/**
 * Fanorona Tactical Solver & Companion for Assassin's Creed IV: Black Flag (Resynched)
 *
 * Rules of Fanoron-tsivy (9x5 grid, 45 intersections):
 * - Strong intersections (where (row + col) % 2 === 0) connect orthogonally AND diagonally (8 directions).
 * - Weak intersections (where (row + col) % 2 === 1) connect ONLY orthogonally (4 directions).
 * - Capturing is mandatory if any capture exists for the active side.
 * - Capture by Approach: step from `from` to `to`; enemy contiguous line starting at `to + dir` is captured.
 * - Capture by Withdrawal: step from `from` to `to`; enemy contiguous line starting at `from - dir` is captured.
 * - If BOTH approach and withdrawal captures occur on the same step, the player MUST choose ONE.
 * - Multi-capture sequences:
 *   - Only the same piece may continue capturing.
 *   - Cannot revisit any intersection already visited in the same turn.
 *   - Cannot move in the exact same direction twice in a row.
 *   - Every continuation step MUST make a capture.
 *   - Stopping a capture chain early is ALWAYS allowed after at least 1 capture!
 */

const COLS = 9;
const ROWS = 5;
const NUM_SQUARES = 45;
const EMPTY = 0;
const WHITE = 1;
const BLACK = 2;

const COL_NAMES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
const ROW_NAMES = ['1', '2', '3', '4', '5']; // Row 1 = Top (AI side), Row 5 = Bottom (Player side)

// 8 compass directions: [dr, dc, name]
const DIRS = [
  [-1, 0, 'N'],
  [1, 0, 'S'],
  [0, -1, 'W'],
  [0, 1, 'E'],
  [-1, -1, 'NW'],
  [-1, 1, 'NE'],
  [1, -1, 'SW'],
  [1, 1, 'SE']
];

// Precompute graph topology & ray tables for fast move generation
const NEIGHBORS = Array.from({ length: NUM_SQUARES }, () => []);
// RAYS[sq][dirIdx] = array of squares extending from sq in dirIdx
const RAYS = Array.from({ length: NUM_SQUARES }, () => Array.from({ length: 8 }, () => []));
// STRONG_SQ[sq] = true if diagonals allowed
const STRONG_SQ = new Array(NUM_SQUARES).fill(false);

function idx(r, c) {
  return r * COLS + c;
}

function rowOf(sq) {
  return Math.floor(sq / COLS);
}

function colOf(sq) {
  return sq % COLS;
}

function sqName(sq) {
  return `${COL_NAMES[colOf(sq)]}${ROW_NAMES[rowOf(sq)]}`;
}

(function initTopology() {
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const sq = idx(r, c);
      const isStrong = (r + c) % 2 === 0;
      STRONG_SQ[sq] = isStrong;

      for (let d = 0; d < 8; d++) {
        if (d >= 4 && !isStrong) continue; // Weak intersections only have orthogonal connections
        const [dr, dc] = DIRS[d];
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
          NEIGHBORS[sq].push({ to: idx(nr, nc), dir: d });
        }

        // Build ray in direction d
        let cr = r + dr;
        let cc = c + dc;
        while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS) {
          RAYS[sq][d].push(idx(cr, cc));
          cr += dr;
          cc += dc;
        }
      }
    }
  }
})();

function oppositeDir(d) {
  // 0<->1, 2<->3, 4<->7, 5<->6
  const map = [1, 0, 3, 2, 7, 6, 5, 4];
  return map[d];
}

function opponentOf(color) {
  return color === WHITE ? BLACK : WHITE;
}

/**
 * Compute captured enemy squares for a single step from `from` to `to` along `dir`.
 */
function getStepCaptures(board, from, to, dir, moverColor) {
  const enemy = opponentOf(moverColor);

  // Approach: ray from `to` in `dir`
  const approachRay = RAYS[to][dir];
  const approach = [];
  for (let i = 0; i < approachRay.length; i++) {
    const s = approachRay[i];
    if (board[s] === enemy) {
      approach.push(s);
    } else {
      break;
    }
  }

  // Withdrawal: ray from `from` in `oppositeDir(dir)`
  const oppDir = oppositeDir(dir);
  const withdrawRay = RAYS[from][oppDir];
  const withdraw = [];
  for (let i = 0; i < withdrawRay.length; i++) {
    const s = withdrawRay[i];
    if (board[s] === enemy) {
      withdraw.push(s);
    } else {
      break;
    }
  }

  return { approach, withdraw };
}

/**
 * Clone board and apply a single step
 */
function applySingleStepToBoard(board, from, to, capturedSquares) {
  const next = board.slice();
  next[to] = next[from];
  next[from] = EMPTY;
  for (let i = 0; i < capturedSquares.length; i++) {
    next[capturedSquares[i]] = EMPTY;
  }
  return next;
}

/**
 * Generate all legal complete or partial turns for `color` on `board`.
 * Note: Because stopping a capture chain early is legal and often tactically critical in Fanorona,
 * EVERY intermediate state after >= 1 capture is also a valid complete turn!
 *
 * Each returned Turn object has:
 * {
 *   isCapture: boolean,
 *   steps: [ { from, to, dir, type: 'approach'|'withdraw'|'paika', captured: number[] } ],
 *   totalCaptured: number[],
 *   finalBoard: number[],
 *   stoppedEarly: boolean // true if another capture continuation existed from the final square
 * }
 */
function generateAllLegalTurns(board, color) {
  const captureTurns = [];

  // Recursive DFS for capture sequences
  function dfs(curBoard, curSq, visitedMask, lastDir, stepsSoFar, totalCapturedSoFar) {
    let anyContinuationFound = false;

    const neighbors = NEIGHBORS[curSq];
    for (let i = 0; i < neighbors.length; i++) {
      const { to, dir } = neighbors[i];
      if (curBoard[to] !== EMPTY) continue;
      if (dir === lastDir) continue; // Cannot move in the same direction twice in a row
      if (visitedMask.has(to)) continue; // Cannot revisit any square visited in this turn

      const { approach, withdraw } = getStepCaptures(curBoard, curSq, to, dir, color);
      if (approach.length > 0) {
        anyContinuationFound = true;
        const nextBoard = applySingleStepToBoard(curBoard, curSq, to, approach);
        const nextVisited = new Set(visitedMask);
        nextVisited.add(to);
        const stepObj = { from: curSq, to, dir, type: 'approach', captured: approach };
        dfs(
          nextBoard,
          to,
          nextVisited,
          dir,
          [...stepsSoFar, stepObj],
          [...totalCapturedSoFar, ...approach]
        );
      }

      if (withdraw.length > 0) {
        anyContinuationFound = true;
        const nextBoard = applySingleStepToBoard(curBoard, curSq, to, withdraw);
        const nextVisited = new Set(visitedMask);
        nextVisited.add(to);
        const stepObj = { from: curSq, to, dir, type: 'withdraw', captured: withdraw };
        dfs(
          nextBoard,
          to,
          nextVisited,
          dir,
          [...stepsSoFar, stepObj],
          [...totalCapturedSoFar, ...withdraw]
        );
      }
    }

    // Record the turn ending right here (whether because no more captures exist, or stopping early)
    if (stepsSoFar.length > 0) {
      captureTurns.push({
        isCapture: true,
        steps: stepsSoFar,
        totalCaptured: totalCapturedSoFar,
        finalBoard: curBoard,
        stoppedEarly: anyContinuationFound
      });
    }
  }

  // Try starting a capture sequence from every piece of `color`
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    if (board[sq] !== color) continue;
    const visited = new Set([sq]);
    dfs(board, sq, visited, -1, [], []);
  }

  if (captureTurns.length > 0) {
    return captureTurns;
  }

  // No captures exist -> Paika (non-capturing moves)
  const paikaTurns = [];
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    if (board[sq] !== color) continue;
    const neighbors = NEIGHBORS[sq];
    for (let i = 0; i < neighbors.length; i++) {
      const { to, dir } = neighbors[i];
      if (board[to] === EMPTY) {
        const nextBoard = applySingleStepToBoard(board, sq, to, []);
        paikaTurns.push({
          isCapture: false,
          steps: [{ from: sq, to, dir, type: 'paika', captured: [] }],
          totalCaptured: [],
          finalBoard: nextBoard,
          stoppedEarly: false
        });
      }
    }
  }

  return paikaTurns;
}

/**
 * Format a turn into readable notation
 */
function formatTurnNotation(turn) {
  if (!turn || turn.steps.length === 0) return '';
  const first = turn.steps[0];
  if (!turn.isCapture) {
    return `${sqName(first.from)} → ${sqName(first.to)} (Paika)`;
  }
  const pathStr = [sqName(first.from), ...turn.steps.map(s => sqName(s.to))].join(' → ');
  const firstTag = first.type === 'approach' ? 'Approach' : 'Withdraw';
  const stopTag = turn.stoppedEarly ? ' [Stop Early]' : '';
  return `${pathStr} (${firstTag}, -${turn.totalCaptured.length}${stopTag})`;
}

/**
 * Heuristic Evaluation of a board state from `perspectiveColor`'s point of view.
 * Accounts for:
 * - Material count & ratio (dominant factor)
 * - Strong intersection control (8-way intersections are critical in Fanorona endgames)
 * - Center control & piece connectivity
 */
function evaluateBoard(board, perspectiveColor) {
  const enemyColor = opponentOf(perspectiveColor);
  let myPieces = 0;
  let enemyPieces = 0;
  let myPositional = 0;
  let enemyPositional = 0;

  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    const p = board[sq];
    if (p === EMPTY) continue;

    const r = rowOf(sq);
    const c = colOf(sq);
    // Strong intersections are much stronger in Fanorona
    let bonus = STRONG_SQ[sq] ? 14 : 5;
    // Central rows (1..3) and central cols (2..6) control more lines
    if (r >= 1 && r <= 3) bonus += 6;
    if (c >= 2 && c <= 6) bonus += 5;
    if (sq === 22) bonus += 8; // Dead center E3

    if (p === perspectiveColor) {
      myPieces++;
      myPositional += bonus;
    } else if (p === enemyColor) {
      enemyPieces++;
      enemyPositional += bonus;
    }
  }

  if (enemyPieces === 0) return 100000;
  if (myPieces === 0) return -100000;

  const materialDiff = (myPieces - enemyPieces) * 120;
  // Ratio bonus rewards trading down when ahead
  const ratioBonus = ((myPieces - enemyPieces) / (myPieces + enemyPieces)) * 300;
  return materialDiff + ratioBonus + (myPositional - enemyPositional);
}

/**
 * Iterative Deepening Alpha-Beta Solver with Move Ordering & Time Budget
 */
function findBestMoves(board, activeColor, timeBudgetMs = 1500) {
  const startTime = performance.now();
  const rootTurns = generateAllLegalTurns(board, activeColor);

  if (rootTurns.length === 0) {
    return { bestTurn: null, rankedTurns: [], depthReached: 0, evalScore: -100000 };
  }
  if (rootTurns.length === 1) {
    const score = evaluateBoard(rootTurns[0].finalBoard, activeColor);
    return {
      bestTurn: rootTurns[0],
      rankedTurns: [{ turn: rootTurns[0], score }],
      depthReached: 1,
      evalScore: score
    };
  }

  // Deduplicate identical finalBoard states only if they have the same step count,
  // or score all root turns with initial static + capture heuristic
  let scoredRoot = rootTurns.map(turn => {
    const immScore =
      evaluateBoard(turn.finalBoard, activeColor) + turn.totalCaptured.length * 15;
    return { turn, score: immScore };
  });

  scoredRoot.sort((a, b) => b.score - a.score);

  let timeUp = false;
  let nodesVisited = 0;

  function alphaBeta(curBoard, depth, alpha, beta, turnColor) {
    nodesVisited++;
    if ((nodesVisited & 255) === 0) {
      if (performance.now() - startTime >= timeBudgetMs) {
        timeUp = true;
      }
    }
    if (timeUp || depth === 0) {
      return evaluateBoard(curBoard, activeColor);
    }

    // Quick terminal check
    let wCount = 0;
    let bCount = 0;
    for (let i = 0; i < NUM_SQUARES; i++) {
      if (curBoard[i] === WHITE) wCount++;
      else if (curBoard[i] === BLACK) bCount++;
    }
    if (wCount === 0 || bCount === 0) {
      const rawEval = evaluateBoard(curBoard, activeColor);
      return rawEval > 0 ? rawEval + depth * 100 : rawEval - depth * 100;
    }

    let legalTurns = generateAllLegalTurns(curBoard, turnColor);
    if (legalTurns.length === 0) {
      return turnColor === activeColor ? -90000 - depth * 100 : 90000 + depth * 100;
    }

    // Deduplicate identical resulting boards inside the tree to speed up search
    if (legalTurns.length > 8) {
      const seenBoards = new Set();
      const filtered = [];
      // Sort captures by most captured first before deduplicating
      legalTurns.sort((a, b) => b.totalCaptured.length - a.totalCaptured.length);
      for (let i = 0; i < legalTurns.length; i++) {
        const key = legalTurns[i].finalBoard.join('');
        if (!seenBoards.has(key)) {
          seenBoards.add(key);
          filtered.push(legalTurns[i]);
        }
      }
      legalTurns = filtered;
    }

    // Cap branching factor at deeper plies for responsiveness
    if (legalTurns.length > 22) {
      legalTurns = legalTurns.slice(0, 22);
    }

    const nextColor = opponentOf(turnColor);

    if (turnColor === activeColor) {
      let maxEval = -Infinity;
      for (let i = 0; i < legalTurns.length; i++) {
        const val = alphaBeta(legalTurns[i].finalBoard, depth - 1, alpha, beta, nextColor);
        if (timeUp) break;
        if (val > maxEval) maxEval = val;
        if (maxEval > alpha) alpha = maxEval;
        if (beta <= alpha) break;
      }
      return maxEval;
    } else {
      let minEval = Infinity;
      for (let i = 0; i < legalTurns.length; i++) {
        const val = alphaBeta(legalTurns[i].finalBoard, depth - 1, alpha, beta, nextColor);
        if (timeUp) break;
        if (val < minEval) minEval = val;
        if (minEval < beta) beta = minEval;
        if (beta <= alpha) break;
      }
      return minEval;
    }
  }

  let bestCompletedRanked = scoredRoot.slice();
  let completedDepth = 1;

  for (let depth = 2; depth <= 9; depth++) {
    let alpha = -Infinity;
    const beta = Infinity;
    const currentIterationScores = [];

    for (let i = 0; i < bestCompletedRanked.length; i++) {
      const candidate = bestCompletedRanked[i].turn;
      const val = alphaBeta(
        candidate.finalBoard,
        depth - 1,
        alpha,
        beta,
        opponentOf(activeColor)
      );
      if (timeUp) break;
      currentIterationScores.push({ turn: candidate, score: val });
      if (val > alpha) alpha = val;
    }

    if (!timeUp && currentIterationScores.length === bestCompletedRanked.length) {
      currentIterationScores.sort((a, b) => b.score - a.score);
      bestCompletedRanked = currentIterationScores;
      completedDepth = depth;
      // If we found a forced win, stop early
      if (bestCompletedRanked[0].score > 80000) break;
    } else {
      break;
    }
  }

  return {
    bestTurn: bestCompletedRanked[0].turn,
    rankedTurns: bestCompletedRanked,
    depthReached: completedDepth,
    evalScore: bestCompletedRanked[0].score
  };
}

/* ============================================================================
 * APPLICATION STATE & INTERACTIVE UI CONTROLLER
 * ============================================================================ */

const state = {
  // Setup Configuration
  playerColor: WHITE, // Piece color on Bottom (Rows 4-5)
  firstMover: 'player', // 'player' | 'ai'
  middleRowInverted: false,

  // Live Match State
  board: new Array(NUM_SQUARES).fill(EMPTY),
  activeTurnOwner: 'player', // 'player' | 'ai'
  history: [], // Stack of snapshots for Undo
  redoStack: [], // Stack of snapshots for Redo
  moveLog: [], // Array of { who: 'player'|'ai', notation, capturedCount }

  // Interactive Chain / Manual Step State (for inputting AI moves or manual player moves)
  chainInProgress: false,
  chainPieceSq: null,
  chainVisited: new Set(),
  chainLastDir: -1,
  chainSteps: [],
  chainBoardBeforeTurn: null,

  // Currently selected piece on the board (before or during a chain)
  selectedSq: null,
  // Pending Approach vs Withdrawal disambiguation modal state
  pendingAmbiguousStep: null, // { from, to, dir, approach, withdraw }

  // Solver & Preview State
  solverResult: null, // { bestTurn, rankedTurns, depthReached, evalScore }
  solverThinking: false,
  solverJobId: 0,
  previewedTurn: null, // Turn object currently hovered/selected in the sidebar

  // Custom Board Editor Mode
  editMode: false,
  editBrush: 'cycle' // 'cycle' | 'W' | 'B' | 'E'
};

/* ============================================================================
 * ASYNCHRONOUS WEB WORKER SOLVER (NON-BLOCKING UI)
 * ============================================================================ */

let solverWorker = null;

function createSolverWorker() {
  if (solverWorker) {
    solverWorker.terminate();
  }

  // Package the pure Fanorona rules & alpha-beta search into an inline Blob Worker
  const workerSource = `
    const COLS = 9;
    const ROWS = 5;
    const NUM_SQUARES = 45;
    const EMPTY = 0;
    const WHITE = 1;
    const BLACK = 2;
    const DIRS = [
      [-1, 0, 'N'], [1, 0, 'S'], [0, -1, 'W'], [0, 1, 'E'],
      [-1, -1, 'NW'], [-1, 1, 'NE'], [1, -1, 'SW'], [1, 1, 'SE']
    ];
    const NEIGHBORS = Array.from({ length: NUM_SQUARES }, () => []);
    const RAYS = Array.from({ length: NUM_SQUARES }, () => Array.from({ length: 8 }, () => []));
    const STRONG_SQ = new Array(NUM_SQUARES).fill(false);

    ${idx.toString()}
    ${rowOf.toString()}
    ${colOf.toString()}
    ${oppositeDir.toString()}
    ${opponentOf.toString()}
    ${getStepCaptures.toString()}
    ${applySingleStepToBoard.toString()}
    ${generateAllLegalTurns.toString()}
    ${evaluateBoard.toString()}

    (function initTopology() {
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const sq = idx(r, c);
          const isStrong = (r + c) % 2 === 0;
          STRONG_SQ[sq] = isStrong;
          for (let d = 0; d < 8; d++) {
            if (d >= 4 && !isStrong) continue;
            const [dr, dc] = DIRS[d];
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
              NEIGHBORS[sq].push({ to: idx(nr, nc), dir: d });
            }
            let cr = r + dr;
            let cc = c + dc;
            while (cr >= 0 && cr < ROWS && cc >= 0 && cc < COLS) {
              RAYS[sq][d].push(idx(cr, cc));
              cr += dr;
              cc += dc;
            }
          }
        }
      }
    })();

    self.onmessage = function(e) {
      const { jobId, board, activeColor, timeBudgetMs } = e.data;
      const startTime = performance.now();
      const rootTurns = generateAllLegalTurns(board, activeColor);

      if (rootTurns.length === 0) {
        self.postMessage({
          jobId,
          done: true,
          result: { bestTurn: null, rankedTurns: [], depthReached: 0, evalScore: -100000 }
        });
        return;
      }

      let scoredRoot = rootTurns.map(turn => {
        const immScore = evaluateBoard(turn.finalBoard, activeColor) + turn.totalCaptured.length * 15;
        return { turn, score: immScore };
      });
      scoredRoot.sort((a, b) => b.score - a.score);

      if (rootTurns.length === 1) {
        self.postMessage({
          jobId,
          done: true,
          result: {
            bestTurn: scoredRoot[0].turn,
            rankedTurns: scoredRoot,
            depthReached: 1,
            evalScore: scoredRoot[0].score
          }
        });
        return;
      }

      let timeUp = false;
      let nodesVisited = 0;

      function alphaBeta(curBoard, depth, alpha, beta, turnColor) {
        nodesVisited++;
        if ((nodesVisited & 255) === 0) {
          if (performance.now() - startTime >= timeBudgetMs) {
            timeUp = true;
          }
        }
        if (timeUp || depth === 0) {
          return evaluateBoard(curBoard, activeColor);
        }

        let wCount = 0;
        let bCount = 0;
        for (let i = 0; i < NUM_SQUARES; i++) {
          if (curBoard[i] === WHITE) wCount++;
          else if (curBoard[i] === BLACK) bCount++;
        }
        if (wCount === 0 || bCount === 0) {
          const rawEval = evaluateBoard(curBoard, activeColor);
          return rawEval > 0 ? rawEval + depth * 100 : rawEval - depth * 100;
        }

        let legalTurns = generateAllLegalTurns(curBoard, turnColor);
        if (legalTurns.length === 0) {
          return turnColor === activeColor ? -90000 - depth * 100 : 90000 + depth * 100;
        }

        if (legalTurns.length > 8) {
          const seenBoards = new Set();
          const filtered = [];
          legalTurns.sort((a, b) => b.totalCaptured.length - a.totalCaptured.length);
          for (let i = 0; i < legalTurns.length; i++) {
            const key = legalTurns[i].finalBoard.join('');
            if (!seenBoards.has(key)) {
              seenBoards.add(key);
              filtered.push(legalTurns[i]);
            }
          }
          legalTurns = filtered;
        }

        if (legalTurns.length > 22) {
          legalTurns = legalTurns.slice(0, 22);
        }

        const nextColor = opponentOf(turnColor);

        if (turnColor === activeColor) {
          let maxEval = -Infinity;
          for (let i = 0; i < legalTurns.length; i++) {
            const val = alphaBeta(legalTurns[i].finalBoard, depth - 1, alpha, beta, nextColor);
            if (timeUp) break;
            if (val > maxEval) maxEval = val;
            if (maxEval > alpha) alpha = maxEval;
            if (beta <= alpha) break;
          }
          return maxEval;
        } else {
          let minEval = Infinity;
          for (let i = 0; i < legalTurns.length; i++) {
            const val = alphaBeta(legalTurns[i].finalBoard, depth - 1, alpha, beta, nextColor);
            if (timeUp) break;
            if (val < minEval) minEval = val;
            if (minEval < beta) beta = minEval;
            if (beta <= alpha) break;
          }
          return minEval;
        }
      }

      let bestCompletedRanked = scoredRoot.slice();
      let completedDepth = 1;

      for (let depth = 2; depth <= 9; depth++) {
        let alpha = -Infinity;
        const beta = Infinity;
        const currentIterationScores = [];

        for (let i = 0; i < bestCompletedRanked.length; i++) {
          const candidate = bestCompletedRanked[i].turn;
          const val = alphaBeta(
            candidate.finalBoard,
            depth - 1,
            alpha,
            beta,
            opponentOf(activeColor)
          );
          if (timeUp) break;
          currentIterationScores.push({ turn: candidate, score: val });
          if (val > alpha) alpha = val;
        }

        if (!timeUp && currentIterationScores.length === bestCompletedRanked.length) {
          currentIterationScores.sort((a, b) => b.score - a.score);
          bestCompletedRanked = currentIterationScores;
          completedDepth = depth;

          // Send progressive update after each completed depth!
          self.postMessage({
            jobId,
            done: false,
            result: {
              bestTurn: bestCompletedRanked[0].turn,
              rankedTurns: bestCompletedRanked,
              depthReached: completedDepth,
              evalScore: bestCompletedRanked[0].score
            }
          });

          if (bestCompletedRanked[0].score > 80000) break;
        } else {
          break;
        }
      }

      self.postMessage({
        jobId,
        done: true,
        result: {
          bestTurn: bestCompletedRanked[0].turn,
          rankedTurns: bestCompletedRanked,
          depthReached: completedDepth,
          evalScore: bestCompletedRanked[0].score
        }
      });
    };
  `;

  const blob = new Blob([workerSource], { type: 'application/javascript' });
  solverWorker = new Worker(URL.createObjectURL(blob));

  solverWorker.onmessage = e => {
    const { jobId, done, result } = e.data;
    if (jobId !== state.solverJobId) return; // Ignore stale job messages
    state.solverResult = result;
    if (done) {
      state.solverThinking = false;
    }
    renderAll();
  };
}

function cancelActiveSolverJob() {
  state.solverJobId++;
  if (state.solverThinking) {
    state.solverThinking = false;
    // Recreate worker to immediately abort any heavy in-flight CPU loop
    createSolverWorker();
  }
}

/**
 * Create the standard Fanorona starting board with `playerColor` at the bottom (Rows 4 & 5)
 * and `aiColor` at the top (Rows 1 & 2).
 */
function createInitialBoard(playerColor, middleRowInverted = false) {
  const aiColor = opponentOf(playerColor);
  const b = new Array(NUM_SQUARES).fill(EMPTY);

  // Top 2 rows (Rows 0 and 1) belong to AC Tavern AI
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < COLS; c++) {
      b[idx(r, c)] = aiColor;
    }
  }

  // Bottom 2 rows (Rows 3 and 4) belong to Player (Edward)
  for (let r = 3; r < 5; r++) {
    for (let c = 0; c < COLS; c++) {
      b[idx(r, c)] = playerColor;
    }
  }

  // Middle row (Row 2, labeled Row 3): alternates AI and Player pieces on each side of EMPTY center (E3, col 4).
  // Left half (A3..D3, cols 0..3): A3=Black, B3=White, C3=Black, D3=White
  // Right half (F3..I3, cols 5..8): F3=Black, G3=White, H3=Black, I3=White
  for (let c = 0; c < COLS; c++) {
    if (c === 4) {
      b[idx(2, c)] = EMPTY;
    } else {
      const isAiPiece = c < 4 ? (c % 2 === 0) : (c % 2 === 1);
      if (!middleRowInverted) {
        b[idx(2, c)] = isAiPiece ? aiColor : playerColor;
      } else {
        b[idx(2, c)] = isAiPiece ? playerColor : aiColor;
      }
    }
  }

  return b;
}

function getActiveColor() {
  return state.activeTurnOwner === 'player'
    ? state.playerColor
    : opponentOf(state.playerColor);
}

function saveSnapshotForUndo() {
  state.history.push({
    board: state.board.slice(),
    activeTurnOwner: state.activeTurnOwner,
    moveLog: state.moveLog.map(m => ({ ...m }))
  });
  state.redoStack = [];
  updateUndoRedoButtons();
}

function clearInteractiveSelection() {
  state.chainInProgress = false;
  state.chainPieceSq = null;
  state.chainVisited = new Set();
  state.chainLastDir = -1;
  state.chainSteps = [];
  state.chainBoardBeforeTurn = null;
  state.selectedSq = null;
  state.pendingAmbiguousStep = null;
  state.previewedTurn = null;
}

function startNewGame() {
  clearInteractiveSelection();
  state.board = createInitialBoard(state.playerColor, state.middleRowInverted);
  state.activeTurnOwner = state.firstMover;
  state.history = [];
  state.redoStack = [];
  state.moveLog = [];
  updateUndoRedoButtons();
  recomputeAndRender();
}

function undoMove() {
  if (state.chainInProgress) {
    // Cancel the in-progress chain back to the start of this turn
    state.board = state.chainBoardBeforeTurn.slice();
    clearInteractiveSelection();
    recomputeAndRender();
    return;
  }
  if (state.history.length === 0) return;
  state.redoStack.push({
    board: state.board.slice(),
    activeTurnOwner: state.activeTurnOwner,
    moveLog: state.moveLog.map(m => ({ ...m }))
  });
  const prev = state.history.pop();
  state.board = prev.board.slice();
  state.activeTurnOwner = prev.activeTurnOwner;
  state.moveLog = prev.moveLog.map(m => ({ ...m }));
  clearInteractiveSelection();
  updateUndoRedoButtons();
  recomputeAndRender();
}

function redoMove() {
  if (state.redoStack.length === 0) return;
  state.history.push({
    board: state.board.slice(),
    activeTurnOwner: state.activeTurnOwner,
    moveLog: state.moveLog.map(m => ({ ...m }))
  });
  const next = state.redoStack.pop();
  state.board = next.board.slice();
  state.activeTurnOwner = next.activeTurnOwner;
  state.moveLog = next.moveLog.map(m => ({ ...m }));
  clearInteractiveSelection();
  updateUndoRedoButtons();
  recomputeAndRender();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = state.history.length === 0 && !state.chainInProgress;
  if (redoBtn) redoBtn.disabled = state.redoStack.length === 0;
}

/**
 * Commit a full turn (either from Solver recommendation, Legal Turns list, or finished manual chain)
 */
function commitFullTurn(turn) {
  if (!turn) return;
  saveSnapshotForUndo();
  const who = state.activeTurnOwner;
  const notation = formatTurnNotation(turn);
  state.board = turn.finalBoard.slice();
  state.moveLog.unshift({
    who,
    notation,
    capturedCount: turn.totalCaptured.length
  });
  state.activeTurnOwner = who === 'player' ? 'ai' : 'player';
  clearInteractiveSelection();
  updateUndoRedoButtons();
  recomputeAndRender();
}

/**
 * Finish an interactive multi-step chain that the user clicked on the board
 */
function finishInteractiveChain() {
  if (!state.chainInProgress) return;
  const who = state.activeTurnOwner;
  // Save the pre-chain board into history so Undo restores the entire turn cleanly
  state.history.push({
    board: state.chainBoardBeforeTurn.slice(),
    activeTurnOwner: who,
    moveLog: state.moveLog.map(m => ({ ...m }))
  });
  state.redoStack = [];

  const totalCaptured = state.chainSteps.flatMap(s => s.captured);
  const turnObj = {
    isCapture: totalCaptured.length > 0,
    steps: state.chainSteps,
    totalCaptured,
    finalBoard: state.board.slice(),
    stoppedEarly: false
  };
  state.moveLog.unshift({
    who,
    notation: formatTurnNotation(turnObj),
    capturedCount: totalCaptured.length
  });
  state.activeTurnOwner = who === 'player' ? 'ai' : 'player';
  clearInteractiveSelection();
  updateUndoRedoButtons();
  recomputeAndRender();
}

/**
 * Determine what single-step moves are currently legal for the user clicking on the board
 */
function getInteractiveValidStepsFrom(fromSq) {
  const activeColor = getActiveColor();
  if (state.board[fromSq] !== activeColor) return [];

  if (state.chainInProgress) {
    // Only the active chain piece can move, and it MUST make a capture
    if (fromSq !== state.chainPieceSq) return [];
    const steps = [];
    for (const { to, dir } of NEIGHBORS[fromSq]) {
      if (state.board[to] !== EMPTY) continue;
      if (dir === state.chainLastDir) continue;
      if (state.chainVisited.has(to)) continue;
      const { approach, withdraw } = getStepCaptures(state.board, fromSq, to, dir, activeColor);
      if (approach.length > 0 || withdraw.length > 0) {
        steps.push({ from: fromSq, to, dir, approach, withdraw, isCapture: true });
      }
    }
    return steps;
  }

  // Start of a turn: check if ANY piece of activeColor has a capture
  let anyCaptureOnBoard = false;
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    if (state.board[sq] !== activeColor) continue;
    for (const { to, dir } of NEIGHBORS[sq]) {
      if (state.board[to] !== EMPTY) continue;
      const { approach, withdraw } = getStepCaptures(state.board, sq, to, dir, activeColor);
      if (approach.length > 0 || withdraw.length > 0) {
        anyCaptureOnBoard = true;
        break;
      }
    }
    if (anyCaptureOnBoard) break;
  }

  const steps = [];
  for (const { to, dir } of NEIGHBORS[fromSq]) {
    if (state.board[to] !== EMPTY) continue;
    const { approach, withdraw } = getStepCaptures(state.board, fromSq, to, dir, activeColor);
    const hasCap = approach.length > 0 || withdraw.length > 0;
    if (anyCaptureOnBoard) {
      if (hasCap) {
        steps.push({ from: fromSq, to, dir, approach, withdraw, isCapture: true });
      }
    } else {
      steps.push({ from: fromSq, to, dir, approach: [], withdraw: [], isCapture: false });
    }
  }
  return steps;
}

/**
 * Execute an interactive single step on the board (used when inputting AI moves or manual steps)
 */
function executeInteractiveStep(stepInfo, chosenType) {
  const { from, to, dir, approach, withdraw, isCapture } = stepInfo;
  state.pendingAmbiguousStep = null;

  if (!isCapture) {
    // Simple Paika move -> completes the turn immediately
    const finalBoard = applySingleStepToBoard(state.board, from, to, []);
    commitFullTurn({
      isCapture: false,
      steps: [{ from, to, dir, type: 'paika', captured: [] }],
      totalCaptured: [],
      finalBoard,
      stoppedEarly: false
    });
    return;
  }

  // If both approach and withdrawal captures exist and user hasn't chosen yet, prompt them!
  if (approach.length > 0 && withdraw.length > 0 && !chosenType) {
    state.pendingAmbiguousStep = stepInfo;
    renderAll();
    return;
  }

  const actualType =
    chosenType || (approach.length > 0 ? 'approach' : 'withdraw');
  const captured = actualType === 'approach' ? approach : withdraw;

  if (!state.chainInProgress) {
    state.chainInProgress = true;
    state.chainBoardBeforeTurn = state.board.slice();
    state.chainVisited = new Set([from, to]);
    state.chainSteps = [];
  } else {
    state.chainVisited.add(to);
  }

  state.board = applySingleStepToBoard(state.board, from, to, captured);
  state.chainPieceSq = to;
  state.chainLastDir = dir;
  state.chainSteps.push({ from, to, dir, type: actualType, captured });
  state.selectedSq = to;

  // Check if any further captures are possible from `to`
  const nextCaptures = getInteractiveValidStepsFrom(to);
  if (nextCaptures.length === 0) {
    // Chain automatically finishes when no further captures exist
    finishInteractiveChain();
  } else {
    updateUndoRedoButtons();
    renderAll();
  }
}

/* ============================================================================
 * SVG BOARD & UI RENDERING
 * ============================================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const BOARD_ORIGIN_X = 96;
const BOARD_ORIGIN_Y = 76;
const CELL_SPACING_X = 96;
const CELL_SPACING_Y = 102;

function sqX(sq) {
  return BOARD_ORIGIN_X + colOf(sq) * CELL_SPACING_X;
}

function sqY(sq) {
  return BOARD_ORIGIN_Y + rowOf(sq) * CELL_SPACING_Y;
}

function createSvgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, String(v));
  }
  return el;
}

/**
 * Draw static grid lines and coordinate labels once
 */
function renderStaticBoardGrid() {
  const linesLayer = document.getElementById('board-lines-layer');
  const coordsLayer = document.getElementById('board-coords-layer');
  linesLayer.innerHTML = '';
  coordsLayer.innerHTML = '';

  // Draw connections between intersections
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    for (const { to, dir } of NEIGHBORS[sq]) {
      if (to > sq) {
        const isDiag = dir >= 4;
        linesLayer.appendChild(
          createSvgEl('line', {
            x1: sqX(sq),
            y1: sqY(sq),
            x2: sqX(to),
            y2: sqY(to),
            class: isDiag ? 'grid-line-diagonal' : 'grid-line'
          })
        );
      }
    }
  }

  // Draw small intersection nodes
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    linesLayer.appendChild(
      createSvgEl('circle', {
        cx: sqX(sq),
        cy: sqY(sq),
        r: STRONG_SQ[sq] ? 6 : 4.5,
        class: 'intersection-point'
      })
    );
  }

  // Column labels A-I at top and bottom
  for (let c = 0; c < COLS; c++) {
    const x = BOARD_ORIGIN_X + c * CELL_SPACING_X;
    const topLbl = createSvgEl('text', { x, y: 44, class: 'coord-label' });
    topLbl.textContent = COL_NAMES[c];
    coordsLayer.appendChild(topLbl);

    const botLbl = createSvgEl('text', { x, y: 516, class: 'coord-label' });
    botLbl.textContent = COL_NAMES[c];
    coordsLayer.appendChild(botLbl);
  }

  // Row labels 1-5 at left and right
  for (let r = 0; r < ROWS; r++) {
    const y = BOARD_ORIGIN_Y + r * CELL_SPACING_Y;
    const leftLbl = createSvgEl('text', { x: 52, y, class: 'coord-label' });
    leftLbl.textContent = ROW_NAMES[r];
    coordsLayer.appendChild(leftLbl);

    const rightLbl = createSvgEl('text', { x: 908, y, class: 'coord-label' });
    rightLbl.textContent = ROW_NAMES[r];
    coordsLayer.appendChild(rightLbl);
  }
}

/**
 * Recompute Solver asynchronously (never blocking the main UI thread!)
 */
function recomputeAndRender() {
  cancelActiveSolverJob();

  if (state.editMode) {
    state.solverResult = null;
    renderAll();
    return;
  }

  const activeColor = getActiveColor();
  const depthMs = parseInt(document.getElementById('solver-depth')?.value || '1800', 10);

  // Instant 1-ply move generation (< 1ms) so the UI renders immediately with zero lag
  const immediateTurns = generateAllLegalTurns(state.board, activeColor);
  const immediateRanked = immediateTurns
    .map(turn => ({
      turn,
      score: evaluateBoard(turn.finalBoard, activeColor) + turn.totalCaptured.length * 15
    }))
    .sort((a, b) => b.score - a.score);

  if (state.activeTurnOwner === 'player' && !state.chainInProgress) {
    state.solverResult = {
      bestTurn: immediateRanked[0]?.turn || null,
      rankedTurns: immediateRanked,
      depthReached: immediateRanked.length > 0 ? 1 : 0,
      evalScore: immediateRanked[0]?.score ?? -100000
    };

    // If there are multiple choices, launch the background Web Worker for deep search
    if (immediateRanked.length > 1) {
      if (!solverWorker) createSolverWorker();
      state.solverThinking = true;
      const jobId = ++state.solverJobId;
      solverWorker.postMessage({
        jobId,
        board: state.board.slice(),
        activeColor,
        timeBudgetMs: depthMs
      });
    }
  } else {
    // On AI's turn, 1-ply legal move list is all we need and takes < 1ms
    state.solverResult = {
      bestTurn: immediateRanked[0]?.turn || null,
      rankedTurns: immediateRanked,
      depthReached: 1,
      evalScore: -evaluateBoard(state.board, state.playerColor)
    };
  }

  renderAll();
}

function renderAll() {
  renderHudAndBanner();
  renderBoardDynamicLayers();
  renderBoardActionBar();
  renderAssistantSidebar();
  renderHistoryLog();
}

function renderHudAndBanner() {
  const aiColor = opponentOf(state.playerColor);
  let playerCount = 0;
  let aiCount = 0;
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    if (state.board[sq] === state.playerColor) playerCount++;
    else if (state.board[sq] === aiColor) aiCount++;
  }

  document.getElementById('hud-player-count').textContent = String(playerCount);
  document.getElementById('hud-ai-count').textContent = String(aiCount);

  const playerPieceEl = document.getElementById('hud-player-piece');
  const aiPieceEl = document.getElementById('hud-ai-piece');
  playerPieceEl.className = `score-piece-indicator ${state.playerColor === WHITE ? 'white-piece' : 'black-piece'}`;
  aiPieceEl.className = `score-piece-indicator ${aiColor === WHITE ? 'white-piece' : 'black-piece'}`;

  document.getElementById('hud-player-color-name').textContent =
    state.playerColor === WHITE ? 'White (Light) Pieces' : 'Black (Dark) Pieces';
  document.getElementById('hud-ai-color-name').textContent =
    aiColor === WHITE ? 'White (Light) Pieces' : 'Black (Dark) Pieces';

  const playerCard = document.getElementById('hud-player-card');
  const aiCard = document.getElementById('hud-ai-card');
  const banner = document.getElementById('turn-banner');
  const pill = document.getElementById('turn-phase-pill');
  const instruction = document.getElementById('turn-instruction');

  playerCard.classList.toggle('active-turn-card', state.activeTurnOwner === 'player');
  aiCard.classList.toggle('active-turn-card', state.activeTurnOwner === 'ai');
  banner.classList.toggle('player-turn-active', state.activeTurnOwner === 'player');
  banner.classList.toggle('ai-turn-active', state.activeTurnOwner === 'ai');

  if (state.editMode) {
    pill.textContent = 'CUSTOM BOARD EDITOR';
    instruction.textContent = 'Click intersections to edit pieces, then click Done & Resume.';
    return;
  }

  if (playerCount === 0 || aiCount === 0) {
    const playerWon = aiCount === 0;
    pill.textContent = playerWon ? 'VICTORY!' : 'DEFEAT';
    instruction.textContent = playerWon
      ? 'All Assassin’s Creed AI pieces have been captured!'
      : 'No player pieces remaining. Click Undo or New Match.';
    return;
  }

  if (state.activeTurnOwner === 'player') {
    pill.textContent = state.solverThinking
      ? `YOUR TURN — REFINING (DEPTH ${state.solverResult?.depthReached || 1}...)`
      : 'YOUR TURN — SOLVER READY';
    if (state.chainInProgress) {
      instruction.textContent =
        'Manual capture chain in progress: click next target or End Turn Early.';
    } else {
      const best = state.solverResult?.bestTurn;
      instruction.textContent = best
        ? `Best Move: ${formatTurnNotation(best)} — Follow gold arrows in AC4, then click Apply.`
        : 'No legal moves available.';
    }
  } else {
    pill.textContent = "AC TAVERN AI'S TURN — INPUT AI MOVE";
    if (state.chainInProgress) {
      instruction.textContent = `AI capture chain at ${sqName(state.chainPieceSq)}: click AI's next destination, or click "End AI Turn Here" if AI stopped.`;
    } else {
      instruction.textContent =
        'Watch what the AI plays in Assassin’s Creed, then click that AI piece and its destination (or select from the list).';
    }
  }

  // Update mandatory capture indicator pill
  const legalTurns = state.solverResult?.rankedTurns || [];
  const hasCapture = legalTurns.length > 0 && legalTurns[0].turn.isCapture;
  const capPill = document.getElementById('mandatory-capture-indicator');
  if (hasCapture) {
    capPill.textContent = 'Mandatory Capture Active';
    capPill.classList.remove('paika-mode');
  } else {
    capPill.textContent = 'Paika (Free Move — No Captures Available)';
    capPill.classList.add('paika-mode');
  }
}

/**
 * Render dynamic paths, highlights, pieces, and interactive hit nodes on the SVG board
 */
function renderBoardDynamicLayers() {
  const pathsLayer = document.getElementById('board-paths-layer');
  const nodesLayer = document.getElementById('board-nodes-layer');
  const overlayLayer = document.getElementById('board-overlay-layer');
  pathsLayer.innerHTML = '';
  nodesLayer.innerHTML = '';
  overlayLayer.innerHTML = '';

  const activeColor = getActiveColor();

  // Determine which turn path to visualize on the board:
  // 1. If a turn is hovered/previewed in the sidebar, show `state.previewedTurn`
  // 2. Otherwise, if it's Player's turn (and not in edit mode or manual chain), show `state.solverResult.bestTurn`
  const turnToVisualize =
    !state.editMode && !state.chainInProgress
      ? state.previewedTurn ||
        (state.activeTurnOwner === 'player' ? state.solverResult?.bestTurn : null)
      : null;

  const isPreview = Boolean(state.previewedTurn);

  if (turnToVisualize && turnToVisualize.steps.length > 0) {
    const startSq = turnToVisualize.steps[0].from;
    pathsLayer.appendChild(
      createSvgEl('circle', {
        cx: sqX(startSq),
        cy: sqY(startSq),
        r: 31,
        class: 'solver-start-ring'
      })
    );

    // Highlight all captured enemy pieces with crimson target rings & X
    for (const capSq of turnToVisualize.totalCaptured) {
      const cx = sqX(capSq);
      const cy = sqY(capSq);
      pathsLayer.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 28,
          class: 'captured-target-ring'
        })
      );
      pathsLayer.appendChild(
        createSvgEl('line', {
          x1: cx - 10,
          y1: cy - 10,
          x2: cx + 10,
          y2: cy + 10,
          class: 'captured-x-mark'
        })
      );
      pathsLayer.appendChild(
        createSvgEl('line', {
          x1: cx + 10,
          y1: cy - 10,
          x2: cx - 10,
          y2: cy + 10,
          class: 'captured-x-mark'
        })
      );
    }

    // Draw directional step arrows and step number badges
    turnToVisualize.steps.forEach((step, idxStep) => {
      const x1 = sqX(step.from);
      const y1 = sqY(step.from);
      const x2 = sqX(step.to);
      const y2 = sqY(step.to);

      // Shorten arrow slightly so arrowhead lands cleanly at edge of target
      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy) || 1;
      const tx = x2 - (dx / len) * 18;
      const ty = y2 - (dy / len) * 18;

      pathsLayer.appendChild(
        createSvgEl('line', {
          x1,
          y1,
          x2: tx,
          y2: ty,
          class: isPreview ? 'preview-step-line' : 'solver-step-line',
          'marker-end': isPreview ? 'url(#arrow-cyan)' : 'url(#arrow-gold)'
        })
      );

      // Step number badge at midpoint of arrow
      const mx = (x1 + x2) / 2;
      const my = (y1 + y2) / 2;
      pathsLayer.appendChild(
        createSvgEl('circle', {
          cx: mx,
          cy: my,
          r: 11,
          class: 'solver-step-badge'
        })
      );
      const badgeTxt = createSvgEl('text', {
        x: mx,
        y: my,
        class: 'solver-step-text'
      });
      badgeTxt.textContent = String(idxStep + 1);
      pathsLayer.appendChild(badgeTxt);
    });
  }

  // Compute interactive movable pieces & valid destination steps when clicking on the board
  const validStepsForSelected =
    !state.editMode && state.selectedSq !== null
      ? getInteractiveValidStepsFrom(state.selectedSq)
      : [];
  const validDestMap = new Map();
  for (const s of validStepsForSelected) {
    validDestMap.set(s.to, s);
  }

  // Highlight pieces that can initiate a legal move on the current turn (especially helpful on AI turn)
  const movableStartSquares = new Set();
  if (!state.editMode && !state.chainInProgress && state.solverResult?.rankedTurns) {
    for (const item of state.solverResult.rankedTurns) {
      if (item.turn.steps.length > 0) {
        movableStartSquares.add(item.turn.steps[0].from);
      }
    }
  }

  // Render pieces & intersection nodes
  for (let sq = 0; sq < NUM_SQUARES; sq++) {
    const cx = sqX(sq);
    const cy = sqY(sq);
    const piece = state.board[sq];

    const g = createSvgEl('g', {
      class: 'node-group',
      'data-sq': sq,
      'data-coord': sqName(sq)
    });

    // Subtle ring around movable pieces when it's AI's turn (or when no piece is selected)
    if (
      !state.editMode &&
      state.selectedSq === null &&
      movableStartSquares.has(sq) &&
      state.activeTurnOwner === 'ai'
    ) {
      g.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 28,
          class: 'movable-piece-ring'
        })
      );
    }

    // Selected piece ring
    if (!state.editMode && state.selectedSq === sq) {
      g.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 30,
          class: 'selected-piece-ring'
        })
      );
    }

    // Render Piece if present
    if (piece !== EMPTY) {
      const isWhite = piece === WHITE;
      g.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 23,
          fill: isWhite ? 'url(#white-piece-grad)' : 'url(#black-piece-grad)',
          stroke: isWhite ? '#e2d5be' : '#475569',
          'stroke-width': 2,
          filter: 'url(#piece-shadow)',
          class: 'piece-circle'
        })
      );
      g.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 16,
          stroke: isWhite ? 'rgba(120, 100, 70, 0.45)' : 'rgba(255, 255, 255, 0.14)',
          class: 'piece-inner-ring'
        })
      );
      const coordTag = createSvgEl('text', {
        x: cx,
        y: cy,
        fill: isWhite ? '#3b2f1e' : '#cbd5e1',
        class: 'piece-coord-tag'
      });
      coordTag.textContent = sqName(sq);
      g.appendChild(coordTag);
    }

    // Valid destination marker if a piece is selected and can step here
    if (validDestMap.has(sq)) {
      g.appendChild(
        createSvgEl('circle', {
          cx,
          cy,
          r: 18,
          class: 'valid-dest-marker'
        })
      );
    }

    // Hover ring & generous click hit target
    g.appendChild(
      createSvgEl('circle', {
        cx,
        cy,
        r: 29,
        class: 'node-hover-ring'
      })
    );
    g.appendChild(
      createSvgEl('circle', {
        cx,
        cy,
        r: 34,
        class: 'node-hit-area'
      })
    );

    g.addEventListener('click', () => handleSquareClick(sq));
    nodesLayer.appendChild(g);
  }

  // If there is a pending Approach vs Withdrawal disambiguation, highlight both capture groups on the board
  if (state.pendingAmbiguousStep) {
    const { approach, withdraw } = state.pendingAmbiguousStep;
    for (const s of approach) {
      overlayLayer.appendChild(
        createSvgEl('circle', {
          cx: sqX(s),
          cy: sqY(s),
          r: 28,
          fill: 'rgba(245, 185, 66, 0.28)',
          stroke: '#f5b942',
          'stroke-width': 3
        })
      );
    }
    for (const s of withdraw) {
      overlayLayer.appendChild(
        createSvgEl('circle', {
          cx: sqX(s),
          cy: sqY(s),
          r: 28,
          fill: 'rgba(56, 189, 248, 0.28)',
          stroke: '#38bdf8',
          'stroke-width': 3
        })
      );
    }
  }
}

/**
 * Handle clicking an intersection on the Fanorona board
 */
function handleSquareClick(sq) {
  if (state.editMode) {
    // Board Editor painting
    if (state.editBrush === 'cycle') {
      if (state.board[sq] === EMPTY) state.board[sq] = WHITE;
      else if (state.board[sq] === WHITE) state.board[sq] = BLACK;
      else state.board[sq] = EMPTY;
    } else if (state.editBrush === 'W') {
      state.board[sq] = WHITE;
    } else if (state.editBrush === 'B') {
      state.board[sq] = BLACK;
    } else {
      state.board[sq] = EMPTY;
    }
    renderAll();
    return;
  }

  // Clear any pending disambiguation if user clicks elsewhere
  if (state.pendingAmbiguousStep) {
    state.pendingAmbiguousStep = null;
  }

  const activeColor = getActiveColor();

  // If a piece is currently selected and `sq` is a valid destination for it, execute that step!
  if (state.selectedSq !== null) {
    const validSteps = getInteractiveValidStepsFrom(state.selectedSq);
    const matchingStep = validSteps.find(s => s.to === sq);
    if (matchingStep) {
      executeInteractiveStep(matchingStep, null);
      return;
    }
  }

  // If a capture chain is already in progress, only the chain piece can move
  if (state.chainInProgress) {
    state.selectedSq = state.chainPieceSq;
    renderAll();
    return;
  }

  // Otherwise, if clicking a piece of the active color, select it
  if (state.board[sq] === activeColor) {
    state.selectedSq = state.selectedSq === sq ? null : sq;
    state.previewedTurn = null;
    renderAll();
  } else {
    state.selectedSq = null;
    renderAll();
  }
}

/**
 * Render the contextual action bar directly below the board
 */
function renderBoardActionBar() {
  const bar = document.getElementById('board-action-bar');
  bar.innerHTML = '';

  if (state.editMode) {
    bar.innerHTML = `
      <div class="action-bar-status">
        <strong>Editor Mode:</strong> Click any intersection to customize the board state to match your Assassin's Creed screen.
      </div>
    `;
    return;
  }

  // Case 1: Disambiguating Approach vs Withdrawal on a step that captures both ways
  if (state.pendingAmbiguousStep) {
    const step = state.pendingAmbiguousStep;
    const appNames = step.approach.map(sqName).join(', ');
    const witNames = step.withdraw.map(sqName).join(', ');

    const statusDiv = document.createElement('div');
    statusDiv.className = 'action-bar-status';
    statusDiv.innerHTML = `<strong>Choose Capture Type (${sqName(step.from)} → ${sqName(step.to)}):</strong> Both Approach and Withdrawal captures are possible!`;

    const btnsDiv = document.createElement('div');
    btnsDiv.className = 'action-bar-buttons';

    const btnApp = document.createElement('button');
    btnApp.className = 'btn btn-primary';
    btnApp.textContent = `Capture by Approach (${appNames})`;
    btnApp.addEventListener('click', () => executeInteractiveStep(step, 'approach'));

    const btnWit = document.createElement('button');
    btnWit.className = 'btn btn-cyan';
    btnWit.textContent = `Capture by Withdrawal (${witNames})`;
    btnWit.addEventListener('click', () => executeInteractiveStep(step, 'withdraw'));

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-secondary';
    btnCancel.textContent = 'Cancel';
    btnCancel.addEventListener('click', () => {
      state.pendingAmbiguousStep = null;
      renderAll();
    });

    btnsDiv.append(btnApp, btnWit, btnCancel);
    bar.append(statusDiv, btnsDiv);
    return;
  }

  // Case 2: Interactive Multi-Capture Chain in progress
  if (state.chainInProgress) {
    const whoLabel = state.activeTurnOwner === 'player' ? 'Your' : "AC AI's";
    const statusDiv = document.createElement('div');
    statusDiv.className = 'action-bar-status';
    statusDiv.innerHTML = `<strong>${whoLabel} Multi-Capture Chain at ${sqName(state.chainPieceSq)}:</strong> Click the next blue target square to continue capturing, or end the turn here.`;

    const btnsDiv = document.createElement('div');
    btnsDiv.className = 'action-bar-buttons';

    const btnFinish = document.createElement('button');
    btnFinish.className = 'btn btn-primary';
    btnFinish.textContent =
      state.activeTurnOwner === 'player'
        ? 'End My Turn Here (Stop Chain Early)'
        : 'End AI Turn Here (AI Stopped Capturing)';
    btnFinish.addEventListener('click', () => finishInteractiveChain());

    const btnCancel = document.createElement('button');
    btnCancel.className = 'btn btn-danger';
    btnCancel.textContent = 'Cancel Chain';
    btnCancel.addEventListener('click', () => undoMove());

    btnsDiv.append(btnFinish, btnCancel);
    bar.append(statusDiv, btnsDiv);
    return;
  }

  // Case 3: Player's Turn (Normal)
  if (state.activeTurnOwner === 'player') {
    const best = state.solverResult?.bestTurn;
    const statusDiv = document.createElement('div');
    statusDiv.className = 'action-bar-status';
    const thinkingHtml = state.solverThinking
      ? `<span class="thinking-badge"><span class="spinner-ring"></span>Thinking (Depth ${state.solverResult?.depthReached || 1})</span>`
      : `<strong>Solver Ready:</strong>`;
    if (best) {
      statusDiv.innerHTML = `${thinkingHtml} Perform <code>${formatTurnNotation(best)}</code> in Assassin's Creed, then click Apply.`;
    } else {
      statusDiv.innerHTML = `<strong>Game Over:</strong> No legal moves remaining.`;
    }

    const btnsDiv = document.createElement('div');
    btnsDiv.className = 'action-bar-buttons';

    if (best) {
      const btnApply = document.createElement('button');
      btnApply.className = 'btn btn-primary';
      btnApply.id = 'btn-apply-best-bar';
      btnApply.innerHTML = `✓ Apply Recommended Move &amp; Switch to AI Turn`;
      btnApply.addEventListener('click', () => commitFullTurn(best));
      btnsDiv.appendChild(btnApply);
    }

    bar.append(statusDiv, btnsDiv);
    return;
  }

  // Case 4: AC AI's Turn (Normal)
  const statusDiv = document.createElement('div');
  statusDiv.className = 'action-bar-status';
  if (state.selectedSq !== null) {
    statusDiv.innerHTML = `<strong>AI Piece ${sqName(state.selectedSq)} Selected:</strong> Now click the highlighted blue intersection where the AI moved it.`;
  } else {
    statusDiv.innerHTML = `<strong>Waiting for AC AI Move:</strong> Click the AI piece that moved on the board above, or pick the AI's move from the right-hand list.`;
  }

  const btnsDiv = document.createElement('div');
  btnsDiv.className = 'action-bar-buttons';
  if (state.selectedSq !== null) {
    const btnDeselect = document.createElement('button');
    btnDeselect.className = 'btn btn-secondary btn-sm';
    btnDeselect.textContent = 'Clear Selection';
    btnDeselect.addEventListener('click', () => {
      state.selectedSq = null;
      renderAll();
    });
    btnsDiv.appendChild(btnDeselect);
  }

  bar.append(statusDiv, btnsDiv);
}

/**
 * Render the Right-Hand Tactical Assistant Sidebar
 */
function renderAssistantSidebar() {
  const titleEl = document.getElementById('assistant-panel-title');
  const subEl = document.getElementById('assistant-panel-subtitle');
  const evalEl = document.getElementById('solver-eval-badge');
  const bodyEl = document.getElementById('assistant-panel-body');
  const listTitleEl = document.getElementById('move-list-title');
  const listHelperEl = document.getElementById('move-list-helper');
  const listCountEl = document.getElementById('legal-moves-count');
  const listContainer = document.getElementById('legal-moves-list');

  if (state.editMode) {
    titleEl.textContent = 'BOARD SETUP MODE';
    subEl.textContent = 'Configure any mid-game or opening board state.';
    evalEl.textContent = 'Editor';
    bodyEl.innerHTML = `
      <div class="solver-steps-container">
        <p style="font-size:0.83rem;color:var(--text-muted);">
          • Use the paint brush in the gold banner above to place <strong>White</strong>, <strong>Black</strong>, or <strong>Empty</strong> spaces.<br>
          • If Assassin's Creed placed the middle row in the opposite alternating order, click <strong>Invert Middle Row</strong>.<br>
          • When the board matches your screen, select whose turn is next and click <strong>Done &amp; Resume</strong>.
        </p>
      </div>
    `;
    listContainer.innerHTML = '';
    listCountEl.textContent = '0';
    return;
  }

  const rawScore = state.solverResult?.evalScore ?? 0;
  const displayEval =
    Math.abs(rawScore) > 50000
      ? rawScore > 0
        ? 'WINNING'
        : 'LOSING'
      : `${rawScore >= 0 ? '+' : ''}${(rawScore / 100).toFixed(1)}`;
  evalEl.innerHTML = state.solverThinking
    ? `<span class="spinner-ring" style="display:inline-block;vertical-align:middle;margin-right:5px;"></span>D${state.solverResult?.depthReached || 1} • ${displayEval}`
    : `D${state.solverResult?.depthReached || 1} • Eval: ${displayEval}`;

  const rankedTurns = state.solverResult?.rankedTurns || [];
  listCountEl.textContent = String(rankedTurns.length);

  if (state.activeTurnOwner === 'player') {
    titleEl.textContent = 'SOLVER RECOMMENDATION (YOUR MOVE)';
    subEl.textContent = state.solverThinking
      ? `Deepening search in background (currently Depth ${state.solverResult?.depthReached || 1})... UI remains fully interactive:`
      : `Searched ${state.solverResult?.depthReached || 1} plies ahead. Follow these steps in-game:`;
    listTitleEl.textContent = 'ALL YOUR LEGAL TURNS (RANKED)';
    listHelperEl.textContent =
      'Hover or click any alternative turn to preview its arrows, or click Apply.';

    const activeTurnToShow = state.previewedTurn || state.solverResult?.bestTurn;

    if (!activeTurnToShow) {
      bodyEl.innerHTML = `<div class="empty-history">No legal moves available.</div>`;
    } else {
      const stepsHtml = activeTurnToShow.steps
        .map((s, i) => {
          const capText =
            s.captured.length > 0
              ? `${s.type === 'approach' ? 'Approach' : 'Withdrawal'} capture: removes ${s.captured.map(sqName).join(', ')}`
              : 'Paika (non-capturing move)';
          return `
            <li class="step-item">
              <span class="step-num">${i + 1}</span>
              <div class="step-details">
                <span class="step-coord">Move ${sqName(s.from)} → ${sqName(s.to)}</span>
                <span class="step-meta">${capText}</span>
              </div>
            </li>
          `;
        })
        .join('');

      const earlyStopHtml = activeTurnToShow.stoppedEarly
        ? `<div class="early-stop-notice">
             ⚠️ <strong>TACTICAL EARLY STOP:</strong> Do NOT take the next capture after landing on <strong>${sqName(activeTurnToShow.steps[activeTurnToShow.steps.length - 1].to)}</strong>! End your turn early in Assassin's Creed (press B / Circle / End Turn) to avoid a trap.
           </div>`
        : '';

      bodyEl.innerHTML = `
        <div class="solver-steps-container">
          <div class="solver-summary-box">
            <span class="solver-summary-main">${formatTurnNotation(activeTurnToShow)}</span>
            <span class="solver-summary-captures">${activeTurnToShow.totalCaptured.length} Captured</span>
          </div>
          <ul class="step-checklist">${stepsHtml}</ul>
          ${earlyStopHtml}
          <button type="button" class="btn btn-primary" id="btn-apply-solver-main" style="width:100%;margin-top:4px;">
            ✓ I Played This Move — Switch to AI Turn
          </button>
        </div>
      `;

      document
        .getElementById('btn-apply-solver-main')
        ?.addEventListener('click', () => commitFullTurn(activeTurnToShow));
    }
  } else {
    // AI's Turn
    titleEl.textContent = "INPUT ASSASSIN'S CREED AI MOVE";
    subEl.textContent = 'Record the move the tavern AI just made so the solver stays in sync:';
    listTitleEl.textContent = 'ALL LEGAL AI TURNS (QUICK SELECT)';
    listHelperEl.textContent =
      'Instead of clicking the board step-by-step, you can also click the exact AI turn below:';

    bodyEl.innerHTML = `
      <div class="solver-steps-container">
        <div class="step-item">
          <span class="step-num" style="background:var(--cyan-primary);">1</span>
          <div class="step-details">
            <span class="step-coord">Click the AI Piece on the Board</span>
            <span class="step-meta">All AI pieces that can legally move are ringed in blue.</span>
          </div>
        </div>
        <div class="step-item">
          <span class="step-num" style="background:var(--cyan-primary);">2</span>
          <div class="step-details">
            <span class="step-coord">Click Each Destination Square</span>
            <span class="step-meta">Follow the AI's capture chain. When it finishes, the solver will immediately calculate your counter-attack!</span>
          </div>
        </div>
      </div>
    `;
  }

  // Populate the scrollable list of all legal turns (for both Player and AI turns)
  listContainer.innerHTML = '';
  rankedTurns.forEach((entry, idxRank) => {
    const { turn, score } = entry;
    const row = document.createElement('div');
    const isBest = idxRank === 0 && state.activeTurnOwner === 'player';
    const isPreviewed = state.previewedTurn === turn;
    row.className = `move-row-item ${isBest ? 'best-move' : ''} ${isPreviewed ? 'previewed' : ''}`;

    const capNames =
      turn.totalCaptured.length > 0
        ? `Captures: ${turn.totalCaptured.map(sqName).join(', ')}`
        : 'Paika move (0 captures)';

    row.innerHTML = `
      <div class="move-row-info">
        <span class="move-row-notation">${idxRank === 0 && state.activeTurnOwner === 'player' ? '★ ' : ''}${formatTurnNotation(turn)}</span>
        <span class="move-row-sub">${capNames}</span>
      </div>
      <div class="move-row-actions">
        <button type="button" class="btn btn-sm ${state.activeTurnOwner === 'player' ? 'btn-outline-gold' : 'btn-cyan'}">
          Apply
        </button>
      </div>
    `;

    row.addEventListener('mouseenter', () => {
      state.previewedTurn = turn;
      renderBoardDynamicLayers();
    });
    row.addEventListener('mouseleave', () => {
      state.previewedTurn = null;
      renderBoardDynamicLayers();
    });

    row.querySelector('button').addEventListener('click', e => {
      e.stopPropagation();
      commitFullTurn(turn);
    });

    row.addEventListener('click', () => {
      state.previewedTurn = state.previewedTurn === turn ? null : turn;
      renderAll();
    });

    listContainer.appendChild(row);
  });
}

function renderHistoryLog() {
  const container = document.getElementById('move-history-list');
  if (state.moveLog.length === 0) {
    container.innerHTML = `<div class="empty-history">No moves recorded yet.</div>`;
    return;
  }

  container.innerHTML = state.moveLog
    .map((m, i) => {
      const moveNum = state.moveLog.length - i;
      const badgeClass = m.who === 'player' ? 'you' : 'ai';
      const badgeText = m.who === 'player' ? 'YOU' : 'AC AI';
      return `
        <div class="history-entry">
          <div>
            <span style="color:var(--text-dim);font-family:var(--font-mono);margin-right:6px;">#${moveNum}</span>
            <span class="history-entry-who ${badgeClass}">${badgeText}</span>
          </div>
          <span class="history-entry-move">${m.notation}</span>
        </div>
      `;
    })
    .join('');
}

/* ============================================================================
 * EVENT LISTENERS & INITIALIZATION
 * ============================================================================ */

function initEvents() {
  // Player Color Segmented Control
  const colorBtns = document.querySelectorAll('#player-color-control .seg-btn');
  colorBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      colorBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.playerColor = btn.dataset.value === 'W' ? WHITE : BLACK;
      startNewGame();
    });
  });

  // Who Moves First Segmented Control
  const firstBtns = document.querySelectorAll('#first-turn-control .seg-btn');
  firstBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      firstBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.firstMover = btn.dataset.value; // 'player' | 'ai'
      startNewGame();
    });
  });

  // Solver Depth Select
  document.getElementById('solver-depth')?.addEventListener('change', () => {
    recomputeAndRender();
  });

  // Top Bar Action Buttons
  document.getElementById('btn-new-game')?.addEventListener('click', () => startNewGame());
  document.getElementById('btn-undo')?.addEventListener('click', () => undoMove());
  document.getElementById('btn-redo')?.addEventListener('click', () => redoMove());

  // Switch active turn button
  document.getElementById('btn-switch-turn-now')?.addEventListener('click', () => {
    saveSnapshotForUndo();
    clearInteractiveSelection();
    state.activeTurnOwner = state.activeTurnOwner === 'player' ? 'ai' : 'player';
    recomputeAndRender();
  });

  // Toggle Custom Board Editor Mode
  const editToggleBtn = document.getElementById('btn-toggle-edit');
  const editorBanner = document.getElementById('editor-banner');
  const editBtnLabel = document.getElementById('edit-btn-label');
  const nextTurnSelect = document.getElementById('editor-next-turn');

  function setEditMode(enabled) {
    state.editMode = enabled;
    clearInteractiveSelection();
    editorBanner.classList.toggle('hidden', !enabled);
    editToggleBtn.classList.toggle('active', enabled);
    editBtnLabel.textContent = enabled ? 'Finish Editing' : 'Setup Custom Board';
    if (enabled) {
      nextTurnSelect.value = state.activeTurnOwner;
    } else {
      state.activeTurnOwner = nextTurnSelect.value;
    }
    recomputeAndRender();
  }

  editToggleBtn?.addEventListener('click', () => setEditMode(!state.editMode));
  document.getElementById('btn-finish-edit')?.addEventListener('click', () => setEditMode(false));

  // Editor Paint Brushes
  const brushBtns = document.querySelectorAll('#paint-brush-control .seg-btn');
  brushBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      brushBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.editBrush = btn.dataset.brush;
    });
  });

  // Editor Quick Actions
  document.getElementById('btn-flip-middle')?.addEventListener('click', () => {
    saveSnapshotForUndo();
    state.middleRowInverted = !state.middleRowInverted;
    for (let c = 0; c < COLS; c++) {
      if (c === 4) continue;
      const sq = idx(2, c);
      if (state.board[sq] === WHITE) state.board[sq] = BLACK;
      else if (state.board[sq] === BLACK) state.board[sq] = WHITE;
    }
    renderAll();
  });

  document.getElementById('btn-swap-all-colors')?.addEventListener('click', () => {
    saveSnapshotForUndo();
    for (let sq = 0; sq < NUM_SQUARES; sq++) {
      if (state.board[sq] === WHITE) state.board[sq] = BLACK;
      else if (state.board[sq] === BLACK) state.board[sq] = WHITE;
    }
    renderAll();
  });

  document.getElementById('btn-clear-board')?.addEventListener('click', () => {
    saveSnapshotForUndo();
    state.board.fill(EMPTY);
    renderAll();
  });

  // Keyboard shortcuts for Undo (Ctrl/Cmd+Z) and Redo (Ctrl/Cmd+Y)
  window.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redoMove();
      else undoMove();
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redoMove();
    }
  });
}

window.addEventListener('DOMContentLoaded', () => {
  renderStaticBoardGrid();
  initEvents();
  startNewGame();
});
