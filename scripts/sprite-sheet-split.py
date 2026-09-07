#!/usr/bin/env python3
"""Split a generated character sheet into Darkflow sprite frames.

For sheets produced by an image model from a text prompt (no reference
cells), where figures sit on an approximate grid, at their own size, on a
flat white background. This script:

1. cuts the sheet into an even grid of columns x rows,
2. trims a small inset from each cell so drawn grid lines and gutters are
   left out, then removes the flat background (flood fill from the cell
   edges, so white highlights inside the figure survive),
3. finds the figure's bounding box,
4. rescales every figure by one shared factor, chosen so the median figure
   height across the sheet lands at a fixed fraction of the output cell
   (raised arms and crouches then stay taller or shorter, as they should),
   and places each figure with its feet on the Darkflow ground line
   (anchor y = 232/256 of the cell) around the hip anchor (x = 100/256), and
5. writes one PNG per pose name in grid order.

Then run sprite-sheet-assemble.py with --keep-rig-aligned so weapons and the
portrait head attach at the rig's joints; a model-generated frame has no
anchors of its own.

    python scripts/sprite-sheet-split.py --sheet gemini-sheet.png --out painted --columns 4 --rows 4 --cell 512
"""

import argparse
import sys
from collections import deque
from pathlib import Path

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    sys.exit("Pillow is required: pip install pillow (or use ComfyUI's python_embeded)")

POSE_ORDER = [
    "idle", "windup", "strike", "thrust", "cast", "draw", "loose", "maul",
    "whiff", "recoil", "dodge", "guard", "raise", "chop",
]
GROUND_FRACTION = 232 / 256
HIP_FRACTION = 100 / 256


def remove_background(cell, tolerance):
    """Flood-fill transparency from the cell edges over near-background pixels."""
    cell = cell.convert("RGBA")
    width, height = cell.size
    pixels = cell.load()
    # Background color: the most common color along the border.
    border = {}
    for x in range(width):
        for y in (0, height - 1):
            border[pixels[x, y][:3]] = border.get(pixels[x, y][:3], 0) + 1
    for y in range(height):
        for x in (0, width - 1):
            border[pixels[x, y][:3]] = border.get(pixels[x, y][:3], 0) + 1
    background = max(border, key=border.get)

    def near(rgb):
        return all(abs(rgb[i] - background[i]) <= tolerance for i in range(3))

    visited = bytearray(width * height)
    queue = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))
    while queue:
        x, y = queue.popleft()
        if x < 0 or y < 0 or x >= width or y >= height:
            continue
        index = y * width + x
        if visited[index]:
            continue
        visited[index] = 1
        r, g, b, a = pixels[x, y]
        if not near((r, g, b)):
            continue
        pixels[x, y] = (r, g, b, 0)
        queue.append((x + 1, y))
        queue.append((x - 1, y))
        queue.append((x, y + 1))
        queue.append((x, y - 1))
    return cell


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--sheet", required=True, help="generated sheet PNG on a flat background")
    parser.add_argument("--out", required=True, help="folder for the per-pose frames")
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--rows", type=int, default=4)
    parser.add_argument("--cell", type=int, default=512, help="output frame size in pixels")
    parser.add_argument("--figure-height", type=float, default=0.78, help="median figure height as a fraction of the output cell (default 0.78, matching the baked Scro)")
    parser.add_argument("--per-cell-scale", action="store_true", help="scale each figure to the target height on its own instead of one shared factor")
    parser.add_argument("--tolerance", type=int, default=28, help="background color tolerance per channel for removal")
    parser.add_argument("--inset", type=float, default=0.03, help="fraction of each cell trimmed from every edge before processing, to drop drawn grid lines and gutters (default 0.03)")
    parser.add_argument("--min-area", type=int, default=400, help="ignore cells whose opaque area is below this many pixels (empty cells)")
    parser.add_argument("--poses", default=",".join(POSE_ORDER), help="comma-separated pose names in grid order")
    args = parser.parse_args()

    poses = [p.strip() for p in args.poses.split(",") if p.strip()]
    sheet = Image.open(args.sheet).convert("RGBA")
    width, height = sheet.size
    cell_w = width / args.columns
    cell_h = height / args.rows
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    ground_y = args.cell * GROUND_FRACTION
    hip_x = args.cell * HIP_FRACTION
    target_height = args.cell * args.figure_height

    # Pass 1: cut, clean, and measure every cell.
    figures = []
    for index, pose in enumerate(poses):
        col = index % args.columns
        row = index // args.columns
        if row >= args.rows:
            break
        inset_x = int(cell_w * args.inset)
        inset_y = int(cell_h * args.inset)
        box = (
            int(col * cell_w) + inset_x,
            int(row * cell_h) + inset_y,
            int((col + 1) * cell_w) - inset_x,
            int((row + 1) * cell_h) - inset_y,
        )
        cell = remove_background(sheet.crop(box), args.tolerance)
        bbox = cell.getbbox()
        if not bbox:
            print(f"{pose:8s} cell {index + 1}: empty, skipped")
            continue
        figure = cell.crop(bbox)
        opaque = sum(figure.getchannel("A").histogram()[1:])
        if opaque < args.min_area:
            print(f"{pose:8s} cell {index + 1}: too little content, skipped")
            continue
        figures.append((index, pose, figure, bbox))
    if not figures:
        sys.exit("no figures found; check --columns/--rows and --tolerance")

    # One shared scale keeps the body the same size in every frame; a raised
    # arm makes a taller frame rather than a smaller body.
    heights = sorted(f[2].height for f in figures)
    median_height = heights[len(heights) // 2]
    shared_scale = target_height / median_height

    written = []
    for index, pose, figure, bbox in figures:
        scale = target_height / figure.height if args.per_cell_scale else shared_scale
        new_size = (max(1, round(figure.width * scale)), max(1, round(figure.height * scale)))
        figure = figure.resize(new_size, Image.LANCZOS)
        frame = Image.new("RGBA", (args.cell, args.cell), (0, 0, 0, 0))
        # Feet on the ground line; the figure's horizontal center a little
        # ahead of the hip anchor, since a side-view body extends forward.
        left = round(hip_x - figure.width * 0.45)
        top = round(ground_y - figure.height)
        frame.alpha_composite(figure, (max(-figure.width + 1, left), top))
        path = out_dir / f"{pose}.png"
        frame.save(path, optimize=True)
        written.append(pose)
        print(f"{pose:8s} <- cell {index + 1} ({bbox[2] - bbox[0]}x{bbox[3] - bbox[1]} px figure)")
    print(f"wrote {len(written)} frames to {out_dir}")


if __name__ == "__main__":
    main()
