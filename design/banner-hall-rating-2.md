# Banner Hall mockups: second rating

This is the second rating of the Banner Hall boards on the design canvas (https://claude.ai/artifact/RMyjnQByK4CwzZbcFuKN9o), taken on 2026-10-23 after the first round of fixes. It covers four boards: B-Menu, B-Setup, B-Hud and the new B-States.

Method: dual-agent. A fresh design reviewer (A) scored the boards without seeing the first report or any detector output. A separate pass (B) ran the impeccable detector, a URL scan and a browser overlay, then took its own measurements in Chromium.

The first rating is in [banner-hall-critique.md](banner-hall-critique.md).

## Scores

| | First rating | Now | Band |
|---|---|---|---|
| Menu + Setup (design) | 25/40 | **28/40** | Acceptable → **Good** |
| HUD (+ States now) (design) | 26/40 | **29/40** | Acceptable → **Good** |
| Technical audit | 10/20 | **14/20** | Acceptable → **Good** |

### Design heuristics

| # | Heuristic | Menu + Setup | HUD + States | Key issue now |
|---|---|---|---|---|
| 1 | Visibility of system status | 3 | 3 | The queue, construction blocker and Mine strip are excellent. The crystal card has no "under attack" state. |
| 2 | Match with the real world | 3 | 3 | "Playing" under Red is vague. "Fill" and "Look" are unexplained. |
| 3 | User control and freedom | 2 | 3 | There's no way to remove a joined opponent, no reset to defaults, and no Quit or Continue on the menu. |
| 4 | Consistency and standards | 3 | 2 | Key chips sit in four different places. Brass means many things. The Mine pick reads as a "T", which is also Rally's key. |
| 5 | Error prevention | 3 | 3 | Locked states say what's missing. The Yellow swatch reads as brown. |
| 6 | Recognition rather than recall | 3 | 3 | Keys are printed everywhere. The "." key chip is nearly invisible. |
| 7 | Flexibility and efficiency | 3 | 3 | "Same as last game", control groups 1–9, idle-worker key. |
| 8 | Aesthetic and minimalist design | 3 | 3 | Reads well over the world. The gold shortfall is said three times, and the HUD covers a lot of the screen. |
| 9 | Error recognition and recovery | 2 | 3 | There's no bad-seed state. Locked Farm shows no reason on the real HUD. |
| 10 | Help and documentation | 3 | 3 | F1, the keys card and inline teaching lines. |
| | **Total** | **28/40** | **29/40** | **Good** |

## What the fixes achieved

- **Contrast is fully fixed.** The browser pass measured 213 pieces of text across the four boards and found no failures. The lowest is 4.84:1.
- **The rolled-up banner bug and the opacity-only disabled states are gone.** The detector no longer reports either.
- **Colour roles now carry meaning.** God powers follow your banner colour (the Red variant proves it), selection actions stay on parchment, and enemy objects carry the enemy banner. The reviewer called this the strongest part of the design.
- **The copy is the other standout.** Examples the reviewer called out:
  - "Need 6 more gold"
  - "3 workers on it · waiting on 6 planks"
  - "To attack: select units, Q, click it"
  - "Any whole number. The same seed makes the same world."
- **The state sheet is complete.** It shows ready, hover, pressed, locked with a reason, can't afford, keyboard focus, and the Mine mode strip.

## Priority issues now

**[P1] Yellow team reads as brown, and brass means too many things.**
- **The problem:** the yellow team colour (#8a5f0e) was darkened for contrast and now looks like the wood rods and leather cloth (about 1.4–1.5:1 against them). Brass, meanwhile, means six things:
  - selected;
  - pressed;
  - the warning "!";
  - gold;
  - building progress;
  - the main button.
- **Why it matters:** a Yellow player would get brown God powers whose brass "on" ring barely shows. Blue and purple also differ only by hue.
- **Fix:**
  - Give Yellow a true yellow cloth with ink text.
  - Move warnings off brass.
  - Add a team emblem (shield, crown, tower, star) to banners, swatches and minimap marks.
  - Add Yellow and Purple rows to the states board.
- **Command:** `$impeccable colorize`

**[P1] The HUD covers about 38% of the battlefield.**
- **The problem:** the bottom band runs nearly edge to edge: event log, selection panel and command card. The minimap column and crystal card take the top corners.
- **Why it matters:** the camera tilts down, so the bottom of the screen is where your own units and blocks are.
- **Fix:**
  - Merge the selection panel and command card into one dock about 170 px tall.
  - Shrink the log to one ticker line that opens on hover.
  - Fold idle workers into the minimap frame.
  - Drop the gold toast when the button already says it.
  - Add a hide-HUD key.
- **Command:** `$impeccable distill`

**[P1] Threats are under-signalled.**
- **The problem:** the crystal card never changes when the crystal is hit. In the event log, "Red scouts seen" has the same weight as "Warrior trained" and sits at the bottom. "Space jumps to the newest" points at trivia.
- **Fix:**
  - Give the crystal card an attacked state (pulse, shake, direction arrow).
  - Show threats in the log with an enemy-colour edge, pinned to the top.
  - Make Space mean "newest alert" everywhere.
- **Command:** `$impeccable harden`

**[P2] Hotkey and glyph learnability.**
- **The problem:**
  - Key chips sit in four different positions.
  - The "." key chip is nearly invisible.
  - The Mine pick reads as "T".
  - Q·E·T isn't a hand-shaped group, because W and R are camera keys.
  - Settings is on "O".
- **Fix:**
  - Put every key chip at the top right inside its button.
  - Draw "." as a large dot.
  - Use an angled pick head.
  - Consider moving the camera to the arrow keys or screen edges, which frees QWER for a real grid.
- **Command:** `$impeccable polish`

**[P2] Setup opponent slots.**
- **The problem:**
  - "Playing" is vague.
  - There's no × to remove a joined kingdom.
  - The dashed fourth swatch has no label.
  - Red is silently missing from the swatches.
- **Fix:** use "Computer · Normal", add a × on joined banners, and label "Random" and "Taken".
- **Command:** `$impeccable clarify`

## Technical audit

| # | Dimension | Before | Now | Key finding |
|---|---|---|---|---|
| 1 | Accessibility | 2 | 3 | No contrast failures and focus rings are designed. Gaps remain: focus is invisible on Setup's hidden radios and checkboxes, and the ink focus ring is low-contrast over the dark world (Start game, Settings). The colour swatches, difficulty chips and group chips can't be reached by Tab. "Medium" looks selected, but none of the size radios is marked checked. |
| 2 | Performance | 3 | 3 | Three animated WebP renders, about 6 MB in total. Fine for mockups; in the game these become GPU renders. |
| 3 | Theming | 1 | 3 | A shared token kit (ink, parchment, brass, `--self`, team and cloth colours) now drives every board. Some hex values remain in the board scripts. |
| 4 | Responsive design | 2 | 2 | Still fixed at 1440×900 with no UI-scale plan. Several controls are under 32 px (swatches, difficulty chips, the Look button, the group chips). |
| 5 | Implementation integrity | 2 | 3 | One coherent kit. The yellow and brass overload is the main drift. |
| | **Total** | **10** | **14/20** | **Good** |

### Detector notes

- **The detector's 16 findings are nearly all intentional or false positives:**
  - 9 are the chunky bevel highlights on panels and buttons, which are the game's look.
  - 2 contrast hits on Setup can't see the banner cloth, which is drawn by CSS pseudo-elements. The browser measures 5.1–5.7:1 there.
  - "Cramped padding" on the live view is a full-bleed picture.
  - 2 "nested cards" are the alert samples shown inside the Alerts panel on the states board.
- **The browser overlay agreed:** it found only the bevels and those two alert samples.

## Persona red flags

- **Alex, the power user:**
  - Q·E·T breaks QWER habits.
  - No shift-queueing or rebinding is shown.
  - The gold shortfall is said three times.
  - "Cancel building" doesn't say whether blocks are refunded.
- **Jordan, the first-timer:**
  - It isn't clear whether "God powers" are done by me or by my workers.
  - The locked Farm on the real HUD shows no reason.
  - The idle-workers event doesn't mention the "." key.
- **Sam, accessibility:**
  - Blue and purple, and yellow and wood, differ by hue alone.
  - The ready and hover God-power buttons look the same in greyscale.
  - Many labels are 12–13 px.

## Questions to consider

- The crystal decides the game. Could it be the loudest thing on screen, with a beacon in the world, an edge arrow and a HUD that changes when it's threatened?
- Are these "God powers", or orders for workers? The name decides how Build, Mine, Fill, Farm and Wall feel.
- Would this HUD survive a four-player Yellow vs Purple game?

## Run notes

- A and B ran as separate sub-agents. A saw neither the detector output nor the first report.
- **CLI detector:** exit code 2, 16 findings. It reported no line numbers.
- **URL scan:** 11 findings, run through a temporary no-sandbox Chromium wrapper (since deleted).
- **Overlay:** injected headless on all four boards.
- **Live server:** stopped. The temp files and the live-server folder were removed, and the targets are unchanged.
