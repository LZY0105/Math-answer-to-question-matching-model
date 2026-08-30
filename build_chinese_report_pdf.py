from __future__ import annotations

import argparse
import html
import re
from pathlib import Path

from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm, mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    HRFlowable,
    Image,
    KeepTogether,
    LongTable,
    PageBreak,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    TableStyle,
)


NAVY = colors.HexColor("#17365D")
TEAL = colors.HexColor("#2F6B73")
GOLD = colors.HexColor("#B08D57")
INK = colors.HexColor("#20252B")
MUTED = colors.HexColor("#5F6B76")
LIGHT = colors.HexColor("#F2F5F7")
LIGHT_BLUE = colors.HexColor("#E8EEF5")
GRID = colors.HexColor("#AAB4BE")
RED = colors.HexColor("#9B1C1C")


TABLE_TITLES = [
    "相关对齐系统比较",
    "四阶段级联的信号、适用条件与成本",
    "文本层质量状态及处理方式",
    "置信度等级与证据基础",
    "评估语料构成",
    "保留完整文档结构时的端到端结果",
    "书签消融实验结果",
    "书签消融条件下的页面级延迟",
    "运算符上下文窗口半径扫描",
    "位置先验在不同文档条件下的表现",
    "复现实验所含测试套件",
    "系统实测常量及其来源",
]
FIGURE_RE = re.compile(
    r"(?:\[\[FIGURE_([1-4])\]\]|!\[[^\]]*\]\(figures/cn_report/figure_([1-4])\.png\))"
)


def register_fonts():
    pdfmetrics.registerFont(TTFont("SimSun", r"C:\Windows\Fonts\simsun.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("MSYH", r"C:\Windows\Fonts\msyh.ttc", subfontIndex=0))
    bold_path = Path(r"C:\Windows\Fonts\msyhbd.ttc")
    pdfmetrics.registerFont(TTFont("MSYH-Bold", str(bold_path if bold_path.exists() else r"C:\Windows\Fonts\msyh.ttc"), subfontIndex=0))
    pdfmetrics.registerFont(TTFont("Consolas", r"C:\Windows\Fonts\consola.ttf"))
    pdfmetrics.registerFont(TTFont("SegoeUISymbol", r"C:\Windows\Fonts\seguisym.ttf"))
    pdfmetrics.registerFont(TTFont("Nirmala", r"C:\Windows\Fonts\Nirmala.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("Leelawadee", r"C:\Windows\Fonts\LeelawUI.ttf"))
    pdfmetrics.registerFont(TTFont("Himalaya", r"C:\Windows\Fonts\himalaya.ttf"))
    pdfmetrics.registerFont(TTFont("Sylfaen", r"C:\Windows\Fonts\sylfaen.ttf"))
    pdfmetrics.registerFont(TTFont("MyanmarText", r"C:\Windows\Fonts\mmrtext.ttf"))
    pdfmetrics.registerFont(TTFont("SegoeUI", r"C:\Windows\Fonts\segoeui.ttf"))
    pdfmetrics.registerFont(TTFont("Gadugi", r"C:\Windows\Fonts\gadugi.ttf"))
    pdfmetrics.registerFont(TTFont("Arial", r"C:\Windows\Fonts\arial.ttf"))


def markup(text: str) -> str:
    pattern = re.compile(r"(\*\*.+?\*\*|`[^`]+`|\*[^*]+\*)")
    parts = []
    pos = 0
    for match in pattern.finditer(text):
        parts.append(html.escape(text[pos : match.start()]))
        token = match.group(0)
        if token.startswith("**"):
            parts.append(f'<font name="MSYH-Bold">{html.escape(token[2:-2])}</font>')
        elif token.startswith("`"):
            parts.append(f'<font name="Consolas" color="#2F6B73">{html.escape(token[1:-1])}</font>')
        else:
            parts.append(f'<i>{html.escape(token[1:-1])}</i>')
        pos = match.end()
    parts.append(html.escape(text[pos:]))
    result = "".join(parts)
    for digit in "₀₁₂₃₄₅₆₇₈₉":
        result = result.replace(digit, f'<font name="SegoeUISymbol">{digit}</font>')
    return result


def code_markup(text: str) -> str:
    def family(ch: str) -> str:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF or 0x3000 <= cp <= 0x303F or 0xFF00 <= cp <= 0xFFEF:
            return "SimSun"
        if 0x0900 <= cp <= 0x09FF:
            return "Nirmala"
        if 0x0E00 <= cp <= 0x0E7F:
            return "Leelawadee"
        if 0x0F00 <= cp <= 0x0FFF:
            return "Himalaya"
        if 0x0530 <= cp <= 0x058F or 0x10A0 <= cp <= 0x10FF:
            return "Sylfaen"
        if 0x0590 <= cp <= 0x05FF:
            return "Arial"
        if 0x1000 <= cp <= 0x109F:
            return "MyanmarText"
        if 0x1400 <= cp <= 0x167F:
            return "Gadugi"
        if 0x2080 <= cp <= 0x209F:
            return "SegoeUISymbol"
        return "Consolas" if cp < 128 else "SegoeUI"

    result = []
    current_font = None
    buffer = []

    def flush():
        nonlocal buffer
        if not buffer:
            return
        escaped = html.escape("".join(buffer)).replace(" ", "&nbsp;")
        result.append(f'<font name="{current_font}">{escaped}</font>')
        buffer = []

    for ch in text:
        if ch == "\n":
            flush()
            result.append("<br/>")
            current_font = None
            continue
        selected = family(ch)
        if selected != current_font:
            flush()
            current_font = selected
        buffer.append(ch)
    flush()
    return "".join(result)


def make_styles():
    styles = getSampleStyleSheet()
    body = ParagraphStyle(
        "ChineseBody",
        parent=styles["BodyText"],
        fontName="SimSun",
        fontSize=10.5,
        leading=17.2,
        textColor=INK,
        alignment=TA_JUSTIFY,
        firstLineIndent=21,
        spaceAfter=6,
        wordWrap="CJK",
        allowWidows=0,
        allowOrphans=0,
    )
    abstract = ParagraphStyle(
        "Abstract",
        parent=body,
        leading=16.2,
        spaceAfter=5,
    )
    h1 = ParagraphStyle(
        "H1CN",
        fontName="MSYH-Bold",
        fontSize=15,
        leading=21,
        textColor=NAVY,
        spaceBefore=15,
        spaceAfter=8,
        keepWithNext=True,
        wordWrap="CJK",
    )
    h2 = ParagraphStyle(
        "H2CN",
        fontName="MSYH-Bold",
        fontSize=12.5,
        leading=18,
        textColor=TEAL,
        spaceBefore=11,
        spaceAfter=6,
        keepWithNext=True,
        wordWrap="CJK",
    )
    caption = ParagraphStyle(
        "CaptionCN",
        fontName="SimSun",
        fontSize=8.7,
        leading=13,
        textColor=MUTED,
        alignment=TA_CENTER,
        spaceBefore=4,
        spaceAfter=8,
        wordWrap="CJK",
    )
    table_caption = ParagraphStyle(
        "TableCaptionCN",
        parent=caption,
        fontName="MSYH-Bold",
        textColor=NAVY,
        alignment=TA_LEFT,
        spaceBefore=7,
        spaceAfter=4,
        keepWithNext=True,
    )
    keywords = ParagraphStyle(
        "Keywords",
        parent=body,
        fontName="MSYH",
        fontSize=9.5,
        leading=15,
        textColor=TEAL,
        firstLineIndent=0,
        spaceBefore=5,
        spaceAfter=10,
    )
    callout = ParagraphStyle(
        "Callout",
        parent=body,
        fontSize=9.2,
        leading=14.5,
        textColor=NAVY,
        firstLineIndent=0,
        leftIndent=10,
        rightIndent=10,
        borderColor=colors.HexColor("#B9C7D5"),
        borderWidth=0.5,
        borderPadding=8,
        backColor=LIGHT_BLUE,
        spaceBefore=6,
        spaceAfter=9,
    )
    note = ParagraphStyle(
        "Note",
        parent=body,
        fontSize=8.6,
        leading=12.5,
        textColor=MUTED,
        firstLineIndent=0,
        spaceAfter=5,
    )
    list_style = ParagraphStyle(
        "ListCN",
        parent=body,
        firstLineIndent=0,
        leftIndent=22,
        bulletIndent=3,
        leading=15.5,
        spaceAfter=5,
    )
    code = ParagraphStyle(
        "CodeCN",
        fontName="Consolas",
        fontSize=8.3,
        leading=12,
        textColor=INK,
        leftIndent=10,
        rightIndent=10,
        borderColor=colors.HexColor("#D5DCE1"),
        borderWidth=0.5,
        borderPadding=8,
        backColor=LIGHT,
        spaceBefore=5,
        spaceAfter=8,
    )
    return {
        "body": body,
        "abstract": abstract,
        "h1": h1,
        "h2": h2,
        "caption": caption,
        "table_caption": table_caption,
        "keywords": keywords,
        "callout": callout,
        "note": note,
        "list": list_style,
        "code": code,
    }


def draw_later_pages(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setFont("MSYH-Bold", 8.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(27.5 * mm, height - 15 * mm, "FIND-ENGINE　技术研究报告")
    canvas.setStrokeColor(colors.HexColor("#CBD3DA"))
    canvas.setLineWidth(0.5)
    canvas.line(27.5 * mm, height - 18 * mm, width - 24.5 * mm, height - 18 * mm)
    canvas.setFont("MSYH", 8.2)
    canvas.drawRightString(width - 24.5 * mm, 14 * mm, f"第 {canvas.getPageNumber()} 页")
    canvas.restoreState()



def read_version(markdown_path: Path):
    """Version and date come from the report, never from this file.

    They were hardcoded here as 1.0 / 2026-08-25 and stayed there while the
    report moved on, so the built paper contradicted its own source. The
    markdown line looks like:  *版本 2.0｜2026 年 8 月 28 日*
    """
    for line in markdown_path.read_text(encoding="utf-8").splitlines()[:20]:
        m = re.match(r"^\*\s*(版本[^｜|]*)[｜|]\s*(.+?)\s*\*$", line.strip())
        if m:
            return m.group(1).strip(), m.group(2).strip()
    raise SystemExit("no '*版本 X｜日期*' line found in %s" % markdown_path)

def title_story(version, date):
    title = ParagraphStyle(
        "PaperTitle",
        fontName="MSYH-Bold",
        fontSize=20,
        leading=28,
        textColor=NAVY,
        alignment=TA_CENTER,
        spaceAfter=7,
    )
    meta = ParagraphStyle(
        "PaperMeta",
        fontName="MSYH",
        fontSize=9.5,
        leading=15,
        textColor=MUTED,
        alignment=TA_CENTER,
    )
    return [
        Paragraph("Find-Engine：面向成对数学 PDF 的<br/>确定性题目-答案对齐", title),
        Paragraph(f"{version}　{date}", meta),
        Spacer(1, 2 * mm),
        HRFlowable(width="100%", thickness=0.8, color=GOLD, hAlign="CENTER"),
        Spacer(1, 4 * mm),
    ]


def choose_col_widths(rows):
    cols = len(rows[0])
    total = 160 * mm
    if cols == 2:
        first_max = max(len(r[0]) for r in rows)
        return [44 * mm, 116 * mm] if first_max < 16 else [76 * mm, 84 * mm]
    if cols == 3:
        return [42 * mm, 32 * mm, 86 * mm]
    if cols == 4:
        return [30 * mm, 44 * mm, 47 * mm, 39 * mm]
    if cols == 7:
        return [31 * mm, 28 * mm, 28 * mm, 15 * mm, 14 * mm, 19 * mm, 25 * mm]
    return [total / cols] * cols


def make_table(rows, number, styles):
    title = TABLE_TITLES[number - 1] if number <= len(TABLE_TITLES) else f"数据汇总 {number}"
    caption = Paragraph(f"表 {number}　{title}", styles["table_caption"])
    cols = len(rows[0])
    font_size = 7.5 if cols >= 4 else 8.3
    header_style = ParagraphStyle("TH", fontName="MSYH-Bold", fontSize=font_size, leading=font_size + 3,
                                  textColor=colors.white, alignment=TA_CENTER, wordWrap="CJK")
    cell_style = ParagraphStyle("TD", fontName="SimSun", fontSize=font_size, leading=font_size + 3.4,
                                textColor=INK, alignment=TA_LEFT, wordWrap="CJK")
    number_style = ParagraphStyle("TDN", parent=cell_style, alignment=TA_CENTER)
    data = []
    for r_idx, row in enumerate(rows):
        converted = []
        for value in row:
            numeric = bool(re.fullmatch(r"[\d\s.,/%*†—-]+", re.sub(r"\*", "", value)))
            converted.append(Paragraph(markup(value), header_style if r_idx == 0 else (number_style if numeric else cell_style)))
        data.append(converted)
    table = LongTable(data, colWidths=choose_col_widths(rows), repeatRows=1, hAlign="LEFT")
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("GRID", (0, 0), (-1, -1), 0.45, GRID),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]
    for idx in range(2, len(rows), 2):
        commands.append(("BACKGROUND", (0, idx), (-1, idx), LIGHT))
    table.setStyle(TableStyle(commands))
    return [caption, table, Spacer(1, 3.5 * mm)]


def parse_table(lines, start):
    rows = []
    i = start
    while i < len(lines) and lines[i].strip().startswith("|"):
        parts = [x.strip() for x in lines[i].strip().strip("|").split("|")]
        if i != start + 1:
            rows.append(parts)
        i += 1
    return rows, i


def scaled_image(path: Path):
    with PILImage.open(path) as im:
        w, h = im.size
    max_w, max_h = 160 * mm, 112 * mm
    scale = min(max_w / w, max_h / h)
    return Image(str(path), width=w * scale, height=h * scale, hAlign="CENTER")


def build(markdown_path: Path, output_path: Path, figures_dir: Path):
    register_fonts()
    styles = make_styles()
    lines = markdown_path.read_text(encoding="utf-8").splitlines()
    story = title_story(*read_version(markdown_path))
    start = next(i for i, line in enumerate(lines) if line.startswith("## 摘要"))
    i = start
    table_no = 0
    list_no = 0
    in_abstract = False
    pending_figure = None

    while i < len(lines):
        line = lines[i].strip()
        if not line or line == "---":
            i += 1
            continue
        if line.startswith("## "):
            title = line[3:].strip()
            in_abstract = title == "摘要"
            if title.startswith("附录 "):
                story.append(PageBreak())
            story.append(Paragraph(markup(title), styles["h1"]))
            i += 1
            continue
        if line.startswith("### "):
            story.append(Paragraph(markup(line[4:].strip()), styles["h2"]))
            i += 1
            continue
        figure_match = FIGURE_RE.fullmatch(line)
        if figure_match:
            figure_no = int(figure_match.group(1) or figure_match.group(2))
            pending_figure = scaled_image(figures_dir / f"figure_{figure_no}.png")
            i += 1
            continue
        if line.startswith("|") and i + 1 < len(lines) and re.match(r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            rows, i = parse_table(lines, i)
            table_no += 1
            story.extend(make_table(rows, table_no, styles))
            continue
        if line.startswith("```"):
            i += 1
            code_lines = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            i += 1
            story.append(Paragraph(code_markup("\n".join(code_lines)), styles["code"]))
            continue
        if re.match(r"^\d+\.\s+", line):
            list_no += 1
            content = re.sub(r"^\d+\.\s+", "", line)
            story.append(Paragraph(markup(content), styles["list"], bulletText=f"{list_no}."))
            i += 1
            continue
        else:
            list_no = 0

        parts = [line]
        i += 1
        while i < len(lines):
            nxt = lines[i].strip()
            if not nxt:
                i += 1
                break
            if (
                nxt == "---"
                or nxt.startswith("## ")
                or nxt.startswith("### ")
                or nxt.startswith("|")
                or nxt.startswith("```")
                or FIGURE_RE.fullmatch(nxt)
                or re.match(r"^\d+\.\s+", nxt)
            ):
                break
            parts.append(nxt)
            i += 1
        content = " ".join(parts)
        is_fig_caption = bool(re.match(r"^\*\*图\s*\d+", content))
        if is_fig_caption:
            caption = Paragraph(markup(content), styles["caption"])
            if pending_figure is not None:
                story.append(KeepTogether([pending_figure, Spacer(1, 1.5 * mm), caption]))
                pending_figure = None
            else:
                story.append(caption)
        elif content.startswith("**关键词：**"):
            story.append(Paragraph(markup(content), styles["keywords"]))
        elif content.startswith("**插图索引：**"):
            story.append(Paragraph(markup(content), styles["callout"]))
        elif content.startswith("†"):
            story.append(Paragraph(markup(content), styles["note"]))
        else:
            story.append(Paragraph(markup(content), styles["abstract"] if in_abstract else styles["body"]))

    doc = SimpleDocTemplate(
        str(output_path),
        pagesize=A4,
        leftMargin=27.5 * mm,
        rightMargin=24.5 * mm,
        topMargin=25.5 * mm,
        bottomMargin=24.5 * mm,
        title="Find-Engine：面向成对数学 PDF 的确定性题目-答案对齐",
        subject="确定性题目-答案对齐技术研究报告",
        author="",
    )
    doc.build(story, onFirstPage=draw_later_pages, onLaterPages=draw_later_pages)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("markdown", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--figures-dir", type=Path, required=True)
    args = parser.parse_args()
    build(args.markdown, args.output, args.figures_dir)


if __name__ == "__main__":
    main()
