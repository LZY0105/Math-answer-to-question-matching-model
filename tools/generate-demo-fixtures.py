"""Generate the public synthetic PDF corpus used by the demo.

The PDFs contain no textbook material. They deliberately mirror only the
structural signals Find-Engine consumes: document identity, a chapter tree,
question bookmarks, question text, and answer-language evidence.
"""

from __future__ import annotations

import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "demo" / "fixtures" / "source.json"
OUTPUT = ROOT / "output" / "pdf" / "demo"
FONT_PATH = Path(r"C:\Windows\Fonts\simhei.ttf")
FONT_NAME = "FindEngineCJK"

INK = colors.HexColor("#14213D")
PAPER = colors.HexColor("#F8F6F0")
SAGE = colors.HexColor("#4F766A")
MUTED = colors.HexColor("#687076")
RULE = colors.HexColor("#D7DBD7")
WHITE = colors.white


def register_font() -> None:
    if not FONT_PATH.exists():
        raise FileNotFoundError(f"Required CJK font not found: {FONT_PATH}")
    pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_PATH)))


def formula_for(index: int) -> tuple[str, str]:
    power = index + 1
    prompt = f"求导数，f(x)=x^{power}+{index}x"
    answer = f"f'(x)={power}x^{power - 1}+{index}"
    return prompt, answer


def draw_header(c: canvas.Canvas, *, title: str, page: int) -> None:
    width, height = A4
    c.setFillColor(PAPER)
    c.rect(0, 0, width, height, stroke=0, fill=1)
    c.setFillColor(INK)
    c.rect(0, height - 24 * mm, width, 24 * mm, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont(FONT_NAME, 10)
    c.drawString(18 * mm, height - 15 * mm, title)
    c.setFillColor(MUTED)
    c.setFont(FONT_NAME, 8)
    c.drawRightString(width - 18 * mm, 12 * mm, f"Find-Engine synthetic fixture · {page}")


def draw_cover(c: canvas.Canvas, *, title: str, subtitle: str, year: str) -> None:
    width, height = A4
    c.setFillColor(PAPER)
    c.rect(0, 0, width, height, stroke=0, fill=1)
    c.setFillColor(INK)
    c.rect(0, 0, 17 * mm, height, stroke=0, fill=1)
    c.setFillColor(SAGE)
    c.rect(17 * mm, 0, 3 * mm, height, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont(FONT_NAME, 12)
    c.drawString(34 * mm, height - 54 * mm, "FIND-ENGINE · PUBLIC DEMO")
    c.setFont(FONT_NAME, 28)
    c.drawString(34 * mm, height - 78 * mm, title)
    c.setFillColor(MUTED)
    c.setFont(FONT_NAME, 14)
    c.drawString(34 * mm, height - 94 * mm, subtitle)
    c.setFillColor(SAGE)
    c.setFont(FONT_NAME, 18)
    c.drawString(34 * mm, height - 122 * mm, year)
    c.setStrokeColor(RULE)
    c.line(34 * mm, height - 137 * mm, width - 28 * mm, height - 137 * mm)
    c.setFillColor(MUTED)
    c.setFont(FONT_NAME, 10)
    c.drawString(34 * mm, height - 151 * mm, "完全合成内容 · CC0-1.0 · 可公开复现")


def draw_question(c: canvas.Canvas, *, heading: str, prompt: str, body: str, page: int) -> None:
    width, height = A4
    draw_header(c, title="Find-Engine 公开合成样本", page=page)
    x = 22 * mm
    y = height - 45 * mm
    c.setFillColor(SAGE)
    c.roundRect(x, y - 8 * mm, 26 * mm, 10 * mm, 2 * mm, stroke=0, fill=1)
    c.setFillColor(WHITE)
    c.setFont(FONT_NAME, 11)
    c.drawCentredString(x + 13 * mm, y - 4.7 * mm, heading)

    styles = getSampleStyleSheet()
    prompt_style = ParagraphStyle(
        "Prompt", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=18,
        leading=28, textColor=INK, spaceAfter=12,
    )
    body_style = ParagraphStyle(
        "Body", parent=styles["BodyText"], fontName=FONT_NAME, fontSize=11,
        leading=19, textColor=MUTED,
    )
    prompt_para = Paragraph(prompt, prompt_style)
    _, prompt_height = prompt_para.wrap(width - 44 * mm, 80 * mm)
    prompt_para.drawOn(c, x, y - 27 * mm - prompt_height)
    body_para = Paragraph(body, body_style)
    _, body_height = body_para.wrap(width - 44 * mm, 80 * mm)
    body_para.drawOn(c, x, y - 48 * mm - prompt_height - body_height)

    c.setStrokeColor(RULE)
    c.roundRect(x, 42 * mm, width - 44 * mm, 92 * mm, 4 * mm, stroke=1, fill=0)
    c.setFillColor(colors.HexColor("#EFF2EE"))
    c.roundRect(x + 8 * mm, 52 * mm, width - 60 * mm, 15 * mm, 3 * mm, stroke=0, fill=1)
    c.setFillColor(MUTED)
    c.setFont(FONT_NAME, 9)
    c.drawString(x + 13 * mm, 58 * mm, "此区域保留用于演示题目定位与答案跳转")


def build_pdf(path: Path, *, role: str, year: str, spec: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(path), pagesize=A4, pageCompression=1)
    c.setTitle(f"{year} {spec['subject']} {role}")
    c.setAuthor("Find-Engine contributors")
    c.setSubject("Public synthetic fixture; no copyrighted source material")

    title = "数学分析习题册" if role == "exercise" else "数学分析完整答案"
    draw_cover(c, title=title, subtitle=spec["chapter"], year=year)
    c.bookmarkPage("chapter-1")
    c.addOutlineEntry(f"{spec['chapter']} · {year} 年数学分析", "chapter-1", level=0)
    c.showPage()

    for index in range(1, spec["questionCount"] + 1):
        label = f"1.{index}"
        prompt, result = formula_for(index)
        destination = f"q-{index}"
        c.bookmarkPage(destination)
        c.addOutlineEntry(f"例题 {label}", destination, level=1)

        lead = f"例题 {label} ({year}. {spec['institution']}). {prompt}"
        if role == "answer":
            body = f"解答：由 {prompt[4:]} 可得，因此 答案：{result}，所以证毕。综上，数学分析与导数的结论成立，故得证。"
        else:
            body = f"其中数学分析与导数为本节内容，{prompt[4:]} 为待求函数。请写出完整计算过程。"

        draw_question(c, heading=f"例题 {label}", prompt=lead, body=body, page=index + 1)
        c.showPage()

    c.save()


def main() -> None:
    register_font()
    spec = json.loads(SOURCE.read_text(encoding="utf-8"))
    outputs = {
        "exercise": OUTPUT / "find-engine-exercise-book.pdf",
        "answer": OUTPUT / "find-engine-answer-key.pdf",
        "wrong": OUTPUT / "find-engine-wrong-year-answer-key.pdf",
    }
    build_pdf(outputs["exercise"], role="exercise", year=spec["year"], spec=spec)
    build_pdf(outputs["answer"], role="answer", year=spec["year"], spec=spec)
    build_pdf(outputs["wrong"], role="answer", year=spec["wrongYear"], spec=spec)
    for name, path in outputs.items():
        print(f"{name}: {path.relative_to(ROOT)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
