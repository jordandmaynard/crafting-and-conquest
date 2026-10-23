# God Game (prototype)

A top-down, isometric-style god game in raw WebGPU. Plain ES modules, no build step, no dependencies.

## Run

WebGPU needs a secure context, so serve the folder over localhost:

```
python -m http.server 8080   # or: npx http-server -p 8080
```

Then open http://localhost:8080 in Chrome/Edge 113+ or Safari 18+.

## Controls

Interface (Banner Hall, 2026-10-23; `ui.css`, `src/hud.js`, the HUD section of `src/main.js`). Where the notes below
name other keys, these win:

- Main menu: Play (Enter, then New game's setup screen), Sandbox (S), Workshop (W, the old Editor), Options (O),
  How to play (F1), Credits (C).
- HUD: top left the power crystals (a new game: calm, a gem in a ring of its health and the rivals'; losing hit points
  in the last HUD_TUNING.attackWindow seconds, the ink alarm with the loss, direction, attackers and Go to it). Top
  middle the resource ribbon (blocks pick the Fill/Wall block; iron, gold, wheat, people, the time; an ink warning on
  what's short). Top right the minimap (M collapses it, kept in localStorage; team marks: blue square, red diamond,
  yellow triangle, purple circle), idle workers (. selects the next), ? (F1) and ≡ (Esc); under it the events: threats
  in ink (units.onHurt) on top, the latest event, "N more". Bottom right the dock: the selection, Train or Orders on
  Q W E R (a building: three units and Rally on R, R again an attack rally, right click Rally clears it), workers'
  Job, and Craft on Z X C V B (Build, Mine, Fill, Farm, Wall), which never moves. Over it the mode bar (what the mode
  does, how to stop) or the Build menu. Tooltips explain each button.
- Camera: arrows, the screen edge (Options; HUD_TUNING.edgePan), middle drag; PgUp/PgDn tilt; right drag orbits.
  Space: the newest alert. L: look at the selection (Shift+L cycles the GI modes). J: watch through a unit's eyes.
- Esc steps back: overlay, armed order, box being drawn, tool, selection, then the pause menu (the game stands still
  while any overlay is open). F1 controls, F2 hides the HUD.
- Sandbox: the tools panel on the left (F3 Raise, F4 Lower, F5 Flatten, [ ] size, I insta-build, O fog, - + speed)
  and units at the cursor: pick one there, N puts it at the cursor (Shift+N a red one). The fps and the GPU/Tuning
  buttons show once T or G is pressed (or with ?dev).

- Main menu (at startup, over the world turning slowly, drawn just as in the game, nothing over it: T > Main menu spin; Main menu in the tools panel goes back to it, starting the
  world over): **Sandbox** is the game as it's always been (villagers at a key press, insta-build, every block free).
  **Editor** is sandbox on flat grass (T > Editor: its height, 16) with no water or trees, no villagers and insta-build on, opening on Build → Save design: for building
  designs, which (kept in the browser) show in every mode's Build menu, a new game's too, with their costs.
  **New game** starts with one worker (T > New game: startWorkers) and an empty inventory (`src/inventory.js`): every
  block blue's workers mine goes into it, stone as 4 bricks and a log as 1 plank (a felled tree's whole trunk; leaves
  give nothing), dirt (grass, sand), bricks and planks as themselves; fireballs' holes give nothing. Its counts are on
  the palette's swatches. Each block a worker places comes out of it, and a worker won't take on placing a block
  there's none of (counting those others are already on their way to place): it digs elsewhere until there's some.
  Every 0.25 s the inventory is shared out over the open orders, oldest first, counting what each digs out itself: a
  building, flatten box or Raise mark it can't cover is drawn yellow (open buildings that are covered are pale, not
  golden), and so are placements and Raise previews past what's left over. No spawn keys, insta-build, Raise, Lower or Flatten in a new game;
  torches are free. The Build menu shows each building's cost under its name (what its blocks are), in yellow where what's left over
  won't cover it. A finished House makes room for POP_TUNING.house (5) more villagers in a new game (see Keep below).
- Patrol (Y, then left click, or the card's Patrol; any unit): attack-move to the point, then back to where each
  unit started (or where its queued orders end), over and over. Shift adds the point to its round: the points are
  walked in order, then back (u.patrol in `src/units.js`, Units.patrol / patrolNext). Any new order (not queued), H or a
  focused attack drops it.
- Possess (J, or the card's Possess; any unit, either team): the camera goes into the selected unit's head (of several,
  the one nearest the camera's target) and watches from its eyes, in perspective, looking where its head looks (its bob,
  nod and turn, eased: an archer shooting side-on looks at its target) as it goes about its business. It's only
  watching: no orders, no panels (the minimap stays, not clickable), and Esc (or J) puts the camera back exactly as it
  was, as does the unit's death. Its head isn't drawn (Units.parts leaves it out and hands its place and way to main.js
  as eyeFrame; T > Possess: hide its whole body), nor its health bar. Camera.fp ({ eye, yaw, pitch }) makes
  `src/camera.js` look from there with POSSESS_TUNING's field of view and near plane (0.05; the depth buffer's float32,
  so far units still sort against the ground), and while possessed the distance fog starts at its own distance, depth
  of field is off (or focused at its own distance) and the camera's target follows the unit (grass, torchlight and GI
  probes round it). The view's damped: the eyes move with only a quarter of the head's bob and lean (headBob), and the
  view turns with 60% of its turn (headTurn) and a quarter of its nod (headNod), eased over 0.2 s. Out of the middle of
  the view, its arms and what they hold are drawn a little lower and further out (armDrop, armOut, armBack, in
  Units.parts), and a possessed worker swings its pickaxe, axe or shovel in its right hand alone, off to its right
  (oneHand, oneHandSide: twoHands' side, its left hand left free). T > Possess has all of these, with the field of view,
  near and far planes, eye height and offsets, look-down pitch, fog, depth of field and hide-body switch.
- Keep and power crystals (a new game): each team's start has a Keep (Jordan's 5 × 5 × 4 design, BUILT_IN_DESIGNS.keep,
  set straight into the terrain with the world by placeKeep in `src/buildings.js`, the ground round it levelled, its
  door towards the middle of the map, its torch lit). Its power crystal (`src/crystals.js`, a unit of kind 'crystal')
  stands on the plinth inside it, where fighters come in through the doors to strike it, but is drawn u.raise higher,
  floating over the hole in the roof (crystalBase), its beam rising from the hole's bottom. Destroying it puts its
  team out (defeat for the player's, victory when every opponent's is gone). T > Power crystal (CRYSTAL_TUNING).
  The player's Keep is a building: it trains workers (8 s, 5 wheat) and gives POP_TUNING.keep (5) population room;
  each finished House adds POP_TUNING.house (5). Training waits while the population's full (shown as Pop on
  the wallet). Dead workers don't come back.
- Carrying (a new game, CARRY_TUNING in `src/jobs.js`, T > Carrying): what a worker digs, fells or reaps goes into its
  arms (8 planks, bricks or clay; 5 iron or gold; 5 wheat), not the inventory; it counts once taken to the Keep (wheat:
  the Keep or the nearest house). What won't fit, or isn't the kind it has, is left in a pile on the ground for later
  trips (Workers.piles, picked up by idle workers of the matching specialization). A worker heads back when it's full,
  or has nothing left to do. It holds its load in front, leaning back (CARRY_LOOK in `src/units.js`).
- Walls (`src/walls.js`, god panel Wall, F9, T > Walls): drag a straight line (x, z or diagonal) over the ground and
  let go: an order for a wall WALL_TUNING.height (3) high of the palette's planks (wood) or bricks (stone; not clay),
  its foot following the ground. Each column is a section owned by the team that ordered it; built, it's a unit of kind
  'wall' (never drawn, never picked as a unit: main.js targetAt finds it from the terrain) with woodHp / stoneHp hit
  points. Fighters only go for walls when told to; knocked down, a section's blocks crumble out. No one mines it, its
  own team included (jobs.js work; main.js mineOrder also leaves out buildings' blocks), and fireballs hurt it instead of blowing it apart (terrain.applySphere keep). Along the outer face,
  torch, blank, banner, blank, torch (WALL_TUNING.every 4), spaced over the ground across all the team's walls (Walls.order, near), however they were drawn, turn or cross: banners hang down the face in the team's colour, pointed.
- Team colours (render.js BLOCK_TUNING, T > Ground): Terrain.owners holds, per column, the team that last put a block
  down there (jobs.js work and insta finish, Keeps at the start; OWNER blue 1, red 2, yellow 3, purple 4), uploaded to
  the renderer's r8uint owners texture. A team's bricks, clay bricks and planks are drawn in its own colour for each
  (brickBlue ... plankPurple, 12 in all) in place of the texture; bevels, normal maps and toon seam strokes stay.
  Editor: the tools panel's Team row (Plain / Blue / Red / Yellow / Purple) shows everything built as that team, and
  what's built from then on (Terrain.ownAll, ownAs), to try the colours.
- Banners (`src/banners.js`, Editor Build menu: Banner 1 / 2 / 3): a click on the side of a block hangs a banner 1, 2
  or 3 voxels long down it (again takes it down); always in the colour of the team that built that block's column
  (Terrain.owners; none: plain cloth). Saved with designs (design.banners [[a, b, k, wa, wb, h]], plan.banners), hung
  at once when the building's finished (and on each Keep at the start). The walls' banners use the same bannerParts.
- Ladders (`src/ladders.js`, T > Ladders): a worker that can't get back to the Keep (or where it was sent; in sandbox,
  one hemmed into fewer than `trapped` cells) builds a ladder for free, freestanding up the middle of open cells, as
  high as it takes to step off (or onto an old ladder) somewhere it can get home from: the fewest rungs nearest it. It
  fixes a rung at a time as it climbs; the others idle down there follow it up. Only workers climb them
  (Units.findPath's climb flag); a rung goes when its cell's filled.
- New game setup (main menu → New game): map size (Small 128 × 128, Medium 256 × 256, Large 512 × 512, Huge 1024 × 1024, all 128
  high; MAP_SIZES in `src/terrain.js`), 0-3 opponents, and symmetry, turned like League of Legends' map (none; X or Y:
  the far half is the near half turned half round, so opposite corners match; both: each quarter is the first turned
  a quarter more, so all four corners match; Terrain.mirror, after the trees are planted). The ground's noise is
  blended with its turned copies over SYM_BAND (24) voxels either side of each seam, so the land runs on smoothly
  across it rather than meeting at a cliff, and trees keep 4 voxels off the seams (Terrain.nearSeam). Terrain:
  Mountainous (×0.25-2.5, how high the land rises over the water) and Water coverage (0-90%, default 30: the
  elevations are bent, lowest and highest staying put, so that share of the map is under the water) and Resources
  (×0.25-2, default 1: how many trees and how much iron and gold. Ore's thresholds are moved to the noise's quantile
  so that many times the stone is over them (`abundant` in `src/terrain.js`, iron's nudged for the gold that takes its
  place); each tree spot's chance is scaled, and where that's over 1 the rest is the chance of a second tree in the
  cell, 3 voxels clear of any trunk. Measured over ten seeds on Medium: ×0.25 gives 0.27 trees, 0.26 iron, 0.25 gold;
  ×2 gives 1.96, 1.96, 2.0). Land bridge
  (on by default; landBridge in `src/terrain.js`): each start gets a flat pad (BRIDGE_PAD 5) and, while a start can't
  be walked to from the player's, the cheapest way there is laid three columns wide, filled to just over the water
  and graded to steps of one voxel (cut as much as filled), with no trees on or beside it (Terrain.bridged). All three
  keep the symmetry (the heightmap is made symmetrical before the voxels, the bridges laid on every turned copy).
  Start reloads the page with
  `#new=1&map=…&opp=…&mirror=…&mount=…&water=…&res=…&bridge=…` in its address (kept in localStorage as god-game-setup, so
  the screen opens on the last game's settings next time, as the seed and Random are kept): SIZE is read from it before anything is made (everything sized by
  the map follows), and the game starts straight away. The player (blue) starts near one corner; each opponent (red,
  yellow, purple: each its own side, fighting the others too; the strength bar counts them all on the right) at another corner, the player's start turned round where the map's symmetrical that way, else the
  nearest flat dry grass to it. Opponents have one worker each, which does nothing for now, and the player's orders
  only go to blue (Units.controls). Main menu (tools panel) goes back to the 500 × 100 × 500 sandbox world. The
  huge map takes several seconds to make and asks the GPU for its biggest buffers.
- Control groups (`src/groups.js`): Ctrl (or ⌘)+0-9 makes the selected units that group (with nothing selected:
  disbands it), Shift+number adds them to it, the number selects it (twice quickly: the camera goes to it). One member
  carries the group's banner on a pole on its back, its team's colour with the number on both faces in a pixel font
  (T > Banners); clicking the banner selects the group too. When its bearer dies another member takes it up; with none
  left, the group's gone. (The tools and modes moved from the number keys to F1-F6, knight and scout to F7/F8.)
- F3: Select tool. Left click a villager to select it (of either team), or drag a box (Shift adds to the selection);
  double click one to select every one of its kind and team on screen; Esc deselects.
  Left click only ever selects, and right click only ever moves or attacks (workers too: all they're told is move,
  stop and patrol). Work is open orders, from the god panel: Build (F5), Mine (E), Fill (U) and Farm (F6). Mine: click any block or
  tree, or draw a box in steps (drag a line, held to x or z, whichever the drag is nearer; release and move to stretch it
  the other way; click, then move up or down for its height; click again to give the order) to dig
  everything solid in it but leaves (a tree is felled from its bottom log, and its whole trunk, not its leaves, is
  marked red, trunkLogs in `src/trees.js`; a click or box mines just the ore it's given, and Shift+click on iron or
  gold ore marks its whole vein, on a tree its whole forest (forestOf in `src/trees.js`: trees with trunks within
  forestLink voxels of each other, chained; T > Forests), withVeins in main.js;
  the one shared MineJob in `src/jobs.js`, `mines` in main.js). Fill is for empty voxels, filled with the palette's
  block (in a new game from the inventory, yellow where it's short): click a face for the voxel in front of it, or
  draw a box the way Raise does (marked on the shared sculpt job, as Raise marks). Neither needs anything selected.
  Both are modes: on with their key or button, every click or box adds to the open orders (as if Shift were held), and
  they stay on till right click, Esc, their key or button again, or another mode (the other one, a tool, Q, Y...);
  Delete clears their marks under the brush. Like buildings, their columns are taken on by idle
  blue workers, each the column nearest it, but only within WORK_TUNING.jobRange (30 voxels across the ground; T >
  Worker: Job range) of it, for every kind of order (flatten boxes, Raise marks and torches too): a worker further off
  stays idle till it's moved nearer. Mine, Fill and the tools (Build, Raise...) are exclusive: arming Mine or Fill goes
  back to Select, and picking a tool disarms them. A move order, H or death calls a worker's work off. Open orders
  (buildings, Mine, Fill and Raise marks, flatten boxes, torches) are drawn all the time, whatever the tool and
  whatever's selected, as ghost cubes.
- Farm (F6, `src/farm.js`): a mode like Mine and Fill: click a grass or dirt top (above the sand, open to the sky: no
  tree, block or building on it), or drag a box over the ground (on the plane of the top first pressed, up to 64 × 64
  columns; every farmable column top in it), to mark farms, drawn as gold slabs. An idle worker within the job range
  walks over and tills each one with a hoe (FARM_TUNING.tillTime), turning its block into BLOCK.FARM: tilled rows on
  top (`textures/tilled.png` and `tilled-normal.png`, placeholders made by `tools/tilled.mjs` for Jordan to repaint:
  plain darker dirt, and a normal map of only three soft rounded ridges along x, one repeat a voxel), dirt on its sides; dug out, it gives dirt. Wheat's sown as it's
  tilled and grows over FARM_TUNING.growTime (30 s): sprouts, then leaves and stalks shooting up, ears coming and the
  green turning gold. Ripe, it waits for an idle worker within the job range, who reaps it with a sickle
  (FARM_TUNING.reapTime) for FARM_TUNING.yield wheat into a new game's inventory (listed at the top of the wallet, over
  iron and gold; sandbox has no inventory), and the farm's sown again, so a field keeps cropping till it's cleared.
  Delete clears farms under the brush (tilled ones back to grass); insta-build tills marks at once. A farm built over
  stops growing (and isn't drawn) till it's open to the sky again; one dug out goes. All farms are one shared open
  order (FarmJob), its columns re-listed four times a second (Farms.update: marks to till, ripe wheat). The wheat is
  drawn like the grass tufts: per farm 3 rows × 4 clumps on the ridges (none on a bevelled open edge: clumps whose foot is within the bevel + 0.08 of an open side are skipped, so none hang out over it and the density stays even), each an upright camera-facing quad with two
  leaves and three stalks (and ears with whiskers) cut out in the fragment shader, outlined, lit with the ground's sun
  shadow; how grown it is comes from the farm's sowing time and the clock on the GPU. T > Farming has the times, yield,
  height, width, sway and colours; the tilled texture's normal strength is in T > Normal maps. The rows are drawn in toon shading too (like bricks' and planks' bevels); the ground's own normal maps and texture tiling are no longer in the T panel.
- Command card (bottom right, StarCraft style): what's selected, by team and class, and its commands with their keys:
  Move (then left click; or right click), Stop (H), Patrol (Y), Possess (J), and Attack (Q: attack-move) for anything that fights;
  hidden with nothing selected. With blue workers selected, a row of specializations under their commands (u.spec;
  SPECS and specFor in `src/jobs.js`; the highlighted one is theirs when they share it): Worker (the default) takes
  any open order; Lumberjack only fells trees (a Mine or flatten order's logs), Miner only digs (Mine, Lower, flatten),
  and an idle Lumberjack or Miner with no such order near finds its own work (Workers.seek in `src/jobs.js`): the
  nearest tree, or iron or gold ore open to the air (never plain stone), within seekRange it's seen, marked on the
  Mine order, so it works its way through a forest or along a vein (one it can't reach it leaves; no carrying home yet),
  Builder only places blocks (buildings, Fill, Raise, torches), Farmer only tills and reaps. A click sets it for all
  the selected workers, and one on a job of another kind drops it. Under it, always open, the god panel (headed God; GOD_CARD in `src/main.js`, both in
  `#cards`): Build (F5), Mine (E), Fill (U) and Farm (F6), open orders for the idle workers near them. In sandbox, a click on a tree with Flatten still posts it for any idle worker to fell.
- Right click (without dragging, any tool): send the selected villagers there, or after an enemy clicked. Shift+right
  click queues a waypoint after their current orders (shown as goal rings)
- Q then left click (any tool): attack-move. The selected villagers go there but fight the enemies they meet on the way
  (each carries on once its enemy's dead); on an enemy, they attack it. Shift+Q-click queues it and stays armed;
  right click or Esc calls it off. H: the selected villagers stop and drop their orders
- New villager at the cursor: N a worker (takes building jobs with the right tool, never fights), B a warrior (steel helmet with a
  plume in its team's colour, a pauldron on its sword arm, boots, sword in hand, never builds, defends when an enemy comes within aggro range), V an archer (bow and quiver; shooting, it stands side-on, bow out to its left and head turned to its target, and shoots any enemy
  in bow range; told to attack one further off, it walks to its bow's range first), C a spearman (winged helmet, throws a big spear
  overhand: slower and shorter-ranged than a bow, but 12 damage), X a fire mage (pyramid wizard's hat in its team's colour,
  staff with a glowing red orb, casts fireballs), Z a priest (monk's hood in its team's colour, staff topped with a gold
  ankh; never attacks: it channels a beam of light from the ankh into the most hurt of its side within healSeek (20)
  voxels, 2 hit points every 0.5 s while they're within beamRange (10), walking to get in range; the beam is light,
  bright enough to bloom, never outlined, giving off glowing plasma wisps (puffs.js plasma); two priests never heal
  the same one, so the next goes for the next most hurt, and a spare one stands idle; changing target, its beam waits
  switchTime (1 s); T > Priest), K a barbarian (bare-chested with crossed leather straps and an iron boss, shorts and headband in its team's colour,
  double-bladed axe; with an enemy within whirlRange it whirls, spinning with its axe held out level (its blade leaving a fading
  trail), hitting every enemy within axeReach every whirlTime seconds; T > Barbarian). With Shift, a red one; M: a red
  warrior (red ones are ordered like blue ones for now, but never take on jobs). Villagers walk through each other but
  never stop on a square another has stopped on or is heading to (one that ends up on another's steps off). A hurt villager, of either side, shows
  a health bar over its head (after neon-haze's: its team's colour as far as its hit points go, the part just lost
  pulsing hot for a moment, then shrinking; T > Health bars); at full health it has none.
  Every villager has its own hairstyle (eight unisex ones: buzz, crop, spiky, mop, ponytail, bun, braid, long), hair
  colour (seven) and skin tone (five), picked by its id. Hair stays under helmets, hats and hoods (what hangs below the
  back of the head shows under a helmet or hat, the rest is hidden), and an archer's or barbarian's is cut above its
  quiver or resting axe. T > Looks gives everyone one style, colour or tone to compare, and edits the colours.
  Warriors go for the nearest enemy within aggro range (except one walking where it was sent). Anyone but a worker who's
  hit turns on the attacker however far off it is (ranged ones walking up to their own range first), and brings a friend: its fighters within 10 voxels turn on the attacker too (they only call others once they're hit themselves);
  workers never fight. Right clicking (or Q-clicking) a villager of another team sends the selected fighters
  after it from any distance. Left to themselves, fighters spread their blows: each picks the nearest enemy, counting
  every ally already on one as spread voxels further, switches to one retarget voxels nearer now and then, a melee
  one finds another when its target's sides are all taken, and a ranged one passes over an enemy its side's shots in
  flight will already kill (those you send after one stick to it). It's rock-paper-scissors: melee (warrior 70 hit points, a sword blow 3 a second, slashing
  diagonally, forehand then backhand, turning and stepping into each cut; barbarian 75) beats bows and spears (archer 18, an arrow 6; spearman 30, a spear 12), which beat mages (12), whose
  fireballs take 35% of an enemy's full hit points within a voxel of the burst, falling off to 10% at the blast's edge, so they beat melee. A blow flashes its target white, holds it
  still a moment (hit-freeze) and knocks it back a little (T > Hit feedback). One out of hit points is
  knocked over and tumbles (a rigid body with its arms and legs swinging on ball joints at the hips and shoulders, forward and back and out to the side, in `src/ragdoll.js`; about one
  in five loses its head, one in ten a sandal, and what it held, tool, sword, bow or torch, drops and scatters as boxes
  of their own), lies there a while and is gone. Several attackers spread round their enemy, a side each and then the
  corners, rather than striking from the same square.
  Archers hold their fire while they walk where they were sent; standing, they shoot (an arrow every 1.2 s, flying an
  arc) at the nearest enemy they can see within 20 voxels (over a wall up to two blocks high right beside them, such as
  battlements). Told to attack one further off, an archer walks towards it until it can shoot it. One arrow in five
  misses and sticks in the ground beside the target; the rest stick in it at a random spot (and stay in its ragdoll
  when it falls), for 5 s either way. Spearmen do the same with spears (one every 3 s, out to 16 voxels): a spear goes
  halfway through whoever it hits and stays there, part of its ragdoll, colliding with the ground. Fire mages cast a
  fireball every 2 s, out to 16 voxels; it bursts on its target or on the first ground it meets, blowing a hole 2
  voxels round (any voxels, not the bedrock) and taking fireDamage (35) per cent of every enemy's full hit points in it, and flings the fallen
  nearby about. Its burst is fire and smoke sprites (`src/puffs.js`, after space-miner's explosion puffs, with its
  four dust sprites in textures/), soft where they meet the ground; a fireball in flight trails fire and smoke. The ground round the hole glows red-hot, cools, and is left charred: a sphere of char round the blast, with a blast mark (textures/blast.png) projected along the way the fireball flew (`src/scorch.js`, after space-miner's charred rock; SCORCH_TUNING in T > Explosions). How hard each weapon's killing blow knocks a body away, up and over is its own (RAGDOLL_TUNING).
  (COMBAT_TUNING in units.js)
- F4: Flatten. Drag a box; its plane starts at the top of the block the drag started on (or the ground under a tree),
  and the wheel moves it up and down while dragging. Idle villagers dig out everything above the plane and fill
  everything below it with the block selected in the palette when the box was drawn. Any number of boxes can be open at once, and
  each idle villager works on the nearest; Delete cancels the box under the cursor. Villagers carry the tool for
  their task: a shovel for earth (digging or filling), an axe for trees and a pickaxe for stone. The voxels to dig
  are red and the ones to fill are see-through green
- F5: Build. Pick a building from the menu (the built-in designs below; House and Big house are gone, `housePlan`
  and `bigHousePlan` are kept but not offered), or a Torch: click the top of a block for
  one standing up or the side of one for one leaning out of the wall (one per voxel), and a villager sets it and click to place
  it: its ghost is pale where it fits (flat ground, nothing in the way) and red where it doesn't, and the door faces
  the camera. Placing one goes back to the Select tool (Shift keeps the Build tool, to place more). Idle villagers then build it block by block, with hammers; Delete cancels it
- Built-in designs (BUILT_IN_DESIGNS in `src/buildings.js`, made in the editor by Jordan): House (18 planks, and a dirt chimney: 4 dirt), Barracks, Archery range, Mage tower and Lookout tower, with their
  torches. The Lookout tower sees nothing itself (BUILDING_SIGHT 0); a unit standing on its platform (the design's
  `platform` layer, plan.platform) sees LOOKOUT_TUNING.boost (2) times as far (sightOf in main.js; T > Fog of war).
  The hut makes room for more villagers (see Keep); dead workers are gone for good.
- Finished buildings: click one (any of its blocks, Select tool) to select it on its own, outlined in its team's colour
  round its silhouette only (`src/outline.js`: a screen pass over the terrain's G-buffer, each pixel's hit voxel
  looked up in a bit set of the building's blocks; the line runs along the ground too, never between its blocks). Its command card trains units
  (BUILDING_ACTIONS in `src/buildings.js`): Barracks a warrior (5 s) or barbarian (10 s), Archery range an archer (5 s)
  or spearman (10 s), Mage tower a fire mage (5 s) or priest/healer (10 s). Up to 5 queue; click one in the queue to
  cancel it; the first shows its progress. Each comes out at the building's spawn point facing its arrow (waiting while
  it's blocked) and walks 3 voxels out. A building stops being one once fewer than half its
  blocks are there. T > Production: the times. In a new game training costs (TRAINING_COST in `src/buildings.js`, T > Training costs): warrior 5 gold + 10
  iron, barbarian 10 gold + 15 iron, archer 5 gold + 10 planks, spearman 10 gold + 15 planks, fire mage 10 gold,
  priest (healer) 15 gold; taken when it's queued (a toast says what's short), given back when it's cancelled; shown
  on each button, yellow where the inventory's short. Free in sandbox.
  Rally (a building that trains): right click (or the card's Rally, then left click) sets where what it trains goes;
  Q then left click (the card's Attack rally) a waypoint they attack-move to; Shift adds a waypoint after the others
  (a mix of the two is fine); H (Clear rally) drops them. Shown while it's selected as posts with flags (blue a move,
  red an attack-move) joined by a dotted line along the way a unit walks there from its spawn point (units.findPath,
  found again every second). Selected patrolling units show their patrol the same way, in yellow: a flag at each point, the
  way round them (they stay put: none follows the unit as it walks). Without one, a unit walks 3 voxels out of the door. A saved copy with the same blocks is dropped from the saved ones.
- Build → Save design: drag a box around something built (like a Raise drag: footprint, release, height, click),
  then name it. It joins the Build menu (× deletes it) and places like the houses: facing the camera the way it
  faced the camera when saved, on any flat solid surface (ground, stone, planks, bricks; not leaves) with all of its bounding box empty. Designs are kept in the browser
- Build → Spawn point (Editor only, `src/spawns.js`): click the top of a block for a glowing blue plate a third of a
  voxel high with an arrow on it, facing the camera; click it again to turn it a quarter, Del removes it. Save design
  keeps the one in its box (a box round more than one isn't saved) as the design's spawn, its cell and facing turned
  with the design; once a building with a spawn is built, a blue worker comes out there, facing the arrow (the House's
  is its middle, facing out of the door). T > Editor: its colour and glow.
  A building with a spawn point is placed turned so its unit comes out facing the camera (others: front to the camera).
  A building with a spawn point only fits (pale, not red) where its unit could walk out of it once it's built
  (canExit in `src/buildings.js`: a search over standable cells, the plan's blocks in place, to one outside its footprint).
  Save design keeps the torches in its box too (standing or leaning out of a wall, turned with the design); when a
  building with torches is finished, they're posted as torch jobs for a worker to set (shown as markers while placing).
- Block palette (bottom of the screen): the block Flatten fills with and Raise adds (dirt,
  bricks or planks)
- T panel → Torches: villagers carry a torch in the left hand once the sun is low; its colour, strength, reach,
  flicker and the sun angle it lights at are tunable
- T panel → Ground: texture tiling, 1-5 voxels per repeat of the grass, dirt, sand and stone textures, the top edge
  bevel (0-1 voxel: exposed top edges of ground and stone cut at 45°; 0 = sharp, 1 = 1-high steps become slopes) and
  the upright corner bevel (0-0.5 voxel, 0 = off)
- T panel → Normal maps: each texture's normal map strength (0 = flat)
- Left click with Raise or Lower: mark ground for villagers to fill in or dig out (Shift inverts it), a cube of
  voxels on the grid (Size, or [ ], sets how many across, 1 by default); the cursor
  previews the voxels as green (fill) or red (dig) see-through cubes, and Delete clears marks under the brush
- Left drag with Raise or Lower: draw a box. Drag its footprint, release, move the mouse up or down to its height,
  up to 32, and click: villagers fill what's empty in it with the selected block, or dig it out, for walls, trenches,
  pits and tunnels; Esc cancels
- F1 / F2: Raise / Lower tool; [ ]: brush size (or the slider)
- Right drag: orbit about the vertical axis and tilt (tilt is clamped to 25–85°)
- Middle drag or WASD / arrows: pan; R F: tilt; wheel or + -: zoom (in sandbox, + - set the game speed instead)
- P: toggle perspective (30° FOV) / orthographic
- I or the Insta-build button: edits (Raise, Lower, boxes, Flatten, buildings, torches, felling a tree) happen at
  once instead of becoming jobs for the villagers.
- Slow motion (sandbox, for filming): - and + step the game speed down or up by 0.1, from 0.1 to 1 (also T > Time of
  day > Game speed). Everything slows but the camera: units, ragdolls, fire and smoke, water, the clock, flickers and
  glints (main.js GAME_SPEED; the frame's dt is the game's, realDt the camera's).
- Sound (src/audio.js): every sound is synthesized in the browser (no sound files), starting on the first click or
  key. Fights (swings, hits, bows, spears, fireballs, explosions, heals, bodies and gear landing, horses' hooves,
  crystals), work (picks, axes, shovels, hammers, blocks breaking and set down, trees creaking and crashing, pebbles,
  tilling and reaping, footsteps by ground), the world (water near the camera, wind rising as it pulls back, crickets
  at night, flames, whirling axes, the crystals' hum) and the interface (selecting, orders, training, errors, "under
  attack" for the player's units out of sight, victory and defeat). Sounds fade with distance from the camera and off
  the screen, pan left or right, are silent where the fog hides them, are capped at T > Sound > Sounds at once, and
  slow and drop in pitch in slow motion. Voices (grunts, death cries, the horse's neigh, units' replies to orders) are
  hooked up but silent for now. T > Sound has the volumes and the rest; Sound: combat, work, world and interface have
  each sound's volume and pitch.
- Seed (New game's setup screen): type a number or any text, or turn Random on (remembered) to roll a new seed at
  Start; the seed used is shown there next time (the page reloads with `#seed=...` in its address; the last seed is
  remembered, and the menu, sandbox and editor use it). The camera starts over the dry land nearest
  the middle.
- T: tuning panel: time of day (and a clock speed to let it run), latitude and season, sunlight and skylight
  colour and strength, exposure, haze, clouds, fog, a few water settings, bloom and depth of field, combat and the ragdoll. "Copy" puts the
  values on the clipboard
- /: hide or show the help panel (remembered)
- G: profiler panel (fps, GPU, GPU ms per pass, CPU ms per part of the frame)
- Minimap (top right, `src/minimap.js`; the stats line and the profiler sit below it): the map from straight above,
  each column its highest block (overhangs show their top), coloured by block (grass, sand, stone and ore, trees,
  bricks and planks, the sea bluer the deeper it is) and lit by its height and slope; finished buildings as their
  footprints and every villager as a dot, in its team's colour (blue, red, yellow, purple; the selected ringed white);
  the camera's view as the outline of the ground on screen. It scales to the map's size. Left click or drag: the
  camera goes there. Right click: the selected villagers go there (on another team's dot: the fighters attack it;
  Shift queues; with a building selected, its rally point); Q (attack-move), Y (patrol) or the card's Move, then a
  left click on it, works as in the view. Ctrl (or Cmd) and drag: selects the dots in the box, Ctrl+click one dot
  (Shift adds). Wheel: zooms on the point under the cursor (the + and − buttons on the middle); zoomed in, middle drag
  pans it, and it slides along as the camera moves. Each order pings it (green a move, red an attack). Edits show as they happen
  (`Minimap.dirty`, from every edit's hook), with a row a frame re-read besides. T > Minimap: on/off, size, turning
  with the camera (0 fixed with x right and z down, 1 the view always up), zoom, dot size, shading, colours.
- Fog of war (`src/fog.js`; on or off in the New game setup, on by default; O or the tools panel's button in sandbox,
  for blue): worked out per team, every 0.02 s, a byte per column: never seen, seen before, seen now. A villager sees
  out to the further of its weapon's range and 10 voxels (archer 20, spearman and mage 16), a finished building its
  kind's sight round its footprint (BUILDING_SIGHT in buildings.js: hut 5, barracks and archery range 7, mage tower 10; designs saved in the editor 10,
  FOG_TUNING.buildingSight; all in T > Fog of war), both further over lower ground and less far up higher: each
  column's height (its highest voxel that isn't a tree's) against the villager's feet or the building's top, lowGain
  voxels further per voxel lower (up to lowMax more), highLoss less per voxel higher (1, 20 and 1). Never seen isn't drawn at all: its columns go up to the GPU as air
  (TerrainField.blank, Grass.blank: no terrain, grass, shadow or light from it, no ore chunks, nothing to pick), but
  for those within a few voxels of what's been seen (Fog.near; each 8 × 8 tile with a column newly near is sent up
  again; with FOG_TUNING.bare on, the default, those near ones that are still never seen go up bare, land only, no
  trees or buildings, so nothing standing there hides what's behind it, and each tile with a column newly seen goes up
  again too). Leaves go up as their trunk's column is seen, not their own (TerrainField.seen, trunkOf in sdf.js: the
  nearest log within 2 columns, at the leaf's height or one below), so no canopy hangs in the air over a trunk not yet
  seen. A full-screen pass after the water cuts the drawn terrain away pixel by pixel where the never-seen mask
  (blurred on the GPU over `edge` voxels, softened by `feather`) is past half, so the edge runs smoothly through the
  voxels, and paints voidColor there (black, by voidMix: 0, the default, shows the sky instead), over the water and rays that went down
  to the map's bottom too; black on the minimap. (Optionally the sight is ragged per column: dither, off by default,
  and speckle.) Turning the fog on or off rebuilds the whole distance field. Seen before shows 90% darker and 60%
  desaturated (T > Fog of war: seenDark, seenDesat; the fog pass reads a copy of the frame there, fading in and out
  over the not-seen-now mask, which counts never seen too so it stays dark up to the cut, blurred over seenEdge
  voxels and softened by seenFeather) as it was last seen: an edit (dug, built, blown up, charred) anywhere blue can't
  see now is held back per 8 × 8 column tile and shown once blue sees the tile's middle (the GPU's voxels, distance
  field, grass and minimap follow; only the simulation sees it at once); on the minimap at 63% brightness. Other
  teams' villagers, their arrows, spears, fireballs and blasts, and debris aren't shown where blue can't see now (on
  the minimap too), nor can they be clicked; other teams' buildings show on the minimap once seen.
## How the terrain works

- **Voxels** (`src/terrain.js`): a 500 × 100 × 500 grid (x, y up, z), one byte per voxel holding its block type:
  air, ground (drawn as grass, dirt or sand by where it is), stone, planks and stone bricks (what villagers build: wood goes in as planks, stone as bricks), log or leaves. Stone comes in blobs of 3D noise
  (`STONE_TUNING`), more of it deeper down and on high ridges, and shows as outcrops where a blob reaches the surface. Everything is drawn as exact unit cubes,
  Minecraft style. The bottom layer is bedrock and can't be carved. The CPU owns the voxels; brushes edit them there.
- **Obsidian wall** (BLOCK.OBSIDIAN 248; Terrain.wall, made with every map: generate, mirror, flat): the ring of edge
  columns is obsidian from the bottom up to WALL_ABOVE (2) voxels over the highest ground next to it, or over the water
  if that's higher. Nothing breaks it: setVoxel, applySphere (fireballs, brushes) and slumpColumn leave it, and no order
  (dig, fill, flatten, build) works on the edge columns (isEdge). Its look is in T > Obsidian (near black stone grain
  with a glassy glint), its minimap colour in T > Minimap.
- **Iron and gold ore** (BLOCK.IRON 232, BLOCK.GOLD 240; ORE_TUNING in `src/terrain.js`): small veins of 3D noise (never below sea level, WATER_LEVEL)
  inside the stone, gold rarer and more of it deeper. Drawn as stone with flecks of the metal (render.js) and, on
  every face open to the air, two or three chunks of metal sticking out (iron's tapered and at odd angles, gold's rounded nuggets, the
  `nugget` shape in `src/units-render.js`) (`src/ores.js`, a units
  renderer of their own, kept per 16 × 16 tile and remade when an edit touches it; T > Ore: colours, glint, size,
  draw distance). Mined with a pickaxe, each gives 1 iron or 1 gold to a new game's inventory: currencies, shown
  beside the block palette, never built with.
  A dig order (E: a click or a box) on any ore block takes in its whole vein: every block of that ore joined to it
  face to face (`withVeins` in main.js, up to 4000).
- **Trees** (`src/trees.js`): Minecraft oaks (a trunk of 6-8 logs, at least 3 of them bare below the leaves (TREE_TUNING trunk, trunkVary), under two wide and two narrow layers of leaves)
  on the dry grassland in forests (thick patches where a low-frequency noise is over forestEdge, with open land
  between them and the odd lone tree; T > Forests, new world). They're ordinary blocks: villagers can't walk through
  them but can stand on them, and brushes and flatten jobs remove them. A villager cutting a log fells the trunk
  above it, and leaves no longer within 4 blocks of a log (through other leaves) wither over the next few seconds.
- **Bricks**: 8³ blocks summarise the grid. Each stores its Chebyshev distance (in bricks) to the nearest brick
  near the surface, which lets rays skip empty space and lets the SDF build skip bricks far from the surface.
- **SDF** (`src/sdf.js`): a compute shader turns the voxels into signed distances clamped to ±3 voxels, stored in
  an r16float 3D texture. An edit uploads only the changed box of voxels and rebuilds the distances around it.
- **Rendering** (`src/render.js`): a full-screen raymarch in three passes (march to a G-buffer, sun shadow, shade),
  with brick skipping, each block textured by type and face (grass on top, dirt on sides and undersides, bark and
  stone on every face of stone, rings on logs, leaves cut out where their texture is see-through), soft shadows, corner AO, and fog. The map edges render
  as dirt walls, like a diorama. The brush cursor is drawn on the surface in the same pass.
- **Textures** (`src/textures.js`, `textures/*.png`): painted 128² grass, dirt, sand, a fringe of hanging grass, bark,
  log rings, leaves, stone, planks, bricks and tilled soil (a farm's top, one repeat a voxel), loaded at startup into one texture array with linear-light mips. The ground textures span one
  repeat (1-5 voxels, the texture tiling), in world space; on the sides of a grass-topped column the fringe is laid over
  the dirt by its alpha, hanging from the top of the ground, so the dirt tiles seamlessly under it. Each texture but the
  trees' (bark, rings and leaves, lit flat: their old normal maps are in textures/unused/) has an OpenGL-style normal map (`textures/*-normal.png`) in a second array, blended like the colours and bent around the
  surface's normal, so bevels' follow their slope.
- **Bevels** (`bevelCuts` in `src/render.js`): exposed top edges and upright corners of ground and stone cubes are cut
  at 45° in the march (the ray clips against each cube's cuts) and in the near-surface distance, so shadows match. A cut
  tapers out where its edge meets a cube that isn't cut the same way, and inside corners of L-shaped steps are mitred.
  Bevels are textured as the face they lead on from, unfolded flat across the slope. Units and picking still see cubes.
- **Rounded leaves** (LEAF_TUNING in `src/render.js`, T > Leaves; on by default, round 0 = cubes as before): each leaf
  block's edges and corners are rounded off by its neighbours, per eighth of the block: sides facing air are rounded
  together (two open sides meet in a quarter cylinder, three in an eighth of a ball, radius up to 0.5 = a lone leaf is
  a ball), and a side against another leaf or a log stays flat and joins it, so clumps of leaves are soft blobs. The march
  sphere-traces each leaf block's rounded shape (leafHit, analytic normals), and the near-surface distance (cubeSdf)
  sees leaves rounded, so their shadows and the coarse pass match. holes: the leaf texture's gaps still cut through
  (1) or the blobs are solid (0). Only the look: units, jobs and picking still see cubes.
- **Picking**: a DDA raycast through the CPU voxels finds what's under the mouse.
- **Cubes** (`src/render.js`): near the surface the raymarcher evaluates the exact distance to the solid
  voxels' unit cubes from the 2×2×2 voxels on the point's near side; further out it steps by the distance field
  less a 1.25-voxel margin, so brick skipping still works. Near the surface the ray walks voxel by voxel (DDA), whose last step gives the
  exact face normal; AO is Minecraft-style per-corner occlusion from the 8 voxels around the face.
- **Profiler** (`src/profiler.js`, after space-miner's): GPU timestamps per pass where the browser exposes
  `timestamp-query`, plus CPU laps through the frame. Toggle with G or the GPU button.
- **Villagers** (`src/units.js`, `src/units-render.js`): 1×1×2-voxel blocky characters built from boxes in code,
  rasterised after the terrain against the depth the shade pass writes. They stand in air cells over solid ground,
  path with A* over those cells (stepping up or down at most one voxel, diagonals when there's room), spread out
  around the clicked spot, and re-path or climb out when an edit changes the ground under them. Blob shadows and move goals are
  drawn by the terrain shade pass; selected villagers are outlined in their team's just-lost health bar colour
  (the unit outline pass, width in T > Selection). They keep to dry land.
- **Flatten jobs** (`src/jobs.js`): jobs belong to nobody in particular. Each idle villager (not working a column
  and not walking where it was sent) claims the nearest column of any open box nobody else is working, walks right up beside it (a side, else a corner, with the voxel between a step below its feet and its head; it works from further away, within reach, only when there's no way there: T > Worker > closeFirst), and digs its highest voxel above the plane or fills its lowest empty one below
  (dirt sinks to the bottom of a pit or the lake). A column too tall to reach is undercut: its lowest voxel above
  the plane goes and the rest slumps down one. Unreachable columns are retried every few seconds. Each change
  updates one voxel on the CPU and rebuilds the SDF around it. A villager at the foot of a wall undercuts it rather
  than heading for a rim it may not be able to reach; villagers can hop down drops of up to 3 voxels, and one
  stranded on a pillar with nothing in reach digs down through the voxel it stands on. Villagers keep off spots
  where a block is still to go at their feet or head (T > Worker > inTheWay); one standing in the way of a block is
  asked to step aside, and one walled in by what's been built round it places that block itself and climbs onto it.
  Nobody digs ground out from under a villager into the water, or so that a worker (or one beside it) is left on less
  than T > Worker > island cells of dry land. A villager stuck in the water anyway drowns (drownDamage hit points a
  second).
- **Water** (`src/water.js`): fills the map to a height of 10 voxels (its grid's levels and foam map sized to the map), ported from Maksymilian Dendura's
  [web-ocean](https://github.com/Noniv/web-ocean) (MIT, see `LICENSES/web-ocean.txt`): an FFT (Tessendorf) wave
  simulation in four cascades (JONSWAP wind sea plus swell), Jacobian foam that builds up and decays in a map over
  the water, a CDLOD grid mesh, and its surface shading (sun glitter from LEAN slope statistics, Fresnel sky
  reflection, body scatter, backlit crests, foam). Here it's lit by the sky below, and it's see-through: it
  reads the terrain's G-buffer and a copy of the frame so far, so shallows show the sand under them (bent by the
  waves and tinted by depth) and shores get a foam line. The map's sides show the water's cross-section. Ground
  near and under the water is sand. Tune it in `WATER_TUNING` or with T > Water: the wind sea's speed, direction,
  fetch, height, frequency and peakedness; the swell's height, wavelength, direction and crest length; the finest
  ripples, the short-wave cut, choppiness, wave speed and gusts; and the look (brightness, clarity, refraction, backlit
  crests, foam, how fast it fades, the shore line). Changing a wave setting regenerates the spectrum.
- **Sky** (`src/sky.js`): web-ocean's physically based atmosphere: transmittance, multiple-scattering and sky-view
  LUTs (Rayleigh, Mie haze, ozone), two procedural cloud layers, the sun disc, and an environment cube refreshed a
  couple of faces a frame. The cube's blurred mips light the terrain and villagers from the sky (and from the ground
  below, for undersides) and give the water its reflections; sunlight is the sun's light through the atmosphere, so
  it reddens and fades at sunset. At night a moon opposite the sun is the light that casts shadows (and glints on
  the water), tunable in colour and strength. The sun's direction comes from the time of day, latitude and season. Exposure
  opens up at dusk and night (a faint night-sky glow keeps the map readable). Tune it in `SKY_TUNING` or with T.
- **Bloom and depth of field** (`src/post.js`): a last pass over the finished frame. Bloom keeps what's brighter
  than a threshold, blurs it down a chain of half-size textures and back up (dual filter) and adds it over the frame.
  Depth of field reads the depth buffer: within `dofRange` voxels of the focus (the camera's target, moved by
  `dofFocus`) stays sharp, and the blur grows to `dofBlur` pixels over as many voxels again, from a 24-sample disc
  that doesn't let sharp things smear over blurred ones. Tune it in `POST_TUNING` or with T; 0 turns either off.
- **HDR output** (`src/hdr.js`, off by default; HDR output on the main menu turns it on and reloads): on a browser
  that can show an HDR canvas (`toneMapping: { mode: 'extended' }`), everything draws into an rgba16float scene texture and
  one last pass writes it to an rgba16float canvas. Up to 1 is untouched, so the picture matches SDR; brighter light (sun
  glints, plasma, fire, bloom) rolls off towards `peak` times SDR white at a rate set by `gain` (`HDR_TUNING`, T > HDR
  output). Bloom's bright pass clamps each tap to 1 so it looks the same in both. Stored in localStorage `mine-wars-hdr`.
- **Villagers** wear togas and laced sandals like Populous II's followers, the toga in their team's colour
  (`TEAMS` in `src/units.js`; everyone is royal blue for now). Their bodies taper from the shoulders to the waist, the
  skirt flares out below it, the arms taper to a hand on a ball-joint wrist (bent within a cone, `UNIT_TUNING.wristCone`,
  to follow what it grips) and the head sits on a neck. Tapered boxes carry their taper in the matrix's spare bottom row
  (`src/units-render.js`). `node tools/zfight.mjs` checks a class's model for faces that would z-fight, and
  `node tools/preview-parts.mjs` renders models before and after a change, without a GPU.
- **Brick and plank bevels** (T > Ground, BLOCK_TUNING in `src/render.js`): each brick's and plank's edges bevelled in
  the lighting only (blockBevel in the shade pass works out the seams from where the textures draw them), and in toon
  shading the seams drawn as strokes.
- **Grass tufts** (`src/grass.js`, T > Ground): cartoon tufts of three outlined blades on grassy tops (not sand,
  stone, char, or under blocks), off the voxels' centres, upright and turned to the camera, within a range of its
  target. Which columns are grassy (and their height) is a 500×500 texture that edits update; the tufts themselves come
  from a hash of the column in the vertex shader, so the tuning applies at once.
  When a grassy top is dug out, blown up or charred (not when something is built on it), its tufts' blades puff up
  and flutter down, rocking and drifting, until they land and shrink away (`Grass.lose`/`tick`, drawn as single blades).
- **Debris** (`src/debris.js`, T > Debris): every stone or brick voxel taken away (dug, blown up) throws out round
  pebbles that bounce, roll off the edges of the voxels they land on and shrink away after a few seconds; logs and
  planks throw out chips that tumble and land flat. `Terrain.onLose` reports each solid voxel an edit removes (with the
  blast's centre, for a fireball). Pebbles are spheres traced in camera-facing quads, chips little boxes; outlined
  like the villagers in toon shading.
- **Toon shading** (an experiment, T > Toon shading, on by default): the terrain and blocks in flat colours (each
  texture's last mip, its average) without normal maps, a band of grass over the top of dirt sides, sunlight in steps,
  and strokes where the ground (or the sky) is far enough behind an edge (from the G-buffer's hit distances, in the
  shade pass; or, in Sobel mode, a Sobel filter over the G-buffer's depth and its normals, the depth strokes and the creases each at their own strength; corner AO at its own strength, up to 3x); villagers' light in the same steps and each part outlined (its back faces, grown by a few pixels, in
  `src/units-render.js`). `TOON=1 node tools/frame.mjs out.png` renders a frame offscreen to check it.
