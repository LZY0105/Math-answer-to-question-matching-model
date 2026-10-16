"""统一 TexTeller 标签中看不见的写法差异，让同一张图只对应一个训练目标。

TexTeller 对同一个印刷公式时而写 ``\\left( x \\right)``、时而写 ``(x)``，时而加
``\\,``、时而不加；这些差异在图上看不出来，模型只能瞎猜，逐字匹配因此注定有一
部分对不上。这里的规则只删改渲染上看不出、配对规范化本来也会抹掉的记号：

* 去掉细间距 ``\\,`` ``\\;`` ``\\:`` ``\\!``；``\\quad``、``\\qquad``、``\\ ``、``~`` 是
  看得见的空白，保留；
* 去掉 ``\\left`` ``\\right`` ``\\middle`` 与 ``\\big`` 一族，只留括号本身；后面跟
  ``.`` 的是不画任何东西的空定界符，连同 ``.`` 一起去掉；中间夹着 ``\\atop``、
  ``\\over`` 这类中缀命令的 ``\\left…\\right`` 在划定命令的作用范围，保留；
* 去掉 ``\\displaystyle`` 等字号切换命令；
* 同一符号的别名合并成训练集里更常用的写法：``\\rightarrow`` 并入 ``\\to``，
  ``\\vert`` ``\\lvert`` ``\\rvert`` 并入 ``|``，``\\lnot`` 并入 ``\\neg``，等等；
* 老教材拼黑板粗体的 ``I\\!\\!P``、``J\\!\\!J``、``1\\!\\!1`` 只留后一个字符：抽查的
  这类裁图都是普通粗体字母，而去掉 ``\\!`` 后剩下的 ``IP`` 是错的。

花括号、字体命令（``\\mathrm``、``\\mathsf`` 等）、``\\limits``、``\\geqslant``、
``\\dfrac`` 等在图上看得出区别，一律不动。输出按训练分词器的规则重新拼接，
所以同一组 token 只有一种字符串写法。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
from typing import Iterable

VERSION = "texteller-norm-v1"

# 与 scratch_model._TEX_TOKEN 完全相同（测试里逐条核对）；不直接导入，免得数据准备也要加载 torch
_TEX_TOKEN = re.compile(r"\\(?:begin|end)\{[a-zA-Z*]+\}|\\[A-Za-z]+|\\.|.", re.DOTALL)


def tokenize(latex: str) -> list[str]:
    return [token for token in _TEX_TOKEN.findall(latex) if not token.isspace()]

B = "\\"
THIN_SPACES = {B + ",", B + ";", B + ":", B + "!"}
SIZED = {B + "left", B + "right", B + "middle"}
BIG = {B + name for name in ("big", "Big", "bigg", "Bigg", "bigl", "bigr", "Bigl", "Bigr",
                             "biggl", "biggr", "Biggl", "Biggr", "bigm", "Bigm", "biggm", "Biggm")}
STYLE_SIZE = {B + name for name in ("displaystyle", "textstyle", "scriptstyle", "scriptscriptstyle")}
# 渲染完全相同的别名 -> 训练集里更常用的写法（\to 17,351 次，\rightarrow 9,189 次）
ALIASES = {
    B + "rightarrow": B + "to", B + "gets": B + "leftarrow",
    B + "le": B + "leq", B + "ge": B + "geq", B + "ne": B + "neq",
    B + "vert": "|", B + "lvert": "|", B + "rvert": "|",
    B + "Vert": B + "|", B + "lVert": B + "|", B + "rVert": B + "|",
    B + "lbrace": B + "{", B + "rbrace": B + "}", B + "lbrack": "[", B + "rbrack": "]",
    B + "lnot": B + "neg", B + "land": B + "wedge", B + "lor": B + "vee", B + "owns": B + "ni",
}
# 黑板粗体拼字的打头字符：I\!\!P、J\!\!J、1\!\!1
HACK_HEADS = {"I", "J", "1"}
# 中缀分式命令的作用范围是所在的整个组，\left…\right 正是这样一个组
INFIX = {B + name for name in ("over", "atop", "choose", "above", "brace", "brack",
                               "overwithdelims", "atopwithdelims", "abovewithdelims")}
_CONTROL_WORD = re.compile(r"\\[A-Za-z]+$")


def _grouping_sized(tokens: list[str]) -> set[int]:
    """\\left…\\right 之间有 \\atop 一类中缀命令时，这对命令在划定它的作用范围，
    去掉会变成「Ambiguous use of \\atop」，因此保留（连同其间的 \\middle）。"""
    keep: set[int] = set()
    stack: list[tuple[int, list[int]]] = []
    for i, token in enumerate(tokens):
        if token == B + "left":
            stack.append((i, []))
        elif token == B + "middle" and stack:
            stack[-1][1].append(i)
        elif token == B + "right" and stack:
            left, middles = stack.pop()
            if any(inner in INFIX for inner in tokens[left + 1:i]):
                keep.update((left, i, *middles))
    return keep


def normalize_tokens(tokens: Iterable[str]) -> list[str]:
    tokens = list(tokens)
    keep = _grouping_sized(tokens)
    out: list[str] = []
    i, n = 0, len(tokens)
    while i < n:
        token = tokens[i]
        if i in keep:
            out.append(token)
            i += 1
            continue
        if token in HACK_HEADS:
            j = i + 1
            while j < n and tokens[j] == B + "!":
                j += 1
            # 至少两个 \! 夹着两个单字符才是拼字；x\!y 这类单个负间距只是排版
            if j - i >= 3 and j < n and len(tokens[j]) == 1 and tokens[j].isalnum():
                out.append(tokens[j])
                i = j + 1
                continue
        if token in SIZED or token in BIG:
            i += 2 if i + 1 < n and tokens[i + 1] == "." else 1
            continue
        if token in THIN_SPACES or token in STYLE_SIZE:
            i += 1
            continue
        out.append(ALIASES.get(token, token))
        i += 1
    return out


def detokenize(tokens: Iterable[str]) -> str:
    """与 TeXTokenizer.decode 相同的拼接规则：控制词后紧跟字母时补一个空格。"""
    pieces: list[str] = []
    previous = ""
    for token in tokens:
        if _CONTROL_WORD.fullmatch(previous) and re.match(r"[A-Za-z]", token):
            pieces.append(" ")
        pieces.append(token)
        previous = token
    return "".join(pieces)


def normalize_label(latex: str) -> str:
    return detokenize(normalize_tokens(tokenize(latex)))


def normalize_manifest(source: Path, target: Path) -> dict:
    """逐行改写 latex 字段，原标签留在 latex_texteller；返回改动统计。"""
    rows = changed = before = after = 0
    with source.open(encoding="utf-8") as reader, target.open("w", encoding="utf-8", newline="\n") as writer:
        for line in reader:
            if not line.strip():
                continue
            row = json.loads(line)
            original = row["latex"]
            normalized = normalize_label(original)
            rows += 1
            changed += normalized != detokenize(tokenize(original))
            before += len(tokenize(original))
            after += len(tokenize(normalized))
            writer.write(json.dumps({**row, "latex": normalized, "latex_texteller": original}, ensure_ascii=False) + "\n")
    return {"rows": rows, "changed": changed, "tokens_before": before, "tokens_after": after, "version": VERSION}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    print(json.dumps(normalize_manifest(args.source, args.target), ensure_ascii=False))


if __name__ == "__main__":
    main()
