# Find-Engine

[English](README.md) | [简体中文](README.zh-CN.md)

把习题册中的题目与另一本答案册里的答案对应起来，让正在阅读教材的学生能直接看到眼前题目的答案。

面对两份 PDF，除书中印刷内容外没有任何共享标识符，本引擎会判断每条答案究竟属于哪道题；证据不足时则拒绝匹配。

纯 JavaScript、零依赖、无需网络。项目从一款 Android 数学学习平板应用中抽离出来，并完全在设备端运行。

> **📄 [研究报告](RESEARCH-REPORT.md)** — 包含完整的设计依据、评测方法、消融实验、参数扫描，以及两个有记录的负面结果。下文只是摘要，详细内容以报告为准。

## 问题背景

题号会在每章重新开始，因此一本书中可能有多个“12”。题目内容通常很短，而答案条目往往只有结果。题目之间的文字表述也高度相似：在一页求导习题中，每道题几乎都是“求函数……的导数”，所以整串文本相似度无法区分它们。

所有问题之下还有一条根本原则：**错配比不匹配更糟。** 缺少答案只是带来不便；错误答案却会以与正确答案同样的权威性呈现，学生无法察觉，后续系统也会自信地把原本正确的作答判断为错误。

## 工作原理

引擎依次经过四个阶段，先使用成本最低的信号。一道题一旦被某个阶段解决，后续阶段便不再运行。

| 阶段 | 信号 | 解决的问题 |
|---|---|---|
| **0** | PDF 书签树中的层级题号 | 同一题号在两本书中都只出现一次 |
| **1** | 单调且感知层级的目录对齐 | 把搜索范围缩小到答案册中的一个章节 |
| **2** | 结合运算符上下文的数学加权相似度 | 题号重复或缺失 |
| **3** | 有界 Needleman–Wunsch 对齐 | 内容信息很少时利用位置顺序 |

在 2023 年语料上，508 道题全部在**阶段 0**解决：标识符本身就是答案，因此完全不需要内容比较。

**运算符上下文**是其中最不直观的一环。二元组相似度本质上是一个“袋”：它统计哪些字符对出现过，却不关心它们出现在哪里。`x^2+3x` 与 `x^3+5x` 的区别集中在运算符周围，因此引擎会锚定每个运算符，并分别向左右取三个字符的窗口：

```text
x^2+3x   ->   "··x^2+3"   "x^2+3x·"
x^3+5x   ->   "··x^3+5"   "x^3+5x·"
```

两个标记均不相同，而普通二元组袋仍会共享 `x^`、`+` 和 `x`。窗口半径 3 来自实测而非惯例：区分裕量在 3 处达到峰值，增至 6 时甚至有一组样本的排序发生反转。[完整扫描见研究报告](RESEARCH-REPORT.md#61-operator-context-window-radius)。

![运算符上下文窗口半径与区分裕量](figures/radius-sweep.svg)

## 置信度与拒绝匹配的权利

置信度取决于**有多少个相互独立的信号达成一致**，并且与对齐过程分开计算：动态规划只决定选择哪一条答案，逐题规则则决定结果值得信任到什么程度。若不进行这种拆分，顺序约束本身就可能制造出证据并不支持的确定性。

| | 依据 |
|---|---|
| `HIGH` | 书签题号精确对应，或章节已对齐且题号与内容一致 |
| `MEDIUM` | 两个信号一致 |
| `LOW` | 只有一个弱信号，显示时附带醒目提示 |
| `NONE` | 拒绝匹配，同时返回候选题号、页码和原因 |

当重复题号没有章节对齐时，引擎会**拒绝匹配，绝不依靠位置强行决定**。对齐算法总能给出某种分配；直接接受它，就会把真实歧义变成自信的错误答案。

## 结果

在真实的 2023 年配对数据上（习题册 368 页，答案册 372 页）：

| | |
|---|---|
| 已解决题目 | **508 / 508** |
| 错误匹配 | **0** |
| `HIGH` 置信度精确率 | **100%** |
| 单页匹配耗时 | p95 0.01 ms |
| 372 页答案册索引耗时 | 9 ms |

移除书签树，并用原书签构建的独立金标准评分后，**四种组合的精确率仍均为 100%**，即没有错误答案；与此同时，召回率大幅下降，单页延迟升至 507 ms。[消融实验方法与完整表格](RESEARCH-REPORT.md#5-evaluation)。

![四种组合中精确率保持 100%，拒绝率上升](figures/ablation-precision-refusal.svg)

## 使用方法

```js
import { indexAnswerDocument, indexQuestionDocument, questionsOnPage }
  from './src/answer-index.js';
import { alignOutlines, matchPage } from './src/question-matcher.js';

const questionIndex = await indexQuestionDocument(exerciseDoc, { expectScript: 'han' });
const answerIndex   = await indexAnswerDocument(answerDoc,   { expectScript: 'han' });
const alignment     = alignOutlines(exerciseDoc.outline, answerDoc.outline);

const matches = matchPage(
  questionsOnPage(questionIndex, currentPage),
  answerIndex,
  { alignment, exercisePage: currentPage, answerPageCount: answerDoc.numPages },
);

for (const m of matches) {
  if (!m.matched) continue;            // 已拒绝：显示 m.reason 与 m.candidates
  console.log(m.question.label, m.entry.answer, m.confidence, m.reason);
}
```

`expectScript: 'han'` 告诉质量门控这应当是一本中文书。这样能发现仅靠噪声比例无法识别的阅读器配置错误。

### 文档接口

引擎本身不读取 PDF。调用方需要提供满足下列接口的任意对象：

```js
{
  numPages: number,
  outline: { available: boolean, items: [{ title, pageNumber, depth, children }] },
  async extractText({ from, to }): Array<{ page: number, text: string }>,
}
```

宿主应用使用 pdf.js 生成这些数据，但本项目并不依赖 pdf.js。

### 可识别的编号形式

`1.`、`12)`、`15、`、`第 9 题`、`3．`，以及层级形式 `1.1`、`1.200`、`2.231`、`例题 1.31`；编号必须锚定在行首。`(7)`、`（8）` 被视为当前题目的**小问**，绝不会单独建立题目。

## 测试

```bash
npm test            # 全部六套测试，共 138 项检查
npm run test:unit   # 仅运行合成测试样例
npm run test:real   # 运行真实书籍测试，包括消融实验
```

大多数测试关注的是如何**拒绝**，而不是如何匹配。真实 PDF 测试需要从原书提取文本形成语料；由于这些内容来自受版权保护的书籍，因此**不会提交**到仓库。`tools/extract-corpus.mjs` 可重新生成语料：通过 `FIND_ENGINE_CORPUS` 指定结果路径，或把结果放在仓库旁的 `../find-engine-corpus/`。若语料不存在，相关测试会跳过而不是失败，所以新克隆的仓库仍能通过测试。

## 复用前应了解的两件事

**位置回退已经实现，但默认关闭。** 对真正平行的文档配对，它可以达到 100% 精确率；对不平行的配对，精确率为 0%，会把 120/120 道题全部以 `MEDIUM` 置信度错误返回。无法判断自身何时不适用的信号，无法遵守“错配比不匹配更糟”的原则。[测量数据](RESEARCH-REPORT.md#71-a-positional-prior-that-fails-silently)。

**遇到 `OPAQUE` 时，先怀疑阅读器，再怀疑文档。** 最初被认为是嵌入字体损坏的案例，最终发现是 pdf.js 缺少 CMap 文件。[这次误判的代价与所得经验](RESEARCH-REPORT.md#72-a-confident-misdiagnosis)。

## 相关工作

对齐机制本身是标准方法，包括动态规划、单调对齐和相似度评分。本项目的特殊性来自其应用领域：层级题号、书签锚定、数学结构加权，以及有意设计的拒绝权。研究报告中给出了与 Gale–Church、Hunalign、Bleualign、Maligna、Vecalign 和 Bitextor 的[对比定位](RESEARCH-REPORT.md#2-related-work)。

## 局限性

- 扫描版书籍需要 OCR；引擎只提供接入点，不提供识别器。
- 没有书签树时，召回率会显著下降，但精确率不会下降。
- 二元组相似度与语言无关，但不具备语义理解能力。
- Android 性能尚未测量，所有数据都来自桌面环境。
- 参数针对中文数学教材调优。方法可以推广，常数不能直接照搬。

报告中还列出了[有效性威胁](RESEARCH-REPORT.md#8-threats-to-validity)。

## 许可证

MIT — 参见 [LICENSE](LICENSE)。
