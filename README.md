# Fanorona Tactical Solver — Assassin's Creed IV: Black Flag (Resynched)

Live Companion App: **[https://fanorona-ac.mike10010100.com](https://fanorona-ac.mike10010100.com)** (also accessible via [https://mike10010100.github.io/fanorona-ac-bf-r/](https://mike10010100.github.io/fanorona-ac-bf-r/))

An interactive Fanorona (*Fanoron-tsivy*, 9×5 board) solver and persistent board tracker designed specifically to play your side of the board against the tavern AI in *Assassin's Creed IV: Black Flag* and *Black Flag Resynched*.

## Features
- **Play Either Color & Either Turn Order:** Toggle whether you are playing **White (Light)** or **Black (Dark)** pieces, and whether **You** or the **AC Tavern AI** moves first.
- **Non-Blocking Web Worker Alpha-Beta Solver:** Calculates optimal multi-capture sequences and early-stop traps asynchronously in a background thread so the UI never freezes.
- **Step-by-Step Visual Guidance:** Displays numbered gold arrows (`1`, `2`, `3`...) on the board along with Approach/Withdrawal instructions and warnings when you should **End Turn Early** to avoid AI bait traps.
- **Easy AI Move Input:** Click the AI piece and its destination square(s) directly on the board, or 1-click apply the AI's complete turn from the legal move list.
- **Custom Board Editor:** Set up any mid-game situation with a single click.
