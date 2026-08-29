#!/usr/bin/env python3
"""Build the Find-Engine portfolio demo video from verified browser captures."""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps


WIDTH = 1280
HEIGHT = 720
FPS = 30

PAPER = "#F4F1E8"
PAPER_2 = "#E9E5DA"
INK = "#17243D"
MUTED = "#657086"
SAGE = "#4E7569"
SAGE_LIGHT = "#DCE8E2"
AMBER = "#A66F27"
AMBER_LIGHT = "#F1E3C8"
RED = "#9F4D45"
RED_LIGHT = "#EEDDD9"
WHITE = "#FFFEF8"

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "demo" / "video" / "find-engine-demo.mp4"
DEFAULT_WORK = ROOT / "tmp" / "demo-video-slides"


def font(size: int, bold: bool = False, serif: bool = False) -> ImageFont.FreeTypeFont:
    candidates = []
    if serif:
        candidates.extend(
            [
                Path("C:/Windows/Fonts/georgiab.ttf" if bold else "C:/Windows/Fonts/georgia.ttf"),
                Path("C:/Windows/Fonts/palabi.ttf" if bold else "C:/Windows/Fonts/pala.ttf"),
            ]
        )
    else:
        candidates.extend(
            [
                Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf"),
                Path("C:/Windows/Fonts/arialbd.ttf" if bold else "C:/Windows/Fonts/arial.ttf"),
            ]
        )
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def rounded(draw: ImageDraw.ImageDraw, box: tuple[int, int, int, int], radius: int, fill: str, outline: str | None = None, width: int = 1) -> None:
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def shadow_card(canvas: Image.Image, box: tuple[int, int, int, int], radius: int = 18) -> None:
    x1, y1, x2, y2 = box
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((x1 + 6, y1 + 10, x2 + 6, y2 + 10), radius=radius, fill=(23, 36, 61, 34))
    canvas.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(12)))


def wrapped_lines(draw: ImageDraw.ImageDraw, text: str, text_font: ImageFont.ImageFont, max_width: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = f"{current} {word}".strip()
        if not current or draw.textbbox((0, 0), trial, font=text_font)[2] <= max_width:
            current = trial
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)
    return lines


def draw_wrapped(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, text_font: ImageFont.ImageFont, fill: str, max_width: int, line_gap: int = 8) -> int:
    x, y = xy
    ascent, descent = text_font.getmetrics()
    line_height = ascent + descent + line_gap
    for line in wrapped_lines(draw, text, text_font, max_width):
        draw.text((x, y), line, font=text_font, fill=fill)
        y += line_height
    return y


def base_canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    canvas = Image.new("RGBA", (WIDTH, HEIGHT), PAPER)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, WIDTH, 8), fill=SAGE)
    draw.ellipse((1120, -120, 1390, 150), fill=PAPER_2)
    draw.ellipse((-100, 610, 120, 830), fill=PAPER_2)
    return canvas, draw


def add_brand(draw: ImageDraw.ImageDraw, number: str | None = None) -> None:
    draw.text((46, 28), "FIND—ENGINE", font=font(18, bold=True), fill=INK)
    if number:
        draw.text((1168, 28), number, font=font(17, bold=True), fill=MUTED)


def build_intro(path: Path) -> None:
    canvas, draw = base_canvas()
    add_brand(draw)
    draw.text((84, 166), "Evidence before answers.", font=font(58, bold=True, serif=True), fill=INK)
    draw_wrapped(
        draw,
        (88, 252),
        "A public, reproducible PDF question-to-answer matching demo.",
        font(27),
        MUTED,
        790,
    )
    labels = [
        ("01", "Correct match", SAGE_LIGHT, SAGE),
        ("02", "Wrong-book refusal", RED_LIGHT, RED),
        ("03", "Evidence downgrade", AMBER_LIGHT, AMBER),
    ]
    x = 88
    for number, label, bg, fg in labels:
        rounded(draw, (x, 402, x + 330, 480), 14, bg)
        draw.text((x + 22, 420), number, font=font(19, bold=True), fill=fg)
        draw.text((x + 68, 418), label, font=font(22, bold=True), fill=INK)
        x += 350
    draw.text((88, 616), "60–90 SECOND PORTFOLIO DEMO", font=font(16, bold=True), fill=SAGE)
    canvas.convert("RGB").save(path, quality=95)


def build_scenario(
    source: Path,
    path: Path,
    number: str,
    kicker: str,
    title: str,
    result: str,
    detail: str,
    accent: str,
    accent_light: str,
    footer: str,
) -> None:
    canvas, draw = base_canvas()
    add_brand(draw, number)

    image_box = (44, 76, 884, 660)
    shadow_card(canvas, image_box)
    draw = ImageDraw.Draw(canvas)
    rounded(draw, image_box, 18, WHITE, outline="#D5D1C7", width=1)

    capture = Image.open(source).convert("RGB")
    capture = ImageOps.contain(capture, (820, 564), Image.Resampling.LANCZOS)
    screenshot = Image.new("RGB", (820, 564), WHITE)
    screenshot.paste(capture, ((820 - capture.width) // 2, (564 - capture.height) // 2))
    mask = Image.new("L", screenshot.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 819, 563), radius=13, fill=255)
    canvas.paste(screenshot, (54, 86), mask)

    right_x = 932
    right_width = 292
    rounded(draw, (right_x, 88, right_x + 158, 124), 18, accent_light)
    draw.text((right_x + 16, 96), kicker, font=font(15, bold=True), fill=accent)
    y = draw_wrapped(draw, (right_x, 158), title, font(34, bold=True, serif=True), INK, right_width, 6)
    y += 24
    rounded(draw, (right_x, y, right_x + right_width, y + 98), 16, accent)
    draw.text((right_x + 20, y + 18), result, font=font(36, bold=True), fill=WHITE)
    y += 124
    y = draw_wrapped(draw, (right_x, y), detail, font(21), MUTED, right_width, 8)
    y += 28
    draw.line((right_x, y, right_x + 62, y), fill=accent, width=4)
    y += 20
    draw_wrapped(draw, (right_x, y), footer, font(16, bold=True), accent, right_width, 6)
    canvas.convert("RGB").save(path, quality=95)


def build_outro(path: Path) -> None:
    canvas, draw = base_canvas()
    add_brand(draw)
    draw.text((86, 126), "Run the full demo locally.", font=font(50, bold=True, serif=True), fill=INK)
    draw.text((90, 202), "One command. Three safety-critical outcomes.", font=font(24), fill=MUTED)
    rounded(draw, (88, 290, 1190, 388), 18, INK)
    draw.text((122, 320), "npm install && npm run demo:web", font=font(27, bold=True), fill=WHITE)
    rounded(draw, (88, 428, 420, 506), 14, SAGE_LIGHT)
    draw.text((112, 449), "292 checks · 0 failed", font=font(22, bold=True), fill=SAGE)
    draw_wrapped(
        draw,
        (88, 572),
        "github.com/LZY0105/Math-answer-to-question-matching-model",
        font(20, bold=True),
        INK,
        1100,
    )
    canvas.convert("RGB").save(path, quality=95)


def render_video(ffmpeg: Path, slides: list[Path], output: Path) -> None:
    durations = [8, 20, 20, 20, 8]
    filters = []
    for index, duration in enumerate(durations):
        filters.append(
            f"[{index}:v]scale={WIDTH}:{HEIGHT},"
            f"trim=duration={duration},fps={FPS},settb=1/{FPS},"
            f"setpts=PTS-STARTPTS,format=yuv420p,"
            f"fade=t=in:st=0:d=0.5,fade=t=out:st={duration - 0.5}:d=0.5[v{index}]"
        )
    filters.append("[v0][v1][v2][v3][v4]concat=n=5:v=1:a=0[outv]")

    command = [str(ffmpeg), "-y"]
    for slide, duration in zip(slides, durations, strict=True):
        command.extend(["-loop", "1", "-framerate", str(FPS), "-t", str(duration), "-i", str(slide)])
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[outv]",
            "-an",
            "-r",
            str(FPS),
            "-c:v",
            "libx264",
            "-crf",
            "18",
            "-preset",
            "medium",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    subprocess.run(command, check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", type=Path, help="Path to the ffmpeg executable")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK)
    args = parser.parse_args()

    ffmpeg = args.ffmpeg or (Path(shutil.which("ffmpeg")) if shutil.which("ffmpeg") else None)
    if not ffmpeg or not ffmpeg.exists():
        raise SystemExit("ffmpeg was not found; pass --ffmpeg C:/path/to/ffmpeg.exe")

    sources = {
        "correct": ROOT / ".impeccable" / "review" / "demo-desktop.jpg",
        "wrong": ROOT / ".impeccable" / "review" / "demo-wrong.jpg",
        "review": ROOT / ".impeccable" / "review" / "demo-review.jpg",
    }
    missing = [str(path) for path in sources.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing verified browser capture(s): " + ", ".join(missing))

    args.work_dir.mkdir(parents=True, exist_ok=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)

    slides = [
        args.work_dir / "00-intro.jpg",
        args.work_dir / "01-correct.jpg",
        args.work_dir / "02-wrong-book.jpg",
        args.work_dir / "03-review.jpg",
        args.work_dir / "04-outro.jpg",
    ]
    build_intro(slides[0])
    build_scenario(
        sources["correct"],
        slides[1],
        "01 / 03",
        "CORRECT PAIR",
        "Question and answer evidence agree.",
        "24 exact",
        "All 24 indexed questions reach AUTO_MATCH with an exact, one-to-one answer assignment.",
        SAGE,
        SAGE_LIGHT,
        "VERIFIED_PAIR · AUTO_MATCH",
    )
    build_scenario(
        sources["wrong"],
        slides[2],
        "02 / 03",
        "WRONG BOOK",
        "Identity conflict stops the pipeline.",
        "0 answers",
        "A 2026 exercise book paired with a 2025 answer key is refused before question matching begins.",
        RED,
        RED_LIGHT,
        "REJECTED_PAIR · IDENTITY_MISMATCH",
    )
    build_scenario(
        sources["review"],
        slides[3],
        "03 / 03",
        "LOW EVIDENCE",
        "Unverified evidence cannot auto-answer.",
        "REVIEW",
        "When the adapter cannot honour the tapped region, the result is capped for human review.",
        AMBER,
        AMBER_LIGHT,
        "REGION_UNSUPPORTED_BY_ADAPTER",
    )
    build_outro(slides[4])
    render_video(ffmpeg, slides, args.output)
    try:
        rendered_path = args.output.resolve().relative_to(ROOT.resolve()).as_posix()
    except ValueError:
        rendered_path = args.output.name
    print(f"Rendered: {rendered_path}")


if __name__ == "__main__":
    main()
