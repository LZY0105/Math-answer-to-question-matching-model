# First pass over the textbook release

What the engine does with 22 of the 63 volumes, read through the demo's PDF.js
adapter on 2026-09-24. This is the first material from outside the 考研 series
the engine was built on; the research report's threats-to-validity section said
such a set did not exist. It now does, with one large limit stated first.

## The limit

**Every matched pair in this release has a scanned side.** Of the 22 volumes,
15 have no text layer at all, one has a layer on 0.2% of its pages, and two
extract with no Chinese (broken font map). Only four carry a usable text layer,
and no two of them belong together. The released matching path — a text layer
on both sides — never runs end to end here. Nothing below is a recall figure.

What the release does exercise is everything that decides before matching
starts: the text-quality gate, the outline classifier on bookmark trees written
by other tools, subject detection on subjects the engine had never seen, and
the pairing matrix.

## Volumes read

| id | volume | pages | text layer | bookmarks |
|---|---|---:|---|---|
| book-003 | 谢惠民 上 | 442 | scanned | 3 levels, sections only |
| book-017 | 王高雄 常微分方程 | 264 | scanned | 2 nodes |
| book-018 | 数值分析 | 339 | scanned | **331 flat, one per page** |
| book-022 | 姜礼尚 数学物理方程 | 249 | scanned | none |
| book-023 | 茆诗松 概率论 | 490 | usable, 1,034 chars/page | 3 levels, sections and 习题 sets |
| book-026 | 绿皮书 | 492 | sparse, 0.2% of pages | 3 levels, **87 "习题 n.n"** |
| book-027 | 谷超豪 数学物理方程 | 213 | scanned | none |
| book-028 | 杨子胥 近世代数 | 188 | usable | 2 levels, § sections |
| book-031 | 韩士安 近世代数 | 255 | scanned | 67 flat sections |
| book-038 | 数值分析 答案 | 49 | scanned | none |
| book-040 | 杨子胥 习题解 | 615 | scanned | none |
| book-041 | 茆诗松 习题与解答 | 462 | scanned | none |
| book-043 | 江泽坚 习题解答 | 76 | opaque, 0.02% Han | 2 nodes |
| book-044 | 绿皮书答案 | 175 | opaque, 0% Han | 2 levels, sections only |
| book-049 | 谷超豪 答案 | 44 | usable | none |
| book-050 | 近世代数三百题 答案 | 146 | scanned | none |
| book-051 | 韩士安 习题解答 | 222 | scanned | **218 flat, one per page** |
| book-056 | 北大六版 | 342 | scanned | none |
| book-057 | 数学分析 第六版 上 | 329 | scanned | none |
| book-061 | 王高雄 习题详解 | 258 | usable | none |
| book-062 | 近世代数三百题 | 192 | scanned | none |
| book-063 | 高等代数 考研教案 | 452 | usable | none |

The quality gate's verdict agreed with a reading of every volume. The two
opaque books are the case the report describes: mathematics extracts, prose
does not.

## Pairing matrix

Every volume against every other, both orientations, sampled at about 40
pages per pairing.

| | |
|---|---|
| Ordered pairings | 462 |
| Producing any automatic answer | **0** |
| Blocked at document level (role or subject conflict) | 28 |
| Held at OCR_REQUIRED | 402 |
| Held at UNKNOWN_PAIR with a text layer both sides | 32 |

No pairing was verified, which is correct: none is a matched pair with text
on both sides.

## Three defects, found and fixed

**A bookmark per page indexed as a question level.** Two scanned volumes
(book-018, book-051) carry one bookmark per page titled with the printed page
number: 326 and 213 flat nodes, every title equal to its page minus a constant
(12 and 8). The classifier's "dense short-span identifier cohort" rule read
both as question levels, and they indexed as 326 and 213 questions no book
asks. Other gates kept the matrix at zero leaks, but with OCR those trees
would have driven matching. The classifier now recognises a cohort of flat
integer ids that tracks the page counter at a single offset on 90% or more of
at least ten nodes as `PAGE_MARKER`, which enters neither the question index
nor the section anchors. `src/outline-classify.js`.

**A trusted marker with no id.** book-026 carries 87 "习题 n.n" bookmarks. The
classifier accepts 习题 as a question marker and called the cohort questions;
the id parser knew only 例题, so every node received an empty id and the book
indexed as nothing. `idFromOutlineTitle` now reads the same marker vocabulary
the classifier trusts (例题, 习题, 练习题, 例, 第 n 题, Example, Exercise,
Problem). The book now indexes 69 exercise sets with section-scoped ids.
`src/question-id.js`.

**Subject detection silent or wrong outside two subjects.** The detector knew
Mathematical Analysis and Algebra and read anything else as MIXED, which
never rejects. Worse, it named MATH_ANALYSIS on a differential-equations
answer book (book-061), a PDE answer book (book-049) and a probability
textbook (book-023), because 极限 and 积分 are the working vocabulary of every
analysis-family subject. It now knows ten subjects, decides by the words that
name a subject before the words that belong to its topics, and requires a
two-to-one margin either way. On the 22 volumes: no wrong confident verdict,
the subject named on all four volumes with readable text and a name to read,
MIXED on the rest. The two original subjects keep their original topic lists,
so the 考研 books classify as before — that last claim still has to be
confirmed by rerunning the corpus suites on a machine that has the corpus.
`src/pair-verifier.js`.

## What the release also shows, and is left as measured

- **Role thresholds do not transfer.** book-061 is a genuine 习题详解 and
  scores 0.84 on answer language and 0.85 on explicit answers, against a 0.97
  threshold set on the 考研 keys. It is a body index, so the verdict is UNKNOWN
  rather than a rejection, and that is the right outcome for the wrong reason.
- **Printed years are not exam years.** Two volumes report a year from their
  print date (2016, 2022). On the 考研 books the year in every running head is
  the exam year and is identity; on a textbook it is a printing and can differ
  between a book and its answer volume. No pair here had a year on both sides,
  so the false-rejection this implies is not yet observed.
- **Pair preparation on two large body indexes takes seconds.** book-043
  against book-063 took 13 s with the sampled page loop, most of it in the
  content-anchor check and the page alignment over 579 body entries. The
  profile cache introduced earlier applies; the remaining cost is the bigram
  Dice itself.

## Reproducing

```sh
node datasets/books-20260924/download.mjs --id book-003 book-017 book-018 book-022 book-023 \
  book-026 book-027 book-028 book-031 book-038 book-040 book-041 book-043 book-044 book-049 \
  book-050 book-051 book-056 book-057 book-061 book-062 book-063 --out ../find-engine-books
node tools/extract-books.mjs --books ../find-engine-books
FIND_ENGINE_BOOKS=../find-engine-books/extracted node test/test_books_20260924.js
```

`test/test_books_20260924.js` asserts everything in this note that the engine
can check by itself, and skips without the extracted books.
