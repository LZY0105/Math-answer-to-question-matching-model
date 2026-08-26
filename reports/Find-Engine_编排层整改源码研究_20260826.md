# Find-Engine 编排层整改源码研究与完整清单

- 研究日期：2026-08-26
- 范围：当前工作树的源码、现有自动化测试，以及既有 2023/2024/2025 扩展全面测试报告
- 性质：源码与测试证据审计；本文件不修改业务代码，也不覆盖任何既有测试报告
- 当前基线复验：`npm test`，170 项通过、0 项失败（2026-08-26 本轮重新执行）
- 既有测试报告（原样保留）：[中文扩展全面测试报告](Find-Engine_2023_2025_扩展全面测试报告_20260826.md)｜[English report](Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md)

## 1. 整改结论

**保留现有识别、索引、定位和相似度能力，重构公开编排层；不建议推倒重写。**

现有代码已经具备一批可复用能力：题号规范化、书签/正文/目录索引、章节与题级节点分类、目录行和页眉抑制、文字质量评估、按需 OCR seam、数学片段与运算符上下文比较、答案区域定位、单调序列对齐和结果阶梯。这些能力在已有 170 项测试中分别受到覆盖，正确双题级书签配对在 2023、2024 数学分析和 2024 高等代数样本上达到严格精确率 100%、唯一召回 100%。

当前发布阻断不是“相似度还不够高”，而是**编排顺序允许证据不足的路径过早放行**：

1. `matchQuestion()` 的唯一 `exactId` 分支在内容比较之前直接返回 `HIGH`。
2. `matchPage()` 虽然接受 `pairStatus`，但默认值是 `VERIFIED_PAIR`；调用者不传就等价于“默认两书已经验证”。源码注释已明确承认该默认值不适合产品。
3. 配套权限目前只在 `assignRungs()` 的末端限制输出，没有形成题级计算之前不可绕过的整书硬门；直接调用 `matchQuestion()` 可以完全绕过它。
4. `createTextSource()` 已经提供 OCR seam，但源码调用关系显示它目前只被 `test/test_text_source.js` 使用，没有进入公开匹配调用链。
5. 当前只有数学片段和运算符上下文相似度，没有“题内全部完整公式”的 `FormulaSet` 完整性门控。
6. `matchPage()` 的一对一约束只存在于一次局部序列对齐内；没有跨页 `PairSession`、已占用集合、可回滚暂存和重排情况下的全局一对一分配。

因此，整改目标不是再叠加几个 helper，而是建立一个深 **Module**：用很小的 **Interface** 隐藏整套验证、索引、检索、分配和拒绝逻辑，使平板、桌面批处理、测试和未来宿主都必须跨过同一个 **Seam**。这样能同时获得调用方的 **Leverage** 和维护方的 **Locality**。

## 2. 当前真实调用链

当前公开使用方式以两个函数为中心：

```text
调用方（answer-panel / 测试 / 临时评测脚本）
            │
            ├── matchQuestion(question, candidates, options)
            │       ├── exactId 唯一命中：立即 HIGH
            │       ├── 题号 + contentSimilarity
            │       └── 内容排序 / 拒绝
            │
            └── matchPage(questions, answerIndex, options)
                    ├── answerRangeForQuestion
                    ├── 唯一结构题号快速路径
                    ├── 唯一书签题号快速路径
                    ├── alignSequences（局部单调对齐）
                    ├── matchQuestion（逐题决策）
                    ├── applyPositionalSupport
                    └── assignRungs
                            └── applyPairPermissions
```

关键源码证据如下：

| 证据 | 位置 | 结论 |
|---|---|---|
| `matchQuestion()` | [`src/question-matcher.js:443`](../src/question-matcher.js#L443) | 第 0 阶段在 `byLabel.length === 1 && exactId` 时不读取内容，直接 `matched: true`、`HIGH`。 |
| `matchPage()` | [`src/question-matcher.js:773`](../src/question-matcher.js#L773) | 同时负责快速路径、候选池、局部序列对齐、逐题评分和最终阶梯，职责过多。 |
| `pairStatus` 默认值 | [`src/question-matcher.js:773`](../src/question-matcher.js#L773) | 默认 `VERIFIED_PAIR`；源码注释明确写明该默认值对产品是错误的，等待 `preparePair` 后翻转。 |
| `assignRungs()` | [`src/question-matcher.js:737`](../src/question-matcher.js#L737) | 配套权限在结果生成末端才调用，属于输出上限，不是题级匹配前的硬门。 |
| `applyPairPermissions()` | [`src/decision.js:94`](../src/decision.js#L94) | 能把未知配对降级、拒绝配对设为 `BLOCKED`，但仅在调用方真正传入正确 `pairStatus` 时生效。 |
| `indexDocument()` | [`src/answer-index.js:476`](../src/answer-index.js#L476) | 已具备书签优先、文字质量判断、正文兜底、目录位置交叉验证和懒加载基础。 |
| `createTextSource()` | [`src/text-source.js:63`](../src/text-source.js#L63) | 已具备按需 OCR、缓存、来源标记和不可变 hydrate；当前调用关系仅指向文字源测试，未接入匹配入口。 |
| 局部区域定位 | [`src/region-locator.js:88`](../src/region-locator.js#L88) | 已能返回精确题级区域或章节范围，可保留为内部能力。 |
| 全书评测入口 | [`tmp/run-expanded-regression.mjs:71`](../tmp/run-expanded-regression.mjs#L71) | 仍按页直接调用 `matchPage()`，没有 `preparePair()` 或会话级状态。 |
| 错书探针 | [`tmp/run-expanded-regression.mjs:231`](../tmp/run-expanded-regression.mjs#L231) | 直接调用 `matchQuestion()`，证明公开题级入口可以绕开配套权限。 |
| 公式负样本 | [`tmp/run-expanded-regression.mjs:324`](../tmp/run-expanded-regression.mjs#L324) | 三个公式全集探针全部直接落入现有 `matchQuestion()` 路径。 |

### 2.1 公开导出面与“调用方可伪造证据”

`src/question-matcher.js` 当前直接导出 14 项：`CONFIDENCE`、`normalizeForMatch`、`similarity`、`extractMathFragments`、`mathSimilarity`、`contentSimilarity`、`alignOutlines`、`answerRangeForQuestion`、`answerRangeForPage`、三个 region locator 再导出、`matchQuestion`、`ALIGN_LIMITS`、`alignSequences` 和 `matchPage`。这使调用者能够跨过编排层，直接组合内部策略；公开 Interface 接近实现复杂度，属于浅 Module。

更危险的是，当前函数参数允许调用方直接声明本应由引擎证明的证据：

- [`matchQuestion()`](../src/question-matcher.js#L443) 接受 `sectionAligned`、`exactId`、`textQuality`、`crossBookComparable`。
- [`matchPage()`](../src/question-matcher.js#L773) 接受 `alignment`、`pairStatus`、`usePositionalPrior`、`questionCount`、`crossBookComparable` 等控制项。
- 错书探针可以直接传入 `exactId: true` 和 `sectionAligned: true`，于是共享题号在没有整书验证时被制造成 `HIGH`。

整改后这些证据布尔值不能出现在外部 Interface：`exactId` 必须由已验证书对的索引产生，`sectionAligned` 必须由同一会话的目录对齐产生，`crossBookComparable` 必须由两书文字层测量产生，`pairStatus` 必须由 `preparePair()` 产生。宿主只能提交文档和匹配目标，不能提交“我已验证”的结论。

### 2.2 2025 稀疏文本为何会被判 `USABLE`

[`assessTextQuality()`](../src/text-quality.js#L103) 的输入只有 `lines` 和 `expectScript`，没有文档总页数。实现会统计字符、控制字符、异常文种、汉字和结构字符的**比例**；只要文本非空且这些比例没有触发损坏阈值，最后就返回 `USABLE`。它没有检查：

- 总字符数相对于文档页数是否过低；
- 有文本页数占总页数的比例；
- 采样是否只命中封面或目录；
- 465 页文档只有 609 字符是否属于稀疏扫描层。

[`indexDocument()`](../src/answer-index.js#L476) 在建立索引前调用该函数，并把 `textMayBeComparable(assessment.quality)` 作为是否允许 BODY 解析的条件。因此一旦稀疏层被误判 `USABLE`，正文解析主路径就会把少量目录数字继续解析成伪题目。2025 的“误判可用”和“生成 18 个伪题目”不是两个独立问题，而是同一门控缺陷的上下游结果。

整改时必须让质量评估接收 `numPages` 或等价文档画像，并在 BODY 解析前新增 `SPARSE_LAYER`。不能只在匹配结果末端降低置信度，因为届时伪题目已经进入索引。

### 2.3 约定能力的存在性核验

对当前 `src/*.js` 的实现搜索结果如下：

| 能力 | 当前状态 | 证据结论 |
|---|---|---|
| `preparePair` | **不存在** | 仅在 `matchPage()` 注释中出现“once preparePair exists”，没有实现或导出。 |
| `FormulaSet` | **不存在** | 没有对应符号或模块；当前只有 `extractMathFragments()` 和 `symbolContextSimilarity()`。 |
| 双向匹配 | **不存在** | 没有 answer→question 反向候选验证实现。 |
| 非单调全局一对一分配 | **不存在** | 只有 `alignSequences()` 的单调局部对齐；没有重排模式的全局求解器。 |
| `PairSession` | **不存在** | 没有跨页会话、已占用集合或 provisional 回滚状态。 |
| 配套权限 helper | **已实现但未形成前置硬门** | `decision.js` 能限权，`matchPage()` 末端会调用，但默认配套已验证且 `matchQuestion()` 可绕过。 |
| OCR seam | **已实现但未接入公开匹配链** | `createTextSource()` 有生产形态，实现调用者目前仅为其单元测试。 |

因此，整改不能把“已有 helper”误写成“产品已经具备”。测试必须验证能力经过唯一外部 Seam 后的可观察结果。

## 3. 现有模块依赖与处理决定

### 3.1 应保留的实现

| 现有实现 | 保留理由 | 整改后的归属 |
|---|---|---|
| `question-id.js` | 层级题号规范化、精确比较和排序属于稳定基础能力。 | `MatchingEngine` 内部题号工具。 |
| `answer-index.js` | 已支持 OUTLINE、CONTENTS、BODY、重复题号、页面范围和文字质量信息。 | 文档索引实现；不再承担配套放行。 |
| `outline-classify.js` | 已避免章节节点直接提升为题目。 | 文档结构分析内部步骤。 |
| `contents-index.js`、`toc-filter.js` | 能利用印刷目录定位并抑制目录伪答案。 | 无书签索引内部步骤。 |
| `boilerplate.js` | 能过滤重复页眉页脚，同时不破坏原始分段。 | 文本清洗内部步骤。 |
| `text-quality.js` | 已有 `USABLE/DEGRADED/OPAQUE/SCANNED` 等质量语言。 | 扩展稀疏页门控，不废弃。 |
| `text-source.js` | 已有懒加载、OCR Adapter 接入点、缓存和来源追踪。 | 由 `preparePair()` 创建并强制使用。 |
| `region-locator.js` | 已区分题级精确范围与章节范围。 | `LOCATED/REVIEW` 的内部定位能力。 |
| `symbol-context.js` | 运算符左右字符比较已经存在并有半径 3 的测试。 | 只能在完整公式结构通过后作为二级证据。 |
| `glyph-map.js` | 对异常字体映射有可测量、可拒绝的恢复能力。 | OCR 前的低成本文字修复路径。 |
| `positional-prior.js` | 在已验证且顺序可靠的书对中可用于加速或消歧。 | 仅作软先验，默认不成为正确性依据。 |
| `alignOutlines()`、`alignSequences()` | 目录对齐和单调对齐对顺序一致样本有效。 | 作为内部策略；重排时不能使用单调硬约束。 |
| `decision.js` | 已有 rung 和配套权限的初步模型。 | 扩展为统一决策器，由唯一入口调用。 |

### 3.2 必须改变的职责

- `question-matcher.js` 不再是产品编排入口。保留纯相似度、目录对齐和序列对齐函数，但它们变为 `MatchingEngine` 的内部实现。
- `matchPage()` 先保留为兼容 **Adapter**，内部转调新 Interface；所有宿主迁移后标记弃用。
- `matchQuestion()` 不再允许宿主直接传 `exactId`、`sectionAligned`、`pairStatus` 等“可伪造证据”。这些字段必须由会话内部产生。
- `answer-panel.js`、真实 PDF 测试、无书签测试和临时评测脚本全部改为调用同一 Interface。
- 不把角色门控、公式门控或置信度规则留在平板 UI。宿主只接收决策，不能决定是否放行。

## 4. 目标深 Module 与唯一外部 Seam

### 4.1 建议 Interface

```js
const prepared = await MatchingEngine.preparePair({
  exercise,
  answer,
  recognizer,
  policy,
});

// PairRejected | PairNeedsOCR | PairPrepared

const one = await prepared.session.matchQuestion({
  questionId,       // 桌面批处理可传
  page, clickRegion // 平板点击模式可传
});

const all = await prepared.session.matchAll({
  mode: 'SAFE',
});
```

外部 Interface 只需要三项行为：

1. `preparePair(input)`：验证角色、配套身份、文字可用性并建立索引。
2. `PairSession.matchQuestion(target)`：匹配一道已明确定位的习题。
3. `PairSession.matchAll(options)`：整书候选生成与全局一对一分配。

调用方不得知道或设置：`exactId`、`sectionAligned`、公式权重、位置窗口、第一二名差距、配套权限上限。隐藏这些知识，才使 Module 具备足够 **Depth**。

### 4.2 真正需要的 Adapter

只建立确实存在两个实现的 Seam：

- `DocumentAdapter`
  - 生产 Adapter：真实 PDF 文档。
  - 测试 Adapter：预提取语料/内存文档。
- `RecognizerAdapter`
  - 生产 Adapter：实际 OCR。
  - 测试 Adapter：确定性 OCR fake；另可使用显式 `null` 表示未配置。

索引器、FormulaSet、候选检索、评分器和分配器都是深 Module 的内部 seam，不应全部暴露给宿主。

### 4.3 会话状态机

```text
NEW
 └─> ROLE_CHECKED
      ├─> PAIR_REJECTED ──────────────> BLOCKED
      └─> PAIR_UNKNOWN ───────────────> REVIEW / LOCATED / REFUSED
      └─> PAIR_VERIFIED
           └─> TEXT_CHECKED
                ├─> OCR_REQUIRED ─────> 停止，不建正文题索引
                └─> INDEX_READY
                     └─> QUESTION_READY
                          └─> FORMULA_SET_READY
                               └─> CANDIDATES_READY
                                    └─> BIDIRECTIONAL_CHECKED
                                         └─> ASSIGNED
                                              └─> DECIDED
```

禁止转换：

- `PAIR_UNKNOWN` 或 `PAIR_REJECTED` → `AUTO_MATCH`。
- `OCR_REQUIRED` → BODY 题号解析。
- `QUESTION_BOUNDARY_INCOMPLETE` → `AUTO_MATCH`。
- `FORMULA_SET_INCOMPLETE` 或 `FORMULA_CONFLICT` → `AUTO_MATCH`。
- 未通过双向一致性或一对一分配 → `AUTO_MATCH`。

## 5. 不可绕过的硬门顺序

### Gate 1：角色门

先判断左侧是否为 `EXERCISE`、右侧是否为 `ANSWER`。证据至少包含文档标题/封面、答案前缀密度、解答性语言、题干性语言和目录形态。双答案、双习题和角色反转直接 `PAIR_ROLE_MISMATCH`。

### Gate 2：配套身份门

建立整书指纹：规范化标题、年份、版本、科目、题量范围、目录章节序列、抽样锚点。输出：

- `VERIFIED_PAIR`：至少两类独立证据一致且无硬冲突。
- `UNKNOWN_PAIR`：证据不足；只允许定位或人工复核。
- `REJECTED_PAIR`：年份/科目/角色等硬冲突；整书阻断。

`exactId` 只能在 `VERIFIED_PAIR` 内缩小候选，不能独立放行。

### Gate 3：文字质量/OCR 门

增加按页数归一化的稀疏度指标，至少考虑：总字符/页、含文字页比例、有效汉字/数学字符密度、采样页为空比例和疑似目录占比。465 页仅 609 字符的 2025 习题册必须判为 `SCANNED` 或 `SPARSE_LAYER`。

- 无 RecognizerAdapter：返回 `OCR_REQUIRED`，accepted=0。
- OCR 失败或覆盖不足：`OCR_INCOMPLETE`，不能进入自动匹配。
- 有题级书签时可先建立结构索引，但读取题目内容做自动匹配前仍必须取得可验证文本。

### Gate 4：完整题目边界门

题目范围必须从以下证据产生：题级书签、可靠正文题号区间、平板点击区域加相邻题界、或 OCR 版面区域。章节标题、目录行、小问编号、公式编号和页眉不能成为独立题目。

无法证明题目起止范围时返回 `QUESTION_BOUNDARY_INCOMPLETE`，不能靠整页文本产生高置信度。

### Gate 5：FormulaSet 门

每道题提取**题内全部完整数学表达式**，保留：

- 表达式结构（括号、分式、根号、上下标、积分上下限、求和上下限、矩阵维度等）；
- 规范化结构哈希；
- 表达式在题内的次序和重复次数；
- 每个完整表达式左右各三个字符，作为延后使用的上下文。

自动匹配条件：

- 习题 FormulaSet 提取完整；
- 候选答案覆盖全部必要表达式；
- 结构冲突数为 0；
- OCR 截断数为 0；
- 之后才允许使用左右三个字符消歧。

左右三字符不能触发匹配、不能补齐缺失公式、不能把结构冲突修复成 `AUTO_MATCH`。

### Gate 6：有界候选检索门

答案册只建一次不可变索引。按照配套身份、章节、题号、FormulaSet 结构哈希和关键词进行倒排检索，只返回有界 Top-K。禁止每个页面重复对全书全部候选运行动态规划。

### Gate 7：双向一致性门

习题 `Q` 的第一候选是答案 `A` 后，再从 `A` 反向检索习题：

- `A` 的第一候选仍为 `Q`，且两方向差距均达标，才能保留自动匹配资格。
- 反向指向别题、出现并列或证据冲突，降为 `REVIEW` 或 `REFUSED`。

### Gate 8：全局一对一与回滚门

- 原始索引永不删除。
- 高置信度匹配进入 `occupiedAnswers`，但保存证据和版本，可在冲突时回滚。
- 中低置信度进入 `provisionalAssignments`，不得锁死后续搜索。
- 高置信度锚点顺序基本一致时，启用窗口加速。
- 锚点明显交叉时关闭单调顺序，使用带空缺/增题代价的全局一对一分配。
- 同一答案被两题争用、缺题、增题或重排时，优先拒绝冲突而不是连锁错位。

### Gate 9：决策与校准门

统一输出：

```js
{
  status: 'AUTO_MATCH' | 'REVIEW' | 'LOCATED' | 'REFUSED' | 'BLOCKED' | 'OCR_REQUIRED',
  answerLocation: null | { page, endPage, region },
  candidates: [],
  confidence: null | 0.0,
  reasonCodes: [],
  evidence: {
    pairStatus,
    questionBoundaryComplete,
    formulaCoverage,
    formulaConflicts,
    contextAgreement,
    bidirectional,
    topTwoMargin,
    assignmentStable,
    textOrigins,
  }
}
```

不得再用 `matched: true + LOW` 让宿主猜测它是否可以展示为正式答案。置信度必须用保留集校准；证据冲突还应设置置信度上限。

## 6. 完整整改清单

### P0：锁定基线与建立唯一入口

- [ ] 保留现有中英文扩展测试报告，不改名、不覆盖、不回写旧结果。
- [ ] 将本轮 8 份文档语料和原始回归 JSON 固定为版本化外部测试资产。
- [ ] 新建 `src/matching-engine.js`，只公开 `preparePair()`。
- [ ] 新建内部 `PairSession`，公开 `matchQuestion()` 和 `matchAll()`。
- [ ] 第一阶段让新 Interface 包装旧实现，确保 170 项测试继续全绿。
- [ ] 给 `matchPage()` 和 `matchQuestion()` 增加内部/兼容标记，禁止新增产品调用方。
- [ ] 把 `answer-panel.js`、真实 PDF 测试和批量评测脚本迁移到新 Interface。
- [ ] 增加依赖规则测试：生产入口不得直接导入旧 matcher 函数。

验收：新旧正确书对输出保持基线一致；所有正式调用都经过 `preparePair()`。

### P0.5：角色与配套身份硬门

- [ ] 实现 `DocumentRole`：`EXERCISE/ANSWER/UNKNOWN`。
- [ ] 实现 `PairFingerprint`：标题、年份、版本、科目、目录序列、题量范围、抽样锚点。
- [ ] 实现 `PairStatus`：`VERIFIED_PAIR/UNKNOWN_PAIR/REJECTED_PAIR`。
- [ ] 删除 `matchPage()` 中 `pairStatus = VERIFIED_PAIR` 的危险默认；缺省必须是未知或不允许调用。
- [ ] 在任何题级索引快速放行、`exactId` 或相似度计算之前执行 Gate 1/2。
- [ ] `REJECTED_PAIR` 整书 accepted=0；`UNKNOWN_PAIR` 不允许 `AUTO_MATCH`。
- [ ] reason code 固定为机器可断言的枚举，不依赖中文 reason 文本。

验收：60 组错书/错角色组合整书拒绝率 100%，accepted=0，`HIGH/AUTO_MATCH`=0。

### P0.6：文字质量与 OCR 硬门

- [ ] 扩展 `text-quality.js`，加入页均字符、空页比例和稀疏层判定。
- [ ] 在 `preparePair()` 内创建并使用 `createTextSource()`，不允许它停留在单元测试孤岛。
- [ ] 将 RecognizerAdapter 注入引擎，禁止内部自行创建远程/OCR依赖。
- [ ] 对习题与答案分别记录 `LAYER/OCR/NONE` 来源和覆盖率。
- [ ] 未配置 OCR、OCR失败、覆盖不足分别返回稳定状态码。
- [ ] 在 OCR 可用之前禁止 2025 扫描习题进入 BODY 题号解析。

验收：2025 未配置 OCR 返回 `OCR_REQUIRED`，正文伪题目为 0，accepted=0。

### P1：题目边界与 FormulaSet

- [ ] 新建内部 `formula-set.js`，提取结构化完整表达式，而不是只抽正则数学片段。
- [ ] 建立题目范围模型，区分题目、子问、公式编号、目录项、章节和页眉。
- [ ] 对每道题记录 `extractionComplete`、`formulaCount`、`structuralHashes`、重复次数和 OCR 截断。
- [ ] FormulaSet 覆盖采用多重集语义，重复出现的同一表达式不能被一次命中全部抵消。
- [ ] 支持可证明的规范等价；无法证明的代数等价不得自行猜测。
- [ ] FormulaSet 全覆盖通过后，才调用现有半径 3 运算符上下文能力。
- [ ] 移除唯一题号无内容 `HIGH`；题号只用于候选检索和结构证据。
- [ ] 对无公式题保留题号、章节、关键词等替代证据，但不能假装通过 FormulaSet。

验收：既有三个公式负样本全部不自动匹配；新增截断、重复、乱序、上下标和矩阵样本通过预期。

### P1.5：无书签解析收敛

- [ ] 对 2024 四本文字版分别建立正文候选误差清单。
- [ ] 目录行、题内编号、小问、公式常数、例题和重复页眉不得提升为顶层题目。
- [ ] 正文题号必须同时满足版面位置、上下文和相邻题界证据。
- [ ] 正文索引输出 `sourceEvidence` 和 `boundaryConfidence`。
- [ ] 未达到题目边界阈值的候选只用于搜索，不可成为金标准题目。

验收：候选数量接近真实题量；不得再出现 271 题解析为 1,960 候选、217 题解析为 1,352 候选的量级。

### P2：Top-K 检索、双向验证和全局分配

- [ ] 建立按题号、章节、FormulaSet 哈希、关键词的答案倒排索引。
- [ ] `matchQuestion()` 只比较有界 Top-K，记录候选召回率。
- [ ] 实现习题→答案与答案→习题双向排名。
- [ ] 实现高置信锚点顺序可靠性检测。
- [ ] 顺序可靠时使用窗口/单调对齐；重排时切换全局一对一分配。
- [ ] 支持缺题、增题、重复题号、跨章节重排和局部重排。
- [ ] 实现 `occupiedAnswers`、`provisionalAssignments` 和冲突回滚。
- [ ] 超时返回 `REFUSED/TIMEOUT`，不得返回部分计算形成的自动匹配。

验收：一条答案最多被一个最终题目占用；重排样本不因顺序不同而错配；前一题误判可回滚且不引发后续连锁错位。

### P3：置信度校准与输出收口

- [ ] 将 `HIGH/MEDIUM/LOW + matched` 迁移为明确的决策状态。
- [ ] 设计证据冲突上限：角色、年份、公式、双向和分配任一硬冲突均不能自动匹配。
- [ ] 建立困难负样本集校准分数到真实正确率。
- [ ] 统计 Top-1、Top-2 差距和扰动稳定性；轻微 OCR/空格/字体变化不应改变结论。
- [ ] UI 只依据 `status`，reason 文本只用于说明，reason code 用于逻辑和测试。

验收：发布指标按 `AUTO_MATCH` 计算严格精确率；`REVIEW/LOCATED` 不混入正式匹配。

### P4：性能、清理与发布

- [ ] `preparePair()` 只建一次索引并缓存到文档指纹。
- [ ] 单题路径只读取点击题目区域及 Top-K 答案候选。
- [ ] 记录索引时间、单题 p50/p95/p99、候选数、OCR页数和缓存命中率。
- [ ] 桌面单题 p95 小于 150 ms；性能不依赖 1,500 ms 超时维持安全。
- [ ] 新 Interface 测试覆盖稳定后，替换测试旧浅层调用的重复断言；保留纯算法单元测试和外部回归。
- [ ] 所有宿主迁移完成后删除或封闭旧公开入口。
- [ ] 形成版本化发布报告，包含 Git SHA、工作树状态、语料版本和完整命令。

## 7. 必须新增的 Interface 级测试

这些测试必须从 `MatchingEngine.preparePair()` 开始，不能直接测试 `decision.js` 或给 `matchQuestion()` 人工塞入 `exactId/pairStatus`。

### 7.1 配套与角色

- [ ] 正确习题→答案、同年同科：`VERIFIED_PAIR`。
- [ ] 跨年但共享大量题号：`REJECTED_PAIR`。
- [ ] 数学分析→高等代数：`REJECTED_PAIR`。
- [ ] 答案→答案：`PAIR_ROLE_MISMATCH`。
- [ ] 习题→习题：`PAIR_ROLE_MISMATCH`。
- [ ] 答案→习题：`PAIR_ROLE_MISMATCH`。
- [ ] 元数据缺失但结构证据不足：`UNKNOWN_PAIR`，不得自动匹配。
- [ ] 文件内容变化后缓存失效并重新验证指纹。

### 7.2 书签组合

- [ ] 双方有题级书签。
- [ ] 仅习题有书签。
- [ ] 仅答案有书签。
- [ ] 双方均无书签。
- [ ] 仅有章节书签，确认章节不被提升为题目。
- [ ] 同页多题，每题得到独立答案范围。

### 7.3 OCR 与文字质量

- [ ] 465 页/609 字符样本判 `SPARSE_LAYER/SCANNED`。
- [ ] 无 OCR Adapter 返回 `OCR_REQUIRED`。
- [ ] OCR 返回空文本：`OCR_INCOMPLETE`。
- [ ] OCR 只覆盖部分题目：未覆盖题不得自动匹配。
- [ ] 可用文字层不得无谓调用 OCR。
- [ ] OCR 结果缓存，同页不重复识别。

### 7.4 FormulaSet

- [ ] 两个完整公式全部匹配：进入后续消歧。
- [ ] 少一个公式：`FORMULA_SET_INCOMPLETE`。
- [ ] 两个公式均结构冲突：`FORMULA_CONFLICT`。
- [ ] 公式相同但左右三字符不同：只影响排序，不越过硬门。
- [ ] 左右三字符相同但公式不同：不得匹配。
- [ ] 公式 OCR 截断：不得自动匹配。
- [ ] 重复公式的计数不一致：不得视为 100% 覆盖。
- [ ] 分式、根号、积分上下限、上下标、矩阵分别有结构保持测试。
- [ ] 无公式题走独立证据路径，并明确标记 `NO_FORMULA`。

### 7.5 双向与一对一分配

- [ ] 答案顺序与习题顺序完全不同，仍能一对一正确匹配。
- [ ] 答案缺一题，相关习题保持未匹配，后续不整体错位。
- [ ] 答案多一题，额外答案被跳过。
- [ ] 两道习题竞争同一答案，冲突降级并触发重分配。
- [ ] 重复题号由 FormulaSet 区分；无法区分则拒绝。
- [ ] 前一 provisional 匹配被后续更强证据回滚。
- [ ] 双向第一名不一致时不得自动匹配。

### 7.6 决策语义和稳定性

- [ ] `REJECTED_PAIR` 始终 `BLOCKED`。
- [ ] `UNKNOWN_PAIR` 最高只能 `REVIEW/LOCATED`。
- [ ] `LOW` 不再以 `matched=true` 对外出现。
- [ ] 第一二名差距不足：`REVIEW`。
- [ ] 轻微空格、换行、括号字体变化不改变正确结论。
- [ ] 改变数学结构或年份立即降低/拒绝。
- [ ] 超时与取消均返回完整、可解释、不可自动使用的结果。

### 7.7 全书回归和性能

- [ ] 三组文字版双书签：严格精确率 100%、唯一召回 100%。
- [ ] 正确配对四种书签组合全书运行，不再抽样替代全书结论。
- [ ] 全部 60 组错误组合从同一 Interface 整书拒绝。
- [ ] 2025 未配置 OCR：accepted=0。
- [ ] 2025 配置 OCR 后，首阶段严格精确率 100%、唯一召回至少 95%。
- [ ] 单题 p95 小于 150 ms，记录 Top-K 大小和 OCR 成本。

## 8. 现有测试为什么“全绿”仍不能发布

本轮重新执行 `npm test`，结果确为 170/170。它证明现有实现没有破坏自己的既定契约，但还不能证明产品级安全性：

1. `test/test_question_matcher.js` 直接测试 matcher 内部函数，没有从整书 `preparePair()` 开始，因此无法捕获绕过整书门控。
2. `test/test_structure.js` 已验证 `applyPairPermissions()` 的局部行为，但正确 helper 不等于它已成为所有调用方不可绕过的流程。
3. `test/test_text_source.js` 已验证 OCR seam 本身有效，但源码调用关系显示生产匹配链没有使用它。
4. `test/test_no_bookmarks.js` 的控制台结果按 `identified` 统计“100% precision”，并明确排除了 `unidentifiable`；扩展报告把所有接受结果按独立书签页范围验证后，2024 无书签严格精确率只有 24.5%-33.8% 和 27.5%-30.5%。
5. 正确双书签样本主要覆盖强结构路径，没有覆盖共享题号的跨年、错科、双答案、双习题和角色反转。

整改测试策略应遵循“替换而不是永久叠层”：迁移期间保留 170 项基线；新 Interface 级测试能覆盖同一行为后，删除只验证旧浅 Interface 的重复测试，但保留纯算法单元测试、真实语料全书回归和所有负样本。

## 9. 本轮测试证据与目标差距

以下数字来自原样保留的[扩展全面测试报告](Find-Engine_2023_2025_扩展全面测试报告_20260826.md)：

| 场景 | 当前证据 | 整改验收 |
|---|---:|---:|
| 2023/2024 三组双题级书签 | 精确率 100%，召回 100% | 必须保持 |
| 60 组错书/错角色 | 52 组出现接受；11,629 个探针均为 `HIGH` | accepted=0，自动匹配=0 |
| 2023→2024 数分答案代表性错书全书 | 463 接受、463 `HIGH` | 整书 `REJECTED_PAIR` |
| 2024 数分无习题书签 | 严格精确率 24.5%-33.8% | 自动匹配严格精确率 100% |
| 2024 高代无习题书签 | 严格精确率 27.5%-30.5% | 自动匹配严格精确率 100% |
| 2024 两组无答案书签 | 唯一召回 0% | 分阶段恢复并报告拒绝率 |
| 2025 扫描习题 | 错判 `USABLE`；18 个伪题；0/573 | 未 OCR 时 `OCR_REQUIRED`、accepted=0 |
| 三个 FormulaSet 负样本 | 全部错误 `HIGH` | 全部非自动匹配 |
| 2024 无习题书签 p95 | 1,688.2 / 1,572.9 ms | 单题 p95 < 150 ms |

精确率优先级必须固定：先做到错误接受为零，再逐步提高召回；不能通过降低阈值换取覆盖率。

## 10. 文件级落地建议

建议新增：

```text
src/matching-engine.js          # 唯一外部 Module
src/pair-session.js             # 内部会话状态和可回滚分配
src/pair-verifier.js            # 角色与整书指纹
src/formula-set.js              # 完整结构化公式全集
src/candidate-retriever.js      # 有界 Top-K 检索
src/bidirectional-check.js      # 双向一致性
src/assignment-solver.js        # 单调/重排全局一对一策略
src/confidence-calibrator.js    # 最后阶段的真实概率校准
test/test_matching_engine.js    # Interface 级合成测试
test/test_pair_matrix.js        # 60 组错书/角色回归
test/test_formula_set.js        # 完整公式及负样本
test/test_assignment.js         # 重排、缺题、增题、冲突、回滚
```

建议改造但保留历史：

```text
src/question-matcher.js         # 降为内部评分/对齐实现
src/answer-index.js             # 输出更完整的结构和来源证据
src/text-quality.js             # 加入 SPARSE_LAYER
src/text-source.js              # 接入 preparePair
src/decision.js                 # 统一状态、reason code、证据上限
src/answer-panel.js             # 只消费 MatchingEngine 决策
tmp/run-expanded-regression.mjs # 改走唯一 Interface，另存新版本结果
```

## 11. 小步提交顺序

1. `test: freeze orchestration safety baselines`
2. `refactor: add MatchingEngine seam around current flow`
3. `test: route product and corpus callers through MatchingEngine`
4. `feat: add role and pair identity hard gate`
5. `feat: wire text source and OCR_REQUIRED into preparePair`
6. `feat: require complete question boundaries`
7. `feat: add FormulaSet coverage before exact-id evidence`
8. `feat: add bounded candidate retrieval and reverse check`
9. `feat: add reversible global one-to-one assignment`
10. `refactor: replace confidence flags with decision states`
11. `perf: cache pair indexes and enforce single-question budget`
12. `cleanup: retire direct public matcher entry points`

每个提交都必须独立通过现有基线和该阶段新增的 Interface 测试；不要把角色、OCR、公式和分配一次性混在一个大提交里。

## 12. 测试报告保留与版本规则

本次整改不得覆盖：

- `reports/Find-Engine_2023_2025_扩展全面测试报告_20260826.md`
- `reports/Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md`
- 它们引用的原始结果和复现脚本。

后续每轮生成新文件，例如：

```text
reports/Find-Engine_编排层P0回归报告_YYYYMMDD.md
reports/Find-Engine_编排层P1回归报告_YYYYMMDD.md
reports/Find-Engine_发布候选验收报告_YYYYMMDD.md
tmp/orchestration-regression-results-YYYYMMDD.json
```

每份报告必须记录：Git SHA、工作树是否有未提交修改、文档指纹、语料版本、OCR Adapter 版本、执行命令、通过/失败/未测试、严格精确率、唯一召回、拒绝率、p95 和原始 JSON 路径。旧报告只作历史基线，新报告不得回写旧结论。

## 13. 最终完成定义

编排层整改只有同时满足以下条件才算完成：

- 所有正式调用跨过 `MatchingEngine` 的唯一 Seam。
- 角色、配套、OCR、完整题界和 FormulaSet 都在题级计算之前执行。
- `exactId` 不再拥有独立放行权。
- 公式左右三个字符严格位于全部完整公式通过之后。
- 双向验证和可回滚全局一对一分配进入整书流程。
- 错书、双答案、双习题、反向角色、扫描无 OCR 和公式冲突全部自动拒绝。
- 正确双书签能力不退化；无书签召回提升不以错误接受为代价。
- 现有扩展测试报告原样保留，并形成可复现的新阶段报告。

**最终建议：可以拯救现有引擎。整改重点是替换公开决策链，而不是重写所有算法，也不是优先继续调相似度阈值。**
