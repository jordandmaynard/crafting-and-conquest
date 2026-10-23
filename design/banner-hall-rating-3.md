Method: dual-agent (A: design review, independent · B: detector and browser, independent)

# Banner Hall HUD: third rating (compact dock)

This rating was taken on 2026-10-23. It covers the B-Hud, B-Attack and B-States boards on the [design canvas](https://claude.ai/artifact/RMyjnQByK4CwzZbcFuKN9o) after the dock was cut to about 100 px tall and costs moved into tooltips. It also looks at four space-saving options that haven't been built yet. The earlier ratings are in [banner-hall-critique.md](banner-hall-critique.md) and [banner-hall-rating-2.md](banner-hall-rating-2.md).

## Design health: 27/40 (Good)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | The queue, the "−80 in 5 s" crystal damage and the alerts are excellent. Unit costs only show on hover. |
| 2 | Match with the real world | 3 | Plain verbs. "Fill" is unclear. "People 9/15" works well. |
| 3 | User control and freedom | 3 | Click a queue tile to cancel. Right click or X stops a mode. |
| 4 | Consistency and standards | 3 | Key chips are everywhere. But the empty slot and a locked button both use a dashed border, and the Craft buttons shift sideways between states. |
| 5 | Error prevention | 2 | You only find out you can't afford a unit once its button is locked. Costs aren't visible at a glance. |
| 6 | Recognition rather than recall | 2 | Costs are hover-only. The Clay and Planks swatches look nearly the same. |
| 7 | Flexibility and efficiency | 3 | Q W E R and Z X C V B, control groups 1–9, the idle-worker key, F2 to hide the HUD. |
| 8 | Aesthetic and minimalist design | 3 | Compact. The calm crystal panel is oversized for "all fine". |
| 9 | Error recovery | 3 | "Need 6 more gold for a Barbarian" is specific. |
| 10 | Help and documentation | 2 | There are tooltips and F1, but the tooltips are hover-only and there's no first-run help. |

The scores before were 28/40 and 29/40, but those runs also covered the menu and setup screens. This run covers only the HUD, so the numbers aren't a like-for-like comparison.

## Design specificity

This is authored for this game, not generic:
- the ink and parchment look;
- Craft buttons in your banner colour, with selection actions on parchment;
- team emblems plus minimap shapes;
- a threat state with its own layout, not just a recolour.

The resource ribbon is the one part that still reads like a stock stat strip.

The detector found 21 items (exit code 2). Almost all of them are false positives for this style:
- the bevel insets, flagged as "side tabs";
- the specimen panels on the states sheet;
- the same buttons repeated on purpose across the states sheet.

The browser overlay injected on all three pages and found these real problems:
- tooltips covering the "Train" and "Orders" labels and the "4 more" button;
- the 30×30 queue tiles, which are just under 32 px.

## Measurements

- **Craft labels hit the bevel.** Jordan was right. Every label overlaps the button's bottom lip by 2–4 px. The baseline sits exactly on the bevel edge, and descenders sink in about 3 px. The content (40 px) also overflows the 35 px content box, so every icon gets silently squashed from 24 px to 19 px. "Barbarian" touches its dashed border.
- **Key chips overlap the icons** in all 18 buttons, by about 3 px vertically.
- **Cost on the Train buttons: there is room sideways, not downwards.** A 96–104 px wide button can hold the icon on the left, the name, and an icon-and-number cost line, still 64 px tall. The dock grows from about 1104 to about 1216 px wide.
- **Screen cover:** the calm HUD covers 23.9% of the screen, and the attack state covers 29.6%.
- **Contrast:** nothing fails except the faded "E" chip on the empty slot (1.72:1). That slot is disabled, so it's exempt, but it's a sign the slot reads poorly.

## What's working

1. The button grammar: Craft is your banner colour, Train and Orders are parchment, and a pressed button sinks with an inner ring.
2. The threat state is designed: rival list, direction, unit count, and one key to jump there.
3. Every command shows its key, and locked buttons say exactly what's missing.

## Priority issues

**[P1] Labels sit on the bevel, and icons are squashed.**
- Fix: `.cmd{padding:13px 2px 8px;gap:3px}`, a fixed 20 px icon (`flex:none`), and a 16 px key chip at 2 px from the top right. That leaves the baseline 5 px clear of the bevel.
- Command: polish.

**[P1] Train costs are hidden behind hover.**
- Production decisions happen under time pressure.
- Fix: horizontal Train buttons that show the cost as resource icons and numbers. The resource you're short of is dimmed and marked with the ink warning, not red, because red is a team colour. Tooltips keep only the explanation.
- Command: layout.

**[P1] The Craft buttons move between states.**
- The dock is centred and its width changes with the selection, so Build sits about 60 px further left in the attack state. That breaks mouse memory.
- Fix: anchor the Craft group at a fixed x position, and let the selection area grow to the left.
- Command: layout.

**[P2] The empty slot looks like a locked button.**
- Fix: show it as a flat recessed socket with no key chip, or leave it out.
- Command: clarify.

**[P3] Tooltips cover the section labels and nearby buttons.**
- Fix: open them above the label line, or offset them sideways.
- Command: polish.

## The four space-saving options

1. **Crystal panel shrinks to a gem with a health ring while it's safe: yes.** Keep the rivals as small chips. Let the panel grow downward when the crystal is attacked, so the growth itself is the alert.
2. **Drop the resource labels: no.** The swatches are too alike to go without labels, and the strip sits over the horizon rather than the battlefield. It could be an option for experienced players later.
3. **Show only the Craft buttons when nothing is selected: yes**, as long as Craft stays fixed in place.
4. **Smaller minimap: add a collapse key, but keep it at 180 px or more.** That corner matters little to play, and shrinking it saves little.

## Persona red flags

- **Alex (power user):**
  - The Craft buttons shift between states.
  - Costs need a hover.
  - Three things offer Space for the same jump during an attack.
- **Jordan (first-timer):**
  - Can't see what's affordable before clicking.
  - "Fill" is unclear.
  - The dashed empty slot looks like something you unlock later.
- **Sam (accessibility):**
  - Costs and help are hover-only, and it's unclear whether keyboard focus opens the tooltips.
  - Icons squashed to 19 px are harder to read.
  - On the plus side, teams never rely on colour alone.

## Minor observations

- The "4 ⚠" on gold could read as an alert rather than "low".
- The minimap zoom buttons sit on top of the map image.
- The wording differs: "Need 6 gold" on the button versus "Need 6 more gold" in the alert.
- In the calm state, the event ticker doesn't line up with the dock's left edge.
- The Warrior tooltip says "12 s". The game's training time is 5 s, so the mock is wrong.

## Questions to consider

1. If Craft is always available and always in your colour, should it leave the selection dock and become a fixed hotbar?
2. Could a Train button's cost be the resource icons themselves, dimming whichever one you're short of, so the button is its own affordability meter?
3. Should the calm HUD fade back further until something happens?
