# -*- coding: utf-8 -*-
"""Conversor Markdown -> PDF (subset usado no relatorio da Atividade 03)."""
import re
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_JUSTIFY, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, HRFlowable, KeepTogether,
                                PageTemplate, Paragraph, Preformatted, Spacer, Table,
                                TableStyle)

FONTS = "C:/Windows/Fonts/"
pdfmetrics.registerFont(TTFont("Body", FONTS + "arial.ttf"))
pdfmetrics.registerFont(TTFont("Body-Bold", FONTS + "arialbd.ttf"))
pdfmetrics.registerFont(TTFont("Body-Italic", FONTS + "ariali.ttf"))
pdfmetrics.registerFont(TTFont("Body-BoldItalic", FONTS + "arialbi.ttf"))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold",
                              italic="Body-Italic", boldItalic="Body-BoldItalic")
pdfmetrics.registerFont(TTFont("Mono", FONTS + "consola.ttf"))
pdfmetrics.registerFont(TTFont("Mono-Bold", FONTS + "consolab.ttf"))
pdfmetrics.registerFontFamily("Mono", normal="Mono", bold="Mono-Bold",
                              italic="Mono", boldItalic="Mono-Bold")

ACCENT = colors.HexColor("#1F3864")
RULE = colors.HexColor("#BFBFBF")
HEADER_BG = colors.HexColor("#1F3864")
ROW_BG = colors.HexColor("#F2F4F8")
CODE_BG = colors.HexColor("#F5F5F5")

S = {
    "title": ParagraphStyle("title", fontName="Body-Bold", fontSize=17, leading=21,
                            textColor=ACCENT, spaceAfter=4),
    "subtitle": ParagraphStyle("subtitle", fontName="Body", fontSize=9.5, leading=13,
                               textColor=colors.HexColor("#444444"), spaceAfter=2),
    "h2": ParagraphStyle("h2", fontName="Body-Bold", fontSize=13, leading=16,
                         textColor=ACCENT, spaceBefore=16, spaceAfter=7),
    "h3": ParagraphStyle("h3", fontName="Body-Bold", fontSize=10.8, leading=14,
                         textColor=colors.HexColor("#2E4E7E"), spaceBefore=11, spaceAfter=5),
    "h4": ParagraphStyle("h4", fontName="Body-Bold", fontSize=9.8, leading=13,
                         textColor=colors.black, spaceBefore=9, spaceAfter=4),
    "body": ParagraphStyle("body", fontName="Body", fontSize=9.3, leading=13.4,
                           alignment=TA_JUSTIFY, spaceAfter=6),
    "bullet": ParagraphStyle("bullet", fontName="Body", fontSize=9.3, leading=13.2,
                             alignment=TA_LEFT, leftIndent=13, bulletIndent=3,
                             spaceAfter=3),
    "quote": ParagraphStyle("quote", fontName="Body-Italic", fontSize=8.8, leading=12.6,
                            alignment=TA_LEFT, leftIndent=10, rightIndent=6,
                            textColor=colors.HexColor("#333333"), spaceBefore=3,
                            spaceAfter=7, borderPadding=(6, 6, 6, 8),
                            backColor=colors.HexColor("#FBF7E8")),
    "checkitem": ParagraphStyle("checkitem", fontName="Body", fontSize=9.3,
                                leading=13.2, alignment=TA_LEFT, leftIndent=24,
                                bulletIndent=3, bulletFontName="Mono",
                                bulletFontSize=9.3, spaceAfter=3.5),
    "cell": ParagraphStyle("cell", fontName="Body", fontSize=8.1, leading=10.6),
    "cellhdr": ParagraphStyle("cellhdr", fontName="Body-Bold", fontSize=8.1, leading=10.6,
                              textColor=colors.white),
    "code": ParagraphStyle("code", fontName="Mono", fontSize=7.5, leading=9.8),
}


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def inline(t):
    """Markdown inline -> mini-HTML do reportlab."""
    t = esc(t)
    t = re.sub(r"`([^`]+)`",
               r'<font face="Mono" size="8" backColor="#EFEFEF">\1</font>', t)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<i>\1</i>", t)
    return t


def split_row(line):
    return [c.strip() for c in line.strip().strip("|").split("|")]


def make_table(rows, avail):
    header, body = rows[0], rows[1:]
    ncols = len(header)
    # largura proporcional ao conteudo, com piso e teto
    weights = []
    for i in range(ncols):
        lens = [len(header[i])] + [len(r[i]) if i < len(r) else 0 for r in body]
        weights.append(max(8, min(sum(sorted(lens)[-3:]) / 3.0, 95)))
    total = sum(weights)
    widths = [avail * w / total for w in weights]

    data = [[Paragraph(inline(c), S["cellhdr"]) for c in header]]
    for r in body:
        r = r + [""] * (ncols - len(r))
        data.append([Paragraph(inline(c), S["cell"]) for c in r[:ncols]])

    t = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), HEADER_BG),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]
    for i in range(2, len(data), 2):
        style.append(("BACKGROUND", (0, i), (-1, i), ROW_BG))
    t.setStyle(TableStyle(style))
    return t


def code_block(lines, avail):
    txt = "\n".join(lines)
    pre = Preformatted(txt, S["code"], maxLineLength=118, splitChars=" ,")
    t = Table([[pre]], colWidths=[avail], hAlign="LEFT")
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODE_BG),
        ("BOX", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 7),
        ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return t


def convert(md_path, pdf_path, footer_text):
    with open(md_path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()

    doc = BaseDocTemplate(pdf_path, pagesize=A4,
                          leftMargin=2 * cm, rightMargin=2 * cm,
                          topMargin=1.7 * cm, bottomMargin=1.7 * cm,
                          title="Relatorio - Atividade 03", author=footer_text)
    avail = doc.width
    frame = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="n")

    def on_page(canvas, d):
        canvas.saveState()
        canvas.setFont("Body", 7.4)
        canvas.setFillColor(colors.HexColor("#777777"))
        canvas.drawString(doc.leftMargin, 1.05 * cm, footer_text)
        canvas.drawRightString(A4[0] - doc.rightMargin, 1.05 * cm,
                               "Pagina %d" % canvas.getPageNumber())
        canvas.setStrokeColor(RULE)
        canvas.setLineWidth(0.4)
        canvas.line(doc.leftMargin, 1.35 * cm, A4[0] - doc.rightMargin, 1.35 * cm)
        canvas.restoreState()

    doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=on_page)])

    story = []
    after_title = False
    i = 0
    n = len(lines)
    while i < n:
        line = lines[i]
        stripped = line.strip()

        if not stripped:
            i += 1
            continue

        # bloco de codigo
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            story.append(Spacer(1, 2))
            story.append(code_block(buf, avail))
            story.append(Spacer(1, 7))
            continue

        # tabela
        if stripped.startswith("|") and i + 1 < n and re.match(
                r"^\|[\s:|-]+\|$", lines[i + 1].strip()):
            rows = [split_row(stripped)]
            i += 2
            while i < n and lines[i].strip().startswith("|"):
                rows.append(split_row(lines[i].strip()))
                i += 1
            story.append(Spacer(1, 2))
            story.append(make_table(rows, avail))
            story.append(Spacer(1, 8))
            continue

        # regua
        if re.match(r"^-{3,}$", stripped):
            story.append(Spacer(1, 4))
            story.append(HRFlowable(width="100%", thickness=0.6, color=RULE,
                                    spaceBefore=2, spaceAfter=8))
            i += 1
            continue

        # titulos
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            level, text = len(m.group(1)), m.group(2)
            if level == 1:
                story.append(Paragraph(inline(text), S["title"]))
                after_title = True
            else:
                story.append(Paragraph(inline(text), S["h%d" % level]))
                after_title = False
            i += 1
            continue

        # citacao (agrupa linhas consecutivas)
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            story.append(Paragraph(inline(" ".join(buf)), S["quote"]))
            continue

        # checklist (caixa desenhada com texto: Arial nao tem o glifo U+2610)
        m = re.match(r"^-\s+\[( |x)\]\s+(.*)$", stripped)
        if m:
            mark = "[x]" if m.group(1) == "x" else "[  ]"
            story.append(Paragraph(inline(m.group(2)), S["checkitem"],
                                   bulletText=mark))
            i += 1
            continue

        # lista nao ordenada (com continuacao indentada)
        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            text = m.group(1)
            i += 1
            while i < n and lines[i].startswith("  ") and lines[i].strip() \
                    and not re.match(r"^[-*]\s|^\d+\.\s", lines[i].strip()):
                text += " " + lines[i].strip()
                i += 1
            story.append(Paragraph(inline(text), S["bullet"], bulletText="\u2022"))
            continue

        # lista ordenada (com continuacao indentada)
        m = re.match(r"^(\d+)\.\s+(.*)$", stripped)
        if m:
            num, text = m.group(1), m.group(2)
            i += 1
            while i < n and lines[i].startswith("  ") and lines[i].strip() \
                    and not re.match(r"^[-*]\s|^\d+\.\s", lines[i].strip()):
                text += " " + lines[i].strip()
                i += 1
            story.append(Paragraph(inline(text), S["bullet"], bulletText=num + "."))
            continue

        # paragrafo; duas casas de espaco no fim da linha = quebra forcada.
        # As linhas sao unidas ANTES de converter o inline, senao um trecho
        # em negrito/codigo que atravessa a quebra de linha no fonte nao
        # casaria com a regex e os asteriscos sobrariam no PDF.
        HB = "\x00HB\x00"
        parts = [stripped]
        hard = line.endswith("  ")
        i += 1
        while i < n:
            raw = lines[i]
            nxt = raw.strip()
            if (not nxt or nxt.startswith("|") or nxt.startswith("#")
                    or nxt.startswith(">") or nxt.startswith("```")
                    or re.match(r"^-{3,}$", nxt)
                    or re.match(r"^[-*]\s|^\d+\.\s", nxt)):
                break
            parts.append((HB if hard else " ") + nxt)
            hard = raw.endswith("  ")
            i += 1
        text = inline("".join(parts)).replace(HB, "<br/>")
        story.append(Paragraph(text, S["subtitle"] if after_title else S["body"]))
        after_title = False

    doc.build(story)
    print("PDF gerado: %s (%d flowables)" % (pdf_path, len(story)))


if __name__ == "__main__":
    convert(sys.argv[1], sys.argv[2], sys.argv[3])
