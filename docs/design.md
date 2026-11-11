# Sidecourt design

Sidecourt is a pickleball control room. The browser title is **Sidecourt**. The header uses the Hermit Edge mark and the subtitle **Pickleball Control Room**.

## Palette and type

| Role | Value |
| --- | --- |
| Primary actions and active courts | Forest `#245c46` |
| Canvas | `#f3f6f2` |
| Surface / selected surface | `#ffffff` / `#edf3ed` |
| Text / secondary text | `#192f26` / `#5c7064` |
| Resting / error | `#8a6218` / `#a53c36` |

Use Avenir Next, Avenir and system fallbacks. Keep names readable, use tabular figures for timers and ratings, and pair status colors with text.

## Courts, roster and player display

- Courts, Roster and Reports are the host's three workspaces. Court controls sit with the court they affect. Session settings and the read-only link sit with the session controls.
- At 1024px and above, courts share the surface with staging and waiting. Below that, the queue follows the courts in page flow. Waiting and Back to courts provide keyboard-accessible jumps. Roster and waiting use bounded pages.
- Player names, team separation and the actual timer take priority in each occupied bay. Empty courts use an isometric drawing based on the [USA Pickleball court dimensions](https://usapickleball.org/construction/).
- Match review shows the proposed teams, destination and any approval required. Unknown ratings use a dash. A balance number requires known ratings. Errors say how to recover, and destructive actions require confirmation.
- The player screen keeps the same court and queue hierarchy. A stale connection shows its last update and freezes confirmed timers.

## Motion and accessibility

Motion follows state changes in navigation, court assignment and bounded lists. Use committed positions for shared layout and let dnd-kit own drag transforms. Preserve keyboard focus through native dialogs and respect reduced motion.

The procedural paddle and ball load through Three.js after the workspace. The scene responds to fine-pointer inspection and the transition to play. It renders on demand and has a static SVG fallback. Controls remain available when WebGL is unavailable.

Keep touch targets at least 44px, allow page reflow without fullscreen and use text labels for controls and status.

## Reports

Lead with check-ins, completed matches and completed court time. Use columns for recorded starts, a ranked ledger for time by court and a distribution of completed games across checked-in players. Show precise values with the charts. Active and voided matches stay outside completed totals.

Attendance, match records and linked sessions open on demand. The selected report prints with every record. Charts use the same forest palette and stack on narrow screens.
