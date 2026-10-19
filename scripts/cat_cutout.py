"""Cut ONLY the orange tabby out of the source clip as transparent WebP frames (local, $0).

Pipeline per frame (all local, CPU):
  1. BiRefNet (rembg "birefnet-general") gives a high-quality alpha matte of everything in front
     of the room (both cats).
  2. SAM (rembg "sam"), prompted with positive points on the orange fur and negative points on the
     white cat, gives an instance mask of the orange cat alone.
  3. Final alpha = BiRefNet matte inside the (slightly grown) SAM mask, largest component only,
     with the colour fringe pulled towards the cat's own fur colour (defringe).
  4. The frame is scored: it is CLEAN only when the white cat stays clear of the orange cat (no
     touching/overlap), the orange cat doesn't touch the video border, and no white/grey fur blob
     sits on the orange silhouette. Dirty frames are never patched; moves are built from clean runs.

Usage:
  python scripts/cat_cutout.py scan  [--fps 12]            # score every frame -> work/cat-scan/scan.json
  python scripts/cat_cutout.py move <name> <start> <end>   # export clean frames of a range
"""
import argparse
import glob
import json
import os
import subprocess
import sys

import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "inputs", "1000044843.mp4")
SCAN_DIR = os.path.join(ROOT, "work", "cat-scan")
# birefnet-general is sharper but ~200 s/frame on a 2-core laptop CPU; the lite model is several times faster.
MATTE_MODEL = os.environ.get("CAT_MATTE_MODEL", "birefnet-general-lite")

_sessions = {}


def session(name):
    if name not in _sessions:
        _sessions[name] = new_session(name)
    return _sessions[name]


def hsv_masks(rgb):
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = (hsv[..., i].astype(int) for i in range(3))
    orange = (h >= 4) & (h <= 26) & (s >= 80) & (v >= 70)
    white = (s < 45) & (v > 140)
    dark = (v < 60) | ((s < 60) & (v < 110))
    return orange, white, dark


def blobs(mask, min_area):
    m = mask.astype(np.uint8) * 255
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, labels, stats, cent = cv2.connectedComponentsWithStats(m)
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] >= min_area]
    keep.sort(key=lambda i: -stats[i, cv2.CC_STAT_AREA])
    return labels, stats, cent, keep


def fill_holes(mask):
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = np.zeros_like(mask)
    if contours:
        cv2.drawContours(out, contours, -1, 255, thickness=cv2.FILLED)
    return out


def largest_component(mask):
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    if n <= 1:
        return mask
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    return np.where(labels == i, 255, 0).astype(np.uint8)


def sample_points(labels, idx, n):
    ys, xs = np.where(labels == idx)
    if len(ys) == 0:
        return []
    order = np.argsort(ys)
    picks = [order[int(len(order) * f)] for f in np.linspace(0.15, 0.85, n)]
    pts = []
    for p in picks:
        # nudge to a pixel deep inside the blob along that row
        row = ys[p]
        rx = xs[ys == row]
        pts.append([int(np.median(rx)), int(row)])
    return pts


def run_models(rgb):
    """The slow part (~minutes/frame on a laptop CPU): BiRefNet matte + SAM instance mask of the orange cat."""
    H, W = rgb.shape[:2]
    matte = np.array(remove(Image.fromarray(rgb), session=session(MATTE_MODEL), only_mask=True))
    fg = matte > 60
    orange, white, dark = hsv_masks(rgb)
    area_min = int(H * W * 0.002)
    ol, ost, _, okeep = blobs(orange & fg, area_min)
    if not okeep:
        return matte, np.zeros((H, W), np.uint8)
    prompt = [{"type": "point", "label": 1, "data": p} for p in sample_points(ol, okeep[0], 4)]
    # Negative prompts: white/dark fur in the foreground that is not near the orange blob.
    near_orange = cv2.dilate((ol == okeep[0]).astype(np.uint8), np.ones((25, 25), np.uint8)) > 0
    wl, wst, _, wkeep = blobs((white | dark) & fg & ~near_orange, area_min)
    for i in wkeep[:2]:
        prompt += [{"type": "point", "label": 0, "data": p} for p in sample_points(wl, i, 2)]
    sam = remove(Image.fromarray(rgb), session=session("sam"), sam_prompt=prompt, only_mask=True)
    sam = (np.array(sam) > 127).astype(np.uint8) * 255
    return matte, sam


def isolate(rgb, matte=None, sam=None):
    """Return (alpha uint8, info dict) for the orange cat. Pass cached matte/sam to skip the models."""
    H, W = rgb.shape[:2]
    if matte is None or sam is None:
        matte, sam = run_models(rgb)
    fg = matte > 60
    orange, white, dark = hsv_masks(rgb)
    area_min = int(H * W * 0.002)
    if not sam.any():
        return np.zeros((H, W), np.uint8), {"clean": False, "why": "no orange cat"}
    sam = largest_component(sam)
    grown = cv2.dilate(sam, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    alpha = (matte.astype(np.float32) * (grown > 0)).astype(np.uint8)
    alpha = largest_component((alpha > 20).astype(np.uint8) * 255) / 255.0 * alpha
    alpha = alpha.astype(np.uint8)

    # ---- fringe trim: where the cats touch, the matte carries a thin rim of white fur ----
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    rim_white = (hsv[..., 1] < 60) & (hsv[..., 2] > 120)
    body = alpha > 128
    rest = fg & ~(cv2.dilate(body.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    if rest.any():
        d_other = cv2.distanceTransform((~rest).astype(np.uint8), cv2.DIST_L2, 5)
        alpha[d_other < 5] = 0  # a few px of air next to the other cat
    for _ in range(2):  # peel twice: the first pass exposes the next layer of the rim
        body = alpha > 128
        band = cv2.subtract(cv2.dilate(body.astype(np.uint8), np.ones((3, 3), np.uint8)),
                            cv2.erode(body.astype(np.uint8), np.ones((13, 13), np.uint8))) > 0
        alpha[band & (rim_white | (dark & ~orange))] = 0  # white/grey rim pixels on the outline
    alpha = (largest_component((alpha > 20).astype(np.uint8) * 255) / 255.0 * alpha).astype(np.uint8)
    alpha = cv2.GaussianBlur(alpha, (3, 3), 0)

    # ---- scoring ----
    body = alpha > 128
    other_fg = fg & ~(cv2.dilate(body.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
    # the white cat = big foreground blobs outside the orange cat
    otl, otst, _, otkeep = blobs(other_fg, area_min)
    other = np.isin(otl, otkeep) if otkeep else np.zeros_like(body)
    gap = 999.0
    if other.any():
        dist = cv2.distanceTransform((~body).astype(np.uint8), cv2.DIST_L2, 5)
        gap = float(dist[other].min())
    yy, xx = np.where(body)
    border = bool(len(yy) and (xx.min() <= 2 or xx.max() >= W - 3 or yy.min() <= 2 or yy.max() >= H - 3))
    # white/grey fur sitting on the orange silhouette, touching its edge (the cat's own eyes/nose are interior)
    edge = cv2.subtract(cv2.dilate(body.astype(np.uint8), np.ones((5, 5), np.uint8)),
                        cv2.erode(body.astype(np.uint8), np.ones((9, 9), np.uint8))) > 0
    # Thin slivers of the other cat along the outline are small, so the size floor here is low.
    cl, cst, _, ckeep = blobs((white | (dark & ~orange)) & body, max(15, int(body.sum() * 0.0008)))
    contam = sum(int(cst[i, cv2.CC_STAT_AREA]) for i in ckeep if edge[cl == i].any())
    # A white paw resting on the chest/belly sits fully inside the silhouette, so it never touches the
    # edge. Below the head (top ~25% of the body, where the cat's own white muzzle/whiskers are) any
    # white blob bigger than a speck is the other cat.
    if len(yy):
        head_y = yy.min() + 0.25 * (yy.max() - yy.min())
        wl2, wst2, wc2, wkeep2 = blobs(white & body, max(25, int(body.sum() * 0.0012)))
        contam += sum(int(wst2[i, cv2.CC_STAT_AREA]) for i in wkeep2 if wc2[i][1] > head_y)
    # Where the white cat's limb crossed in front, SAM leaves a bite/gash in the orange silhouette right
    # next to the white cat. Measure the bite: closed-and-filled outline minus the body, near the other cat.
    bite = 0
    if other.any():
        b8 = body.astype(np.uint8) * 255
        closed = fill_holes(cv2.morphologyEx(b8, cv2.MORPH_CLOSE,
                                             cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (41, 41))))
        near_other = cv2.dilate(other.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0
        bite = int(((closed > 0) & ~body & near_other).sum())
    info = {
        "bite": bite,
        "gap": round(gap, 1), "border": border, "contam": contam, "area": int(body.sum()),
        "bbox": [int(xx.min()), int(yy.min()), int(xx.max()), int(yy.max())] if len(yy) else None,
    }
    # Cats may stand close (a couple of px apart) as long as nothing of the white cat is on or in front
    # of the orange one: no contamination and no bite taken out of the silhouette.
    info["clean"] = bool(gap >= 1 and not border and contam == 0 and bite < body.sum() * 0.006
                         and info["area"] > area_min * 5)
    return alpha, info


def defringe(rgb, alpha):
    """Replace colours on the semi-transparent rim with the nearest solid fur colour (kills room halo)."""
    solid = (alpha > 230).astype(np.uint8)
    if solid.sum() == 0:
        return rgb
    rim = ((alpha > 0) & (alpha <= 230)).astype(np.uint8) * 255
    out = rgb.copy()
    filled = cv2.inpaint(rgb, rim, 3, cv2.INPAINT_TELEA)
    m = rim > 0
    out[m] = filled[m]
    return out


def extract(start, end, fps, raw_dir):
    os.makedirs(raw_dir, exist_ok=True)
    for f in glob.glob(os.path.join(raw_dir, "*.png")):
        os.remove(f)
    args = ["ffmpeg", "-v", "error", "-y"]
    if start is not None:
        args += ["-ss", str(start), "-to", str(end)]
    subprocess.run(args + ["-i", SRC, "-vf", f"fps={fps}", os.path.join(raw_dir, "%04d.png")], check=True)
    return sorted(glob.glob(os.path.join(raw_dir, "*.png")))


def cmd_scan(args):
    """Score frames. Model outputs are cached in work/cat-scan/{matte,sam}/, so re-running only redoes
    the (fast) clean-up and scoring for frames already through the models."""
    raw_dir = os.path.join(SCAN_DIR, "raw")
    raw = sorted(glob.glob(os.path.join(raw_dir, "*.png"))) or extract(None, None, args.fps, raw_dir)
    for d in ("alpha", "matte", "sam"):
        os.makedirs(os.path.join(SCAN_DIR, d), exist_ok=True)
    ranges = [tuple(float(x) for x in r.split("-")) for r in args.ranges.split(",")] if args.ranges else None
    results = []
    for i, p in enumerate(raw):
        t = i / args.fps
        if ranges and not any(a <= t < b for a, b in ranges):
            continue
        name = os.path.basename(p)
        mp, sp = os.path.join(SCAN_DIR, "matte", name), os.path.join(SCAN_DIR, "sam", name)
        rgb = np.array(Image.open(p).convert("RGB"))
        if os.path.exists(mp) and os.path.exists(sp):
            matte, sam = cv2.imread(mp, cv2.IMREAD_GRAYSCALE), cv2.imread(sp, cv2.IMREAD_GRAYSCALE)
        elif args.cached_only:
            continue
        else:
            matte, sam = run_models(rgb)
            cv2.imwrite(mp, matte)
            cv2.imwrite(sp, sam)
        alpha, info = isolate(rgb.copy(), matte, sam)
        cv2.imwrite(os.path.join(SCAN_DIR, "alpha", name), alpha)
        info["t"] = round(t, 3)
        info["frame"] = name
        results.append(info)
        with open(os.path.join(SCAN_DIR, "scan.json"), "w") as f:
            json.dump({"fps": args.fps, "frames": results}, f, indent=1)
        print(f"{info['t']:6.2f}s clean={info['clean']!s:5} bite={info.get('bite')} border={info.get('border')!s:5} contam={info.get('contam')}", flush=True)


def cmd_move(args):
    """Export the clean scanned frames in [start, end) of the scan as one move."""
    with open(os.path.join(SCAN_DIR, "scan.json")) as f:
        scan = json.load(f)
    picked = [r for r in scan["frames"] if args.start <= r["t"] < args.end and (r["clean"] or args.allow_dirty)]
    if not picked:
        sys.exit(f"no clean frames in {args.start}-{args.end}")
    out_dir = os.path.join(ROOT, "work", "cat-frames", args.name)
    os.makedirs(out_dir, exist_ok=True)
    for f in glob.glob(os.path.join(out_dir, "*")):
        os.remove(f)
    # Shared crop: union bbox of the picked frames, so the cat doesn't jitter inside the move.
    x0 = min(r["bbox"][0] for r in picked); y0 = min(r["bbox"][1] for r in picked)
    x1 = max(r["bbox"][2] for r in picked); y1 = max(r["bbox"][3] for r in picked)
    pad = 6
    rgb0 = np.array(Image.open(os.path.join(SCAN_DIR, "raw", picked[0]["frame"])))
    H, W = rgb0.shape[:2]
    x0, y0, x1, y1 = max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)
    scale = args.height / (y1 - y0)
    size = (max(1, round((x1 - x0) * scale)), args.height)
    for n, r in enumerate(picked, 1):
        rgb = np.array(Image.open(os.path.join(SCAN_DIR, "raw", r["frame"])).convert("RGB"))
        a = cv2.imread(os.path.join(SCAN_DIR, "alpha", r["frame"]), cv2.IMREAD_GRAYSCALE)
        rgb = defringe(rgb, a)
        rgba = np.dstack([rgb, a])[y0:y1, x0:x1]
        Image.fromarray(rgba, "RGBA").resize(size, Image.LANCZOS).save(
            os.path.join(out_dir, f"{n:03d}.webp"), "WEBP", quality=82, method=6)
    print(f"{args.name}: {len(picked)} frames {[r['t'] for r in picked]} -> {size[0]}x{size[1]}")


def cmd_strips(args):
    """Pack each work/cat-frames/<move> into a boomerang sprite strip in assets/cat/ + manifest.json."""
    out = os.path.join(ROOT, "assets", "cat")
    os.makedirs(out, exist_ok=True)
    moves = []
    for name in args.moves:
        fs = sorted(glob.glob(os.path.join(ROOT, "work", "cat-frames", name, "*.webp")))
        if len(fs) < 2:
            print(f"skip {name}: {len(fs)} frames")
            continue
        ims = [Image.open(f).convert("RGBA") for f in fs]
        # Boomerang: 1..n then n-1..2, so the loop ends where it starts (no jump at the seam).
        seq = ims + ims[-2:0:-1]
        h = args.height
        w = max(round(im.width * h / im.height) for im in ims)
        strip = Image.new("RGBA", (w * len(seq), h), (0, 0, 0, 0))
        for i, im in enumerate(seq):
            im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
            strip.alpha_composite(im, (i * w + (w - im.width) // 2, 0))
        file = f"{name}.webp"
        strip.save(os.path.join(out, file), "WEBP", quality=args.quality, method=6)
        moves.append({"name": name, "file": file, "frames": len(seq), "w": w, "h": h})
        print(f"{file}: {len(seq)} frames {w}x{h}, {os.path.getsize(os.path.join(out, file))} bytes")
    with open(os.path.join(out, "manifest.json"), "w", newline=chr(13) + chr(10)) as f:
        json.dump({"version": 1, "moves": moves}, f, indent=2)
        f.write(chr(10))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("--fps", type=float, default=12)
    s.add_argument("--ranges", help="e.g. 3.0-3.5,4.0-5.0 (seconds); default: whole clip")
    s.add_argument("--cached-only", action="store_true", help="only re-score frames whose model outputs are cached")
    m = sub.add_parser("move"); m.add_argument("name"); m.add_argument("start", type=float); m.add_argument("end", type=float)
    m.add_argument("--height", type=int, default=360); m.add_argument("--allow-dirty", action="store_true")
    st = sub.add_parser("strips"); st.add_argument("moves", nargs="+")
    st.add_argument("--height", type=int, default=300); st.add_argument("--quality", type=int, default=80)
    args = ap.parse_args()
    {"scan": cmd_scan, "move": cmd_move, "strips": cmd_strips}[args.cmd](args)


if __name__ == "__main__":
    main()
