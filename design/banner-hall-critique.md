# Banner Hall mockups: critique and audit

This report reviews the three Banner Hall boards on the design canvas (https://claude.ai/artifact/RMyjnQByK4CwzZbcFuKN9o): B-Menu, B-Setup and B-Hud, as of 2026-10-23.

It follows the Impeccable `critique` and `audit` methods:
- An independent design review (Assessment A).
- A separate detector and browser pass (Assessment B). It ran the detector and measured the boards in a real browser.
- A technical audit.

The boards are static mockups at 1440×900, so the audit judges the mockup markup and what it implies for building the game UI.

Method: dual-agent (A: design review sub-agent · B: detector and browser sub-agent).

## Design health score

The menu and setup flow scored 25/40 and the HUD scored 26/40. Both are in the **Acceptable** band.

| # | Heuristic | Menu + Setup | HUD | Key issue |
|---|---|---|---|---|
| 1 | Visibility of system status | 3 | 2 | The setup preview caption is excellent. The HUD has no power crystal health, idle workers, clock or "power active" state, and the Barracks bar has no number. |
| 2 | Match with the real world | 3 | 3 | "Quick duel", "Who you face" and "Or right click" read well. "Rolled up", the unlabelled "Halves ↔/↕" and "Live" are unclear. |
| 3 | User control and freedom | 3 | 3 | Back and "Click one to cancel it" are good. There's no reset to defaults and no Esc shown on Back or ≡. |
| 4 | Consistency and standards | 2 | 2 | Red and blue each carry several meanings. Start game has no rod. Icons are reused with new meanings: the Workshop hammer is also Build, and the Sandbox bucket is also Fill. |
| 5 | Error prevention | 2 | 3 | Barbarian is dimmed before you click. Setup lets you pick Quarters with two players or roll up every opponent. |
| 6 | Recognition rather than recall | 3 | 3 | Keys and costs are printed on the buttons. The resource ribbon has icons only: wheat is a yellow pill and population is a blue tombstone. |
| 7 | Flexibility and efficiency | 2 | 2 | No Enter to start and no "last settings". The God-power keys B E U G V can't be learned by position. There are no control groups or idle-worker key. |
| 8 | Aesthetic and minimalist design | 3 | 3 | Strong character. Setup has dead space at the bottom left. The selection panel is wide but mostly empty. |
| 9 | Error recognition and recovery | 1 | 3 | No setup error states (seed). The toast names the problem but not the shortfall. |
| 10 | Help and documentation | 3 | 2 | How to play is on the menu. The HUD only has the ? button, and God powers are never explained. |

## Design specificity verdict

**Mostly specific to Mine Wars, with a generic fantasy-parchment layer underneath.**

What belongs to this game:
- Banners on wooden rods.
- Opponents shown as banners you unroll.
- Team banners marking the starts on the map preview.
- The team-coloured Barracks turning on its grass plate.
- 4–5 px ink outlines that echo the toon shader.

What any medieval web game could use unchanged:
- Soft 14 px rounded panels.
- Smooth round-cap line icons.
- Letter tiles in the training queue.

Nothing in the UI's own shapes is blocky. The turning building is the only place the voxel world enters the interface.

**Deterministic scan.** The detector found 5 issues:
- 3 × low-contrast.
- 1 × cramped-padding.
- 1 × nested-cards.

Here is how those hold up against the browser measurements:
- **Two are real:**
  - The "Rolled up" label on the Setup screen.
  - The dimmed Barbarian cost on the HUD.
- **Three are false positives:**
  - A 1.2:1 contrast reading on Setup. The detector can't see the banner fill, which is drawn by a CSS pseudo-element.
  - "Cramped padding" on the live view. The flush edge is a deliberate full-bleed picture.
  - "Nested cards" in the selection panel. That is a normal game-HUD slot layout.
- **Missed by the detector:** both menu banner subtitles fail contrast, at 3.88:1 and 3.38:1.

**Overlay.** The overlay was injected headless on all three boards; there was no visible browser to show it in. The console reported 0 issues on the Menu, 1 on Setup and 1 on the HUD, the same two real contrast problems.

## Overall impression

The banners work. The menu is proud and inviting, and the unrollable opponent banners are the best idea on any board. The weakest points are:
- **Colour roles:** team colours are doing UI work.
- **Missing status:** the HUD never shows the power crystal, which is how you win or lose.
- **A bug from the outline refinement:** the rolled-up banners on Setup now render badly.

The single biggest opportunity is to build the HUD around the crystal and the player's own banner colour.

## What's working

1. **Banners carry team identity.**
   - Rods, cloth and hems are consistent.
   - Rolled-up opponents are an interaction that belongs to this game.
2. **The HUD reads well over a busy world.**
   - Opaque parchment with ink outlines holds up over the greens.
   - The gold shortfall is signalled three ways: the red 4 on the ribbon, the red cost on Barbarian, and the toast.
   - Inline teaching like "Or right click" and "Click one to cancel it" is good.
3. **The setup preview.**
   - The caption "Medium map · mirrored halves · 30% water · fog on" is clear.
   - Map sizes are named by feel ("Quick duel · 128²").
   - There's a dice button for the seed.

## Priority issues

**[P1] The rolled-up opponent banners are broken (B-Setup).**
- **What:** on the short Yellow and Purple banners, "Rolled up" spills past the point onto the panel. The banner outline filter then stamps a smeared ghost copy of the text under it. This is a side effect of the outline-all-round change.
  - The 0.75 opacity makes them look disabled rather than clickable.
  - The label measures 1.8–3.8:1 contrast; the target is 4.5:1.
  - The detector and the design review both flagged it.
- **Why it matters:** it is the setup screen's best idea, and it now looks like a rendering bug.
- **Fix:**
  - Draw the rolled state as a cloth roll under the rod with the name only, at full opacity.
  - Show "+ Unroll" on hover, and keep the text inside the shape.
- **Command:** `$impeccable polish`

**[P1] Team colours double as UI colours.**
- **What:** red means the Red kingdom, but also errors (the toast icon is a red banner), Start game and Play. Blue means you, but also "selected" in setup, progress bars and every God-power button.
- **Why it matters:** mid-battle, a red banner on a toast reads as "Red did something". A player on the Red team gets red errors and red enemies in the same colour.
- **Fix:**
  - Use team hues only for teams.
  - Give the player's own accent its own token, so God powers and own progress follow the chosen colour.
  - Show errors with ink plus a non-team "!" chip.
  - Show selected states as a brass inset.
  - Make Start game gold, or the player's banner colour.
- **Command:** `$impeccable colorize`

**[P1] The HUD is missing status the game depends on.**
- **What:**
  - No power crystal health, for you or your enemies.
  - No idle-worker button, no clock, no event log.
  - No "active" state on Build, Mine, Fill, Farm or Wall.
  - The selection panel shows an unlabelled green bar, with no HP number.
  - Only one selection state is mocked up: no units, multi-select, building under construction or enemy building.
- **Why it matters:** these are the at-a-glance checks of an RTS. The audit board itself recommended a mode banner and an event log.
- **Fix:**
  - A crystal medallion with an HP ring at the left of the ribbon, plus pips for enemy crystals.
  - An idle-worker button by the minimap.
  - Pressed God-power buttons plus a mode strip, for example "Mine: click blocks · right click to stop".
  - "820/1000" on the bar.
  - Mock up all four selection states.
- **Commands:** `$impeccable shape`, then `$impeccable harden`

**[P1] Small text fails contrast.**

| Board | Text | Measured | Target |
|---|---|---|---|
| Menu | "Every block free, build at once" (15 px, on the green banner) | 3.88:1 | 4.5:1 |
| Menu | "Design buildings for your kingdom" (15 px, on the ochre banner) | 3.38:1 | 4.5:1 |
| Setup | Yellow title (19 px, at 0.75 opacity) | 2.05:1 | 4.5:1 |
| Setup | Purple title (19 px, at 0.75 opacity) | 3.04:1 | 4.5:1 |
| HUD | Barbarian cost (12 px, dimmed) | about 3.0:1 | 4.5:1 |

- **Fix:**
  - Darken the green and ochre banner cloth, or give the subtitles a dark plate.
  - Show the disabled state with a lock or strike-through, not opacity.
- **Command:** `$impeccable polish`

**[P2] Hotkeys and the training queue are hard to learn.**
- **What:**
  - The context row is Z X C, keys chosen by position. The God powers are B E U G V, which follow neither position nor initials.
  - Key chips are 10–11 px.
  - Queue tiles show "W", which looks like a hotkey (W pans the camera). A Barbarian in the queue would show "B", the Build key.
- **Fix:**
  - Pick one scheme: a positional bottom row for God powers, or true initials checked against the camera keys.
  - Make chips at least 12 px.
  - Put small voxel portraits in the queue tiles.
- **Command:** `$impeccable clarify`

**[P2] Setup layout and labels.**
- **What:**
  - The symmetry row (Off / Halves ↔ / Halves ↕ / Quarters) has no label and reads as part of Resources.
  - ×1.0 sits at 34% on one slider and 43% on another.
  - Start game hangs from nothing.
  - There's about 130 px of dead space at the bottom left.
  - There's no difficulty setting.
- **Fix:**
  - A "Symmetry" heading with tiny map diagrams.
  - Sliders, symmetry and seed under "More options".
  - A rod for Start game.
  - Difficulty chips (Easy / Normal / Hard) under each unrolled opponent.
- **Command:** `$impeccable layout`

## Persona red flags

**Alex, the power user:**
- Can't touch-type B E U G V.
- No control groups or idle-worker key.
- Cancelling a queued unit needs the mouse.
- No Enter to start and no quick rematch.

**Jordan, the first-timer:**
- Build and Mine are filed under "God powers", so why aren't they on the workers?
- Ribbon icons are guesswork, with only a slow browser tooltip.
- "Rolled up" doesn't say that a click unrolls it.
- Nothing on the HUD says how you win or lose.

**Sam, accessibility:**
- The five contrast failures above.
- No focus style anywhere. Tabbing onto the setup radios and checkboxes changes nothing on screen (measured pixel-identical).
- Queue slots are click-only divs that can't be reached by keyboard.
- Minimap units differ by colour alone.
- The turning view never stops, and there's no reduced-motion option.

## Minor observations

- `[VERSION]` on the menu is still a placeholder.
- There's an extra divider after the population number on the ribbon.
- The power crystal in the menu backdrop is hidden behind the mode banners.
- The Sandbox copy would read better as "Unlimited blocks, instant building".
- The toast should name the shortfall: "Need 6 more gold for a Barbarian".
- The Barracks subtitle repeats the command card.
- The minimap shows no fog even though fog is on.
- Population 9/15 gives no warning near the cap.
- The cream panels cover about a quarter of the screen and are the brightest thing on it, so they pull the eye off the battlefield.
- The "Space" button is named "Look at the Barracks" for screen readers but shows "Space", so the visible label isn't part of its name.

## Technical audit

| # | Dimension | Score | Key finding |
|---|---|---|---|
| 1 | Accessibility | 2 | Icon buttons are labelled and the image has alt text. But there are five contrast failures, no focus styles, and click-only queue divs, and the HUD has no headings. |
| 2 | Performance | 3 | The turning view is a 2.6 MB animated WebP. That's fine in a mockup, but in the game it should be drawn on the GPU. Each banner stacks five drop-shadow filters, which is fine while static. |
| 3 | Theming | 1 | Almost every colour is a hex value written inline. Only the new banner style uses tokens, so the HUD can't follow a Red or Yellow player without rewriting it. |
| 4 | Responsive design | 2 | The HUD is anchored to the corners, which scales well. Setup is a fixed grid. Nothing yet covers 1280×720, 4K or a UI-scale setting. |
| 5 | Implementation integrity | 2 | The system mostly holds together. But the banner filter bleeds onto overflowing text, the setup sliders are styled spans rather than real inputs, and team and UI colours are mixed. |
| **Total** | | **10/20** | **Acceptable** |

**Implementation integrity verdict: pass, with drift.** Panels, ink outlines and banners form one coherent kit specific to this game. The drift is in colour roles and in the one filter bug.

**Patterns that recur:**
- Inline hex colours everywhere.
- Opacity used as the only disabled state, in three places.
- No focus treatment on any board.

**Worth keeping:**
- Real `<button>` elements.
- aria-labels on every icon button.
- `aria-hidden` on decorative SVGs.
- Labels that wrap the hidden inputs, so the whole tile is the click target.

**Recommended actions, in order:**
1. **[P1] `$impeccable polish`:** fix the rolled-up banners and the contrast failures, and add focus rings.
2. **[P1] `$impeccable colorize`:** separate team colours from UI colours and add a player-accent token.
3. **[P1] `$impeccable shape`:** crystal status, idle workers, mode strip and the four selection states.
4. **[P2] `$impeccable clarify`:** the hotkey scheme, queue portraits and toast copy.
5. **[P2] `$impeccable layout`:** setup grouping, symmetry label, difficulty and the Start game rod.
6. Finish with `$impeccable polish`.

## Questions to consider

- What if the player's own banner colour were the UI's only accent, so errors never borrow a team colour?
- What would a HUD built around the power crystal look like?
- Would small voxel renders for icons, queue tiles and units make the UI feel built from blocks rather than parchment with web icons?

## Run notes

- **Assessments:** A and B ran as separate sub-agents. A finished without seeing any detector output.
- **CLI detector:** ran, exit code 2, 5 findings. It reported no line numbers, so locations came from browser matching.
- **URL scan:** needed a temporary no-sandbox Chromium wrapper, since removed.
- **Overlay:** injected headless on all three boards; there was no visible browser.
- **Cleanup:** the live server was stopped and temp files were removed.
- **Snapshot:** this is the first run for these boards, so there is no trend yet.
- **Files:**
  - Screenshots and crops are in the thread scratchpad.
  - The flattened review pages were rendered from the canvas sources by scratchpad `ui/flatten.mjs`.
