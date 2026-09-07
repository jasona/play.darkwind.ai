#!/usr/bin/env python3
"""Assemble painted sprite frames into a Darkflow sprite sheet and scale
its manifest to match.

Typical use, after generating and background-removing the 14 cells:

    python scripts/sprite-sheet-assemble.py \
        --frames F:/darkflow-sprite-kit/male-scro/painted \
        --manifest public/assets/sprites/male-scro.json \
        --sheet public/assets/sprites/male-scro.png \
        --cell 512

For 16-bit style art add --pixel (nearest-neighbor resize, manifest marked
pixelated so the client draws it unsmoothed) and optionally --colors 32 to
reduce each frame to a palette:

    python scripts/sprite-sheet-assemble.py ... --cell 128 --pixel --colors 32

Frames are matched by pose name anywhere in the file name (01-idle.png,
idle.png, idle_00001_.png all work). Each frame is resized to the cell size
and placed at the cell the manifest already assigns to that pose, so the
frame grid and pose order never have to be typed by hand. The manifest's
frame size, body unit, ground anchor, frame origins, and per-frame anchors
are scaled from the old cell size to the new one, and rigAligned is set to
false so the stage attaches overlays to the anchors rather than rig math.

Requires Pillow. ComfyUI's bundled interpreter has it:

    ComfyUI_windows_portable\\python_embeded\\python.exe scripts\\sprite-sheet-assemble.py ...
"""

import argparse
import json
import re
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover - guidance for the user
    sys.exit("Pillow is required: pip install pillow (or use ComfyUI's python_embeded)")


def scale_point(point, factor):
    out = {"x": round(point["x"] * factor, 2), "y": round(point["y"] * factor, 2)}
    if "r" in point:
        out["r"] = round(point["r"] * factor, 2)
    return out


def quantize_keep_alpha(image, colors):
    """Palette-reduce the RGB channels while keeping the alpha channel intact."""
    alpha = image.getchannel("A")
    rgb = image.convert("RGB").quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    out = rgb.convert("RGBA")
    out.putalpha(alpha)
    return out


def parse_color(text):
    value = text.strip().lstrip("#")
    if len(value) != 6:
        raise SystemExit("colors are #rrggbb")
    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))


def detect_head(image, color, tolerance, band=0.4):
    """Find the head in a painted frame: the largest blob of skin-colored
    pixels in the upper part of the figure. Returns {x, y, r} in frame
    pixels, or None. Works on a reduced copy for speed."""
    bbox = image.getbbox()
    if not bbox:
        return None
    reduce = max(1, image.width // 160)
    small = image.resize((image.width // reduce, image.height // reduce), Image.NEAREST)
    width, height = small.size
    pixels = small.load()
    top = bbox[1] // reduce
    limit = top + int(((bbox[3] - bbox[1]) // reduce) * band)
    mask = bytearray(width * height)
    for y in range(top, min(height, limit)):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a > 40 and all(abs(c - t) <= tolerance for c, t in zip((r, g, b), color)):
                mask[y * width + x] = 1
    seen = bytearray(width * height)
    best = None
    for start in range(len(mask)):
        if not mask[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        points = []
        while stack:
            index = stack.pop()
            points.append(index)
            x, y = index % width, index // width
            for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if 0 <= nx < width and 0 <= ny < height:
                    n = ny * width + nx
                    if mask[n] and not seen[n]:
                        seen[n] = 1
                        stack.append(n)
        if best is None or len(points) > len(best):
            best = points
    if not best or len(best) < 12:
        return None
    xs = [p % width for p in best]
    ys = [p // width for p in best]
    cx = (sum(xs) / len(xs) + 0.5) * reduce
    cy = (sum(ys) / len(ys) + 0.5) * reduce
    radius = ((len(best) / 3.14159) ** 0.5) * reduce * 1.08
    return {"x": round(cx, 2), "y": round(cy, 2), "r": round(radius, 2)}


def detect_hand(image, head):
    """Main-hand anchor from the figure's shape. In a right-facing side view
    the weapon hand is the leading extremity between the shoulders and the
    knees; when an arm is raised above the head, it is the topmost point.
    Returns {x, y} in frame pixels, or None."""
    bbox = image.getbbox()
    if not bbox:
        return None
    alpha = image.getchannel("A").load()
    width, height = image.size
    figure_height = bbox[3] - bbox[1]
    head_top = (head["y"] - head["r"]) if head else bbox[1] + figure_height * 0.08
    if head and bbox[1] < head_top - head["r"] * 0.9:
        # Something rises well above the head: a raised fist.
        limit = bbox[1] + max(4, int(figure_height * 0.07))
        xs, ys = [], []
        for y in range(bbox[1], limit):
            for x in range(bbox[0], bbox[2]):
                if alpha[x, y] > 40:
                    xs.append(x)
                    ys.append(y)
        if xs:
            return {"x": round(sum(xs) / len(xs), 2), "y": round(sum(ys) / len(ys) + figure_height * 0.02, 2)}
    band_top = int(head["y"] + head["r"] * 1.1) if head else int(bbox[1] + figure_height * 0.22)
    band_bottom = int(bbox[3] - figure_height * 0.32)
    best_x = -1
    for y in range(max(bbox[1], band_top), min(bbox[3], band_bottom)):
        for x in range(bbox[2] - 1, bbox[0] - 1, -1):
            if alpha[x, y] > 40:
                if x > best_x:
                    best_x = x
                break
    if best_x < 0:
        return None
    # Average the opaque pixels near the leading edge to land inside the fist.
    reach = max(6, int(figure_height * 0.05))
    xs, ys = [], []
    for y in range(max(bbox[1], band_top), min(bbox[3], band_bottom)):
        for x in range(max(bbox[0], best_x - reach), best_x + 1):
            if alpha[x, y] > 40:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return {"x": round(sum(xs) / len(xs), 2), "y": round(sum(ys) / len(ys), 2)}


def find_frame(frames_dir, pose):
    pattern = re.compile(r"(^|[^a-z])" + re.escape(pose) + r"([^a-z]|$)", re.IGNORECASE)
    matches = sorted(p for p in frames_dir.iterdir() if p.suffix.lower() == ".png" and pattern.search(p.stem))
    return matches[0] if matches else None


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--frames", required=True, help="folder of painted frame PNGs, one per pose")
    parser.add_argument("--manifest", required=True, help="existing manifest to scale (read and overwritten unless --manifest-out)")
    parser.add_argument("--sheet", required=True, help="output sheet PNG")
    parser.add_argument("--cell", type=int, default=512, help="cell size in pixels for the new sheet (default 512)")
    parser.add_argument("--manifest-out", help="write the scaled manifest here instead of overwriting")
    parser.add_argument("--keep-rig-aligned", action="store_true", help="do not flip rigAligned to false")
    parser.add_argument("--pixel", action="store_true", help="pixel art: resize with nearest-neighbor and mark the manifest pixelated so the client draws it without smoothing")
    parser.add_argument("--colors", type=int, default=0, help="with --pixel, quantize each frame to this many colors (alpha preserved)")
    parser.add_argument("--weapons-in-art", action="store_true", help="the frames include the character's weapons; the client will not draw its own on top")
    parser.add_argument("--detect-head", metavar="#RRGGBB", help="skin color of the painted head; each frame's head anchor is detected from the largest blob of that color in the figure's upper part, and rigAligned is cleared so the portrait follows the art")
    parser.add_argument("--head-tolerance", type=int, default=42, help="per-channel tolerance for --detect-head (default 42)")
    parser.add_argument("--head-band", type=float, default=0.4, help="fraction of the figure's height, from the top, searched by --detect-head (default 0.4); lower it when bare arms in the skin color outweigh the head")
    parser.add_argument("--detect-hand", action="store_true", help="derive each frame's main-hand anchor from the figure's shape (leading extremity in the arm band, or the topmost point of a raised arm); the off-hand keeps the manifest anchor")
    args = parser.parse_args()

    frames_dir = Path(args.frames)
    manifest_path = Path(args.manifest)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    old_cell = int(manifest["frameWidth"])
    if int(manifest["frameHeight"]) != old_cell:
        sys.exit("only square cells are supported")
    factor = args.cell / old_cell

    poses = list(manifest["frames"].keys())
    columns = max(int(frame["x"]) // old_cell for frame in manifest["frames"].values()) + 1
    rows = max(int(frame["y"]) // old_cell for frame in manifest["frames"].values()) + 1
    sheet = Image.new("RGBA", (columns * args.cell, rows * args.cell), (0, 0, 0, 0))

    head_color = parse_color(args.detect_head) if args.detect_head else None
    detected_heads = {}
    detected_hands = {}
    missing = []
    for pose in poses:
        source = find_frame(frames_dir, pose)
        if source is None:
            missing.append(pose)
            continue
        image = Image.open(source).convert("RGBA")
        if image.size != (args.cell, args.cell):
            resample = Image.NEAREST if args.pixel else Image.LANCZOS
            image = image.resize((args.cell, args.cell), resample)
        if args.pixel and args.colors > 0:
            image = quantize_keep_alpha(image, args.colors)
        if head_color:
            head = detect_head(image, head_color, args.head_tolerance, args.head_band)
            if head:
                detected_heads[pose] = head
            else:
                print(f"{pose:8s} head not found; keeping the manifest anchor")
        if args.detect_hand:
            hand = detect_hand(image, detected_heads.get(pose))
            if hand:
                detected_hands[pose] = hand
            else:
                print(f"{pose:8s} hand not found; keeping the manifest anchor")
        cell_x = int(manifest["frames"][pose]["x"] * factor)
        cell_y = int(manifest["frames"][pose]["y"] * factor)
        sheet.alpha_composite(image, (cell_x, cell_y))
        print(f"{pose:8s} <- {source.name}")

    if missing:
        print("missing frames (those poses fall back to idle at runtime): " + ", ".join(missing))

    Path(args.sheet).parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.sheet, optimize=True)

    scaled = dict(manifest)
    scaled["frameWidth"] = args.cell
    scaled["frameHeight"] = args.cell
    scaled["unit"] = round(manifest["unit"] * factor, 2)
    scaled["anchor"] = scale_point(manifest["anchor"], factor)
    if not args.keep_rig_aligned or detected_heads or detected_hands:
        scaled["rigAligned"] = False
    if args.pixel:
        scaled["pixelated"] = True
    if args.weapons_in_art:
        scaled["weaponsInArt"] = True
    scaled_frames = {}
    for pose, frame in manifest["frames"].items():
        if pose in missing:
            continue
        entry = {"x": int(frame["x"] * factor), "y": int(frame["y"] * factor), "anchors": {}}
        for name, point in (frame.get("anchors") or {}).items():
            entry["anchors"][name] = scale_point(point, factor)
        if pose in detected_heads:
            entry["anchors"]["head"] = detected_heads[pose]
        if pose in detected_hands:
            entry["anchors"]["hand"] = detected_hands[pose]
        scaled_frames[pose] = entry
    scaled["frames"] = scaled_frames

    out_path = Path(args.manifest_out) if args.manifest_out else manifest_path
    out_path.write_text(json.dumps(scaled, indent=2) + "\n", encoding="utf-8", newline="\r\n")
    print(f"sheet: {args.sheet} ({sheet.size[0]}x{sheet.size[1]}), manifest: {out_path}")


if __name__ == "__main__":
    main()
