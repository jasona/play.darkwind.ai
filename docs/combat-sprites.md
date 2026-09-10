# Combat Sprite Sheets

The visual Combat pane draws each fighter as a body plus overlays. The body
comes from a sprite sheet when one is shipped for the figure kind, and from
the procedural rig in `combat-rig-core.mjs` otherwise. Weapons, an off-hand
item, shield, helmet, cloak, and the portrait head always draw on top, so
equipment and identity work with any art.

Sheets live in `public/assets/sprites/` as a PNG plus a manifest with the
same base name. A missing or invalid sheet costs one request and falls back
to the next candidate, and finally to the rig.

## Lookup order

For the recipient's own fighter the stage tries, most specific first:

1. `characters/<name>` where the name is the character name lowercased with
   runs of non-alphanumerics replaced by `-` (`characters/grash-ironjaw`).
2. `<gender>-<race>` from `Char.Status`, slugged the same way (`male-scro`).
3. `<gender>-<family>` when the race belongs to a family in
   `SPRITE_RACE_FAMILIES`. The human cultures (Barbarian, Darkwinder,
   Desert Nomad, Glavian, Gypsy, Northman, Souvraeli) all map to `human`, so a
   Northman without a `male-northman` sheet draws `male-human`. The
   elven kinds (Arctic Elf, High Elf, Shel-Zaranite, Silver Elf, Wayfarian)
   map to `elf`, and the dwarven kinds (Desert Dwarf, Rift Duergar, Stone
   Dwarf) to `dwarf`. A family can also be another race: Uruk map to
   `scro`, so an Uruk without an `uruk` sheet draws the Scro one.
4. The body kind, `humanoid` or `beast`.

Targets and observed fighters only get the body kind: nothing recipient-safe
identifies them further. Every candidate is requested, so a more specific
sheet that finishes loading later takes over on the next frame. A character
or race sheet must still declare `kind` as `humanoid` or `beast`.

## Manifest

```json
{
  "version": 1,
  "kind": "humanoid",
  "image": "/assets/sprites/humanoid.png",
  "frameWidth": 256,
  "frameHeight": 256,
  "unit": 64,
  "anchor": { "x": 128, "y": 232 },
  "facing": "right",
  "rigAligned": false,
  "frames": {
    "idle":   { "x": 0,   "y": 0, "anchors": { "head": { "x": 128, "y": 62, "r": 20 }, "hand": { "x": 152, "y": 150 }, "offHand": { "x": 104, "y": 148 }, "cloak": { "x": 110, "y": 96 } } },
    "windup": { "x": 256, "y": 0, "anchors": { "...": "..." } }
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Always `1`. |
| `kind` | `humanoid` or `beast`. Must match the file name. |
| `image` | Root-relative path or HTTPS URL of the sheet PNG. |
| `frameWidth`, `frameHeight` | Size of one frame in image pixels. Every frame is the same size. |
| `unit` | Image pixels per body unit at scale 1. The stage scales the frame by its own unit divided by this, so a sheet drawn at 64 px per unit and one drawn at 128 px per unit render the same size. A humanoid stands about 2.9 units tall; see the rig for proportions. |
| `anchor` | Ground point in frame pixels: where the figure's hip meets the floor line. The stage places this point on the stage ground under the fighter. |
| `facing` | Direction the art faces, `right` or `left`. The stage mirrors the frame for the other side. |
| `pixelated` | Optional. `true` draws the sheet with image smoothing off, for pixel art. The assembler's `--pixel` sets it. |
| `weaponsInArt` | Optional. `true` means the frames already show the character's weapons, so the stage draws no weapon overlays (the shield still draws). The assembler's `--weapons-in-art` sets it. |
| `cloak` | Optional. `false` hides the stage's cloak overlay because the art has its own; a `#rrggbb` color recolors it. |
| `rigAligned` | `true` only for sheets baked from the rig. The stage then positions overlays from rig geometry. Hand-drawn art sets `false` and supplies anchors per frame. |
| `frames` | One entry per pose name. Unknown names are ignored; `idle` is required. |

### Frame anchors

Per-frame pixel positions the overlays attach to. All are optional; a
missing anchor makes that overlay use rig geometry, which will be wrong for
hand-drawn art, so supply them.

| Anchor | Used for |
| --- | --- |
| `head` | Center and radius of the portrait disc. The art should leave the head area empty or draw a neutral back-of-head shape underneath. |
| `neck` | Where the neck meets the shoulders, for the helmet and for scaling the disc. |
| `hand` | Weapon hand. The main-hand weapon is drawn from here. |
| `offHand` | Off-hand item or shield. |
| `cloak` | Top of the cloak at the back shoulder. Omit if the art already includes a cloak. |

### Poses

One frame per pose name. Poses the sheet does not include fall back to the
nearest frame that exists (`idle` at minimum), so a first sheet can ship with
a subset and grow.

| Pose | When |
| --- | --- |
| `idle` | Rest stance, breathing is added by the stage. |
| `windup` | Anticipation before a blade, knife, polearm, staff, or claw strike. |
| `raise` | Anticipation before an axe or mace chop, weapon overhead. |
| `draw` | Bow drawn. |
| `strike` | Blade swing at contact. |
| `thrust` | Knife or polearm thrust at contact. |
| `chop` | Axe or mace chop at contact. |
| `cast` | Staff cast, both hands forward. |
| `loose` | Bow released. |
| `maul` | Claw or unarmed attack at contact. |
| `whiff` | Overextended swing on a miss. |
| `recoil` | Taking a hit. |
| `dodge` | Sidestep and crouch. |
| `guard` | Arms up behind a shield or crossed forearms on an absorb. |

The stage blends between the current and next pose by crossfading the two
frames over the blend, then holds the target frame. Squash and stretch, the
hit flash, and hit-stop apply to sprites the same way they apply to the rig.

## Baking a stand-in sheet

Until art exists, a sheet in the exact format above can be baked from the
rig in the browser console while the client is open:

```js
const baked = await window.combatDebug.bakeSpriteSheet('humanoid');
// A hand-authored vector style from combat-sprite-art.mjs, written under its own key:
const scro = await window.combatDebug.bakeSpriteSheet('humanoid', 'male-scro');
```

`baked.png` is a data URL for the sheet image and `baked.manifest` is the
manifest with rig-derived anchors. Save them as
`public/assets/sprites/humanoid.png` and `humanoid.json`. The baked sheet
looks exactly like the rig; its value is proving the loader and giving an
artist the frame grid, anchors, and pose list to draw over.

## Painting over a baked sheet

To replace a baked sheet with painted art, bake it at four times the size
for crisp control images, split the cells, and paint each cell with an
image model under a structure control:

```js
const big = await window.combatDebug.bakeSpriteSheet('humanoid', 'male-scro', 4);
// With the weapons in the frames, for painting an armed character:
const armed = await window.combatDebug.bakeSpriteSheet('humanoid', 'male-scro', 4, {
  weapons: true,
  equipment: { mainHand: { name: 'a sword', kind: 'blade' }, offHand: { name: 'a sword', kind: 'blade' }, shield: false, helmet: false, bodyArmor: true, twoHanded: false },
});
// big.canvas is the 4096 px sheet, big.names the pose order, big.frame the cell size.
```

`scripts/comfyui-sprite-cell.json` is a ComfyUI graph for one cell: checkpoint,
prompts, Canny edges from the cell, ControlNet Union, sampler, save. It uses
core nodes only; add IPAdapter plus for cross-pose consistency and a
background-removal node before assembly.

`scripts/sprite-sheet-assemble.py` places finished frames (matched by pose
name) into a new sheet at the requested cell size, scales the manifest's
frame size, unit, ground anchor, frame origins, and per-frame anchors to
match, and sets `rigAligned` to false. Run it with any Python that has
Pillow, for example ComfyUI's bundled interpreter. For pixel art pass
`--pixel` (nearest-neighbor resize and the `pixelated` manifest flag) and
optionally `--colors N` to quantize each frame to a palette.


`scripts/sprite-sheet-split.py` handles the other route: a whole sheet
generated from a text prompt with no reference cells. It cuts an even grid,
flood-fills the flat background away from the cell edges (so highlights
inside the figure survive), scales every figure by one shared factor so the
median figure height lands on the rig's, and places each with its feet on
the ground anchor, writing one frame per pose in grid order. Such frames
carry no anchors of their own, so the assembler can derive them from the
art: `--detect-head #rrggbb` finds each frame's head as the largest blob of
the skin color in the figure's upper part (`--head-band` narrows that part
when bare arms in the skin color outweigh the head), and `--detect-hand` takes the
main hand as the leading extremity in the arm band (or the topmost point
of a raised arm). Either clears `rigAligned`. Without them, assemble with
`--keep-rig-aligned` and nudge the manifest where an overlay sits off.