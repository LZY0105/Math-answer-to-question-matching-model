# Find-Engine 编排层重构完整整改清单

- 日期：2026-08-26
- 结论：现有引擎可以救，不建议推倒重写；保留索引、结构解析、文本质量评估、内容相似度与现有测试资产，重构 `matchPage / matchQuestion` 所承担的编排职责。
- 本轮目标：把“错书不拒、扫描版误放行、唯一题号直通高置信、无书签候选过宽、题内公式规则未硬化”这些系统性问题，收敛到一个统一的 `MatchingEngine` seam 上解决。

## 1. 本轮保留说明

以下历史测试报告与清单保留，不覆盖、不改名、不作为本轮输出的替代品：

- [Find-Engine_2023_2025_扩展全面测试报告_20260826.md](./Find-Engine_2023_2025_扩展全面测试报告_20260826.md)
- [Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md](./Find-Engine_2023_2025_Expanded_Comprehensive_Test_Report_20260826.md)
- [Find-Engine_修改建议清单_20260825.md](./Find-Engine_修改建议清单_20260825.md)
- [Find-Engine_v2_产品需求与架构设计_20260825.md](./Find-Engine_v2_产品需求与架构设计_20260825.md)

本轮核对到的校验值：

- 中文扩展测试报告 SHA256：`47268E867C16729DFF2BB7648EE61F4EA3CE373C8F89CD88B9C5EEB8E3343249`
- 英文扩展测试报告 SHA256：`9B63DB084A1460BC82E7D3B8BDD52B20D93846FC39908D23FB2EA3C8712974DE`
- 旧中文修改清单 SHA256：`805117DD02C54B46112646293B5AD28B6C668D2D46E2B09960352FFEA0B70AFD`

要求：

- [ ] 后续开发不得覆盖上述报告。
- [ ] 所有新回归结果另存为新文件，文件名带日期。
- [ ] CI 或本地回归输出必须保留“上一轮基线”和“本轮结果”两个版本，便于比差。

## 2. 现状判断

### 2.1 能保留的核心

- `src/answer-index.js::indexDocument` 已经具备可复用的索引入口、目录/正文双路线和文本质量采样逻辑。
- `src/text-quality.js` 已经具备 `USABLE / DEGRADED / OPAQUE / CORRUPT / BLANK / SCANNED` 这套可复用的质量分层。
- `src/question-matcher.js` 内已有可保留的局部能力：`contentSimilarity`、`alignOutlines`、`alignSequences`、`answerRangeForQuestion`、`assignRungs`、`applyPositionalSupport`。
- `src/decision.js` 已经有 `PAIR_STATUS`、`RUNG`、`permittedRungs`、`applyPairPermissions`，说明“配套关系限制输出层级”这件事已经开始落地。

### 2.2 真正的问题不在“算法有没有”，而在“谁来做最后决定”

当前 `matchPage` 同时承担了：

- 文档已否配套的默认假设
- 题页入口
- 范围裁剪
- 唯一题号快路径
- 重号时的位置先验
- 顺序对齐
- 匹配结果分级
- 最终放行

这导致接口太宽，职责混杂，任何一个局部规则放宽，都会绕开其他安全门。

### 2.3 当前代码里最危险的两处

- `src/question-matcher.js::matchQuestion` 中，`byLabel.length === 1 && exactId` 会直接返回 `matched: true` 与 `HIGH`，不看内容，也不看题内完整公式。
- `src/question-matcher.js::matchPage` 中，`pairStatus` 默认仍是 `VERIFIED_PAIR`。代码注释已经明确写出：这个默认值对产品是错误的，只是为了暂时不改变旧行为而保留。

## 3. 本轮整改总原则

- [ ] 不推倒重写底层评分函数，优先重构编排层。
- [ ] 把“检索候选”和“放行结论”彻底分开。
- [ ] 任何 `AUTO_MATCH` 都必须先过整书身份门、题目边界门、公式完整性门。
- [ ] “唯一题号”只能缩小候选，不能直接等于正确答案。
- [ ] 题内数学证据的硬规则必须写死：先匹配题内全部完整数学表达式，再看每个表达式左右各约 3 个字符的上下文；完整公式没对齐，周边文字不能救回来。
- [ ] 顺序只能用于加速或消歧，不能作为正确性的主证据。
- [ ] OCR、扫描、文本稀疏、乱码场景一律 fail closed，先降级为 `OCR_REQUIRED / REVIEW / LOCATED / REFUSED`，不得偷偷自动匹配。

## 4. 目标编排层

建议引入统一深模块：

```text
MatchingEngine.preparePair(input) -> PairPrepared | PairRejected
PairSession.matchQuestion(target) -> MatchDecision
PairSession.matchAll(options?) -> BookMatchResult
```

### 4.1 外部接口只保留三件事

- `preparePair`：验证左右角色、整书配套性、文本/OCR可用性，建立共享上下文。
- `matchQuestion`：处理用户点击的一道题，返回单题决策。
- `matchAll`：整书或整章批量匹配，允许全局一对一优化。

### 4.2 明确状态流

```text
NEW
-> ROLE_CHECKED
-> PAIR_VERIFIED | PAIR_UNKNOWN | PAIR_REJECTED
-> INDEX_READY | OCR_REQUIRED
-> QUESTION_READY
-> CANDIDATES_READY
-> SCORED
-> ASSIGNED
-> DECIDED
```

### 4.3 外部 adapter 只保留两个真实 seam

- `DocumentAdapter`
- `RecognizerAdapter`

说明：

- 生产环境至少有一个真实 PDF 文档 adapter 和一个测试 fake adapter。
- OCR 至少有一个真实 recognizer adapter 和一个测试 fake adapter。
- 这样 seam 才是真的，不是空抽象。

## 5. 模块职责切分

### P0 必拆

- [ ] `PairVerifier`
  - 负责左右角色校验。
  - 负责年份/版本/目录结构/封面前几页等整书身份证据。
  - 产出 `VERIFIED_PAIR / UNKNOWN_PAIR / REJECTED_PAIR`。

- [ ] `StructureIndexer`
  - 负责目录、书签、正文、OCR 后文本的结构化索引。
  - 明确区分 `BOOK / SECTION / QUESTION_TYPE / QUESTION / UNKNOWN`。
  - 保证 `1.2 数学分析` 这类是章节，不是题目。

- [ ] `QuestionBoundaryResolver`
  - 负责一道题的精确范围。
  - 平板点击场景只抽取当前题区域，不再扫整页所有编号。
  - 批量场景按题切分，不允许同页多题共用一个候选范围。

- [ ] `FormulaSetExtractor`
  - 负责从题目范围内抽取“全部完整数学表达式”。
  - 提供完整性标记：缺失、截断、结构冲突、无法解析。

- [ ] `CandidateRetriever`
  - 负责按题号、章节、题型、结构与公式索引做 top-K 检索。
  - 不负责直接给最终结论。

- [ ] `DecisionArbiter`
  - 统一合并配套关系、结构证据、公式证据、双向一致性、全局唯一性、top-two margin。
  - 唯一对外给出 `AUTO_MATCH / REVIEW / LOCATED / REFUSED / BLOCKED`。

### P1 建议拆

- [ ] `BidirectionalChecker`
- [ ] `AssignmentSolver`
- [ ] `ConfidenceCalibrator`
- [ ] `ReasonCodeRegistry`
- [ ] `MetricsRecorder`

## 6. 完整整改清单

### 6.1 基线与防回退

- [ ] R0-01 建立“历史报告不可覆盖”约束。
  - 完成标准：本轮新文档已单独落盘；旧报告 SHA 不变。

- [ ] R0-02 固化基线数据集清单。
  - 包含：2023 正配套、2024 数分、2024 高代、2025 扫描版、错书、双答案、双习题、角色反转、公式安全探针。
  - 完成标准：每组样本都有固定别名、页数、题量、预期行为。

- [ ] R0-03 统一指标定义。
  - `strict_precision = 正确 AUTO_MATCH / AUTO_MATCH 总数`
  - `unique_recall = 正确唯一匹配 / 总题数`
  - `located_coverage = 进入 LOCATED 或以上 / 总题数`
  - `located_precision = LOCATED 或以上中真正正确的比例`
  - `review_hit_rate = REVIEW 中包含正确答案候选的比例`
  - 完成标准：README、测试报告、控制台输出三处定义一致。

### 6.2 Phase 0.5：先把最危险的默认行为封住

- [ ] R1-01 去掉“未验证也默认 `VERIFIED_PAIR`”的产品行为。
  - 允许暂时保留兼容参数，但新入口必须显式传入 pair 结论。
  - 验收：错书组合不再出现 `AUTO_MATCH`。

- [ ] R1-02 把 `exactId` 从“决策证据”降级为“检索证据”。
  - 验收：任何 `exactId` 命中后，仍需经过题内公式/内容/结构门。

- [ ] R1-03 扫描与稀疏文本 fail closed。
  - 2025 这类 `465 页 / 65 行 / 609 字` 的文档必须进入 `SCANNED` 或等价状态。
  - 验收：未 OCR 的 2025 问题册 accepted=0。

### 6.3 整书身份门

- [ ] R2-01 引入显式角色识别。
  - 左侧必须是习题册，右侧必须是答案册。
  - 错角色直接 `REJECTED_PAIR` 或 `BLOCKED`。

- [ ] R2-02 引入整书配套指纹。
  - 候选证据：文件名年份、元数据、封面前几页、章节列表、题量级别、书签树结构。
  - 至少两类证据一致才可 `VERIFIED_PAIR`；只有一类或信息不足只能 `UNKNOWN_PAIR`。

- [ ] R2-03 `UNKNOWN_PAIR` 不得放行 `AUTO_MATCH`。
  - 只允许 `REVIEW` 或 `LOCATED`。

- [ ] R2-04 `REJECTED_PAIR` 统一输出 `BLOCKED`。
  - reason code 统一为 `PAIR_IDENTITY_MISMATCH` 或角色错误码。

### 6.4 结构层整改

- [ ] R3-01 建立结构层级枚举。
  - 至少区分：`BOOK / SECTION / QUESTION_TYPE / QUESTION / UNKNOWN`

- [ ] R3-02 章节与题号解析解耦。
  - `1.2 数学分析`、`2.7 高等代数` 这类必须判成 section。
  - 含“例”“习题”“证明题”“计算题”等标题型节点不能直接进题级匹配。

- [ ] R3-03 无书签场景下，正文解析与目录印证分离。
  - 正文解析得到题级候选。
  - 目录/contents 只负责校正章节或页段，不负责直接放行。

- [ ] R3-04 同页多题必须按题切分。
  - 禁止“整页一个范围，页内所有题共享候选”。

- [ ] R3-05 若只能定位到 section，输出 `LOCATED`，不得冒充 `AUTO_MATCH`。

### 6.5 题目边界与公式硬规则

- [ ] R4-01 引入 `QuestionBoundaryResolver`。
  - 点击场景：根据用户点击位置定位本题范围。
  - 批量场景：按题号和结构节点切题。

- [ ] R4-02 引入 `FormulaSetExtractor`。
  - 从单题范围内抽取全部完整数学表达式。
  - 不能只抽一部分就继续高置信。

- [ ] R4-03 公式规则硬编码。
  - 第一层：题内全部完整数学表达式必须覆盖。
  - 第二层：对每个已匹配公式，再比其左右各约 3 个字符上下文。
  - 周边字符只能消歧，不能补救完整公式缺失。

- [ ] R4-04 公式完整性失败即降级。
  - `FORMULA_EXTRACTION_INCOMPLETE`
  - `FORMULA_SET_MISSING`
  - `FORMULA_CONFLICT`
  - 这些状态不得进入 `AUTO_MATCH`。

- [ ] R4-05 OCR 或文本截断导致公式不全时，默认 `REVIEW` 或 `REFUSED`。

### 6.6 候选检索层整改

- [ ] R5-01 候选检索改为分层过滤。
  - 先题号
  - 再章节/题型
  - 再公式索引
  - 最后正文内容

- [ ] R5-02 `exactId` 仅作为缩小候选集，不作为最终正解。

- [ ] R5-03 候选集必须是 top-K，而非全书暴力对比。
  - 推荐先用 `K=3~16` 分阶段测。

- [ ] R5-04 候选集应记录每一步淘汰原因，便于复盘。

### 6.7 评分与决策整改

- [ ] R6-01 统一输出对象。
  - `status`
  - `band`
  - `cappedBy`
  - `reasonCodes`
  - `evidence`
  - `candidates`

- [ ] R6-02 决策前必须有显式 gate 顺序。
  - pair gate
  - structure gate
  - question boundary gate
  - formula completeness gate
  - candidate retrieval
  - scoring
  - assignment
  - final arbiter

- [ ] R6-03 `LOW` 不再视为“已匹配成功”。
  - `LOW` 只能落到 `REVIEW` 或 `REFUSED`。

- [ ] R6-04 top-two margin 只用于“能不能自动放行”，不用于“候选从哪来”。

- [ ] R6-05 所有 `AUTO_MATCH` 都要带可解释证据。
  - 配套验证通过
  - 题级边界明确
  - 公式覆盖完整
  - 候选第一名明显领先
  - 无双向冲突
  - 无全局分配冲突

### 6.8 双向一致性与全局唯一性

- [ ] R7-01 引入双向校验。
  - Q -> A 第一名
  - A -> Q 第一名
  - 两边一致才允许进入 `AUTO_MATCH`

- [ ] R7-02 引入占用集合与可回滚机制。
  - 高置信成功后先锁定
  - 中低置信只暂存，不永久删除

- [ ] R7-03 批量匹配引入一对一分配。
  - 顺序一致时可用单调窗口加速
  - 顺序不一致时切换到全局分配，不把顺序当硬约束

- [ ] R7-04 任何“一条答案对应多题”的冲突都必须被显式记录。

### 6.9 OCR 与文本质量路线

- [ ] R8-01 文本质量判定前置到 `preparePair`。

- [ ] R8-02 `SCANNED / BLANK / CORRUPT` 直接阻断纯文本自动匹配。

- [ ] R8-03 `OPAQUE` 只有在两本书共享同类乱码时，才允许作为比较证据。

- [ ] R8-04 OCR 是 adapter，不要把 OCR 调用散落到 `matchPage` 内部。

- [ ] R8-05 未 OCR 场景统一返回 `OCR_REQUIRED` 或降级状态，不要伪装成“内容很像”。

### 6.10 可观测性与错误码

- [ ] R9-01 reason code 收口。
  - `LEFT_ROLE_INVALID`
  - `RIGHT_ROLE_INVALID`
  - `PAIR_IDENTITY_MISMATCH`
  - `PAIR_IDENTITY_UNKNOWN`
  - `OCR_REQUIRED`
  - `NO_QUESTION_LEVEL_INDEX`
  - `FORMULA_EXTRACTION_INCOMPLETE`
  - `FORMULA_SET_MISSING`
  - `FORMULA_CONFLICT`
  - `AMBIGUOUS_TOP2`
  - `BIDIRECTIONAL_MISMATCH`
  - `ASSIGNMENT_CONFLICT`
  - `TIMEOUT`

- [ ] R9-02 每个 reason code 都要有测试覆盖和用户可读文案。

- [ ] R9-03 报告里分开统计“可恢复拒配”和“不可恢复拒配”。

### 6.11 兼容层与迁移

- [ ] R10-01 新增 `MatchingEngine`，旧 `matchPage / matchQuestion` 暂做兼容 wrapper。

- [ ] R10-02 先保证旧测试继续可跑，再逐步把调用方迁到新入口。
  - 当前导入者包括 `src/answer-panel.js`、测试脚本、回归脚本、测量脚本。

- [ ] R10-03 `matchPage` 在过渡期内只做参数翻译，不再拥有核心决策逻辑。

- [ ] R10-04 等新接口稳定后，再考虑废弃旧入口。

## 7. 开发阶段建议

### Phase A：封口，不增功能

- [ ] 接入 `preparePair`
- [ ] 新入口显式 pairStatus
- [ ] 错角色、错书、扫描未 OCR 不自动匹配
- [ ] 保证 2023 双书签场景不回退

### Phase B：结构层收口

- [ ] 章节/题目分类器稳定
- [ ] 同页多题按题切分
- [ ] `LOCATED` 与 `AUTO_MATCH` 彻底分离

### Phase C：公式硬门

- [ ] 单题完整范围
- [ ] 题内全部完整公式
- [ ] 三字符上下文只做二级证据
- [ ] 公式残缺不能自动放行

### Phase D：检索与分配

- [ ] top-K 候选
- [ ] 双向一致性
- [ ] 一对一分配
- [ ] 冲突可回滚

### Phase E：置信度与性能

- [ ] top-two margin
- [ ] 稳定性检查
- [ ] 置信度校准
- [ ] 指标与报表统一

### Phase F：迁移与收尾

- [ ] 新入口替换主调用方
- [ ] 旧入口标记兼容层
- [ ] README 与报告模板更新
- [ ] 新基线报告存档

## 8. 验收矩阵

### 8.1 必过安全线

- [ ] 60 组错书/错角色/双答案/双习题组合 accepted=0
- [ ] 上述 60 组中 `AUTO_MATCH`=0
- [ ] 2025 未 OCR 扫描版 accepted=0
- [ ] 公式安全探针全部不能 `AUTO_MATCH`

### 8.2 必保能力线

- [ ] 2023 双书签 strict precision = 100%
- [ ] 2023 双书签 unique recall = 100%
- [ ] 2024 双书签 strict precision = 100%
- [ ] 2024 双书签 unique recall = 100%

### 8.3 结构退化场景

- [ ] 2024 无答案书签场景不再出现“召回 0% 却假装正常”
- [ ] 2024 双无书签场景优先提高 strict precision，再谈 recall
- [ ] 章节节点不能再被当成题目节点

### 8.4 题内公式规则

- [ ] 缺一个完整公式就不能 `AUTO_MATCH`
- [ ] 只对上周边字而没对上公式不能 `AUTO_MATCH`
- [ ] 公式完全一致且领先第二名明显时，才有资格升高决策等级

### 8.5 性能线

- [ ] 单题匹配 p95 目标 < 150 ms（不含外部 OCR）
- [ ] 批量匹配不得再出现 1.5 s 级常态高延迟
- [ ] top-K 检索后总比较次数显著下降

## 9. 推荐测试补齐

- [ ] T1 题内多公式全部覆盖测试
- [ ] T2 公式完整但文字不同的消歧测试
- [ ] T3 公式不完整但文字相似的拒配测试
- [ ] T4 章节标题误识别为题号测试
- [ ] T5 顺序打乱但内容正确时的全局分配测试
- [ ] T6 双向不一致时的降级测试
- [ ] T7 OCR_REQUIRED 专项测试
- [ ] T8 同页多题共享范围回归测试
- [ ] T9 错角色与错书 reason code 测试
- [ ] T10 `LOW` 不再等于 matched=true 的回归测试

## 10. 风险与回滚

- [ ] 风险 1：一次性替换入口过大，导致 2023 已通过场景回退。
  - 处理：先包一层 `MatchingEngine`，旧逻辑内嵌迁移，不做大爆炸替换。

- [ ] 风险 2：公式抽取过严，短期 recall 下滑。
  - 处理：把 `AUTO_MATCH` 和 `REVIEW` 分开看，先保安全，再补召回。

- [ ] 风险 3：OCR 接入后性能波动大。
  - 处理：OCR 只对单题局部区域触发，禁止整书盲 OCR。

- [ ] 风险 4：无书签场景修复时又引回位置先验误导。
  - 处理：顺序只做加速，不做主证据；必要时全局一对一分配。

- [ ] 风险 5：兼容层过渡太久，新旧逻辑双轨漂移。
  - 处理：每完成一个 Phase，就把对应职责从旧入口拔掉。

## 11. 最终建议

优先顺序不要按“哪里最复杂”排，而要按“哪里最危险”排：

1. 先封 pair gate 与 scanned/OCR gate。
2. 再拆掉 `exactId -> HIGH` 直通。
3. 再修结构层，把章节与题目切开。
4. 再上题内完整公式规则。
5. 再做 top-K、双向一致性与全局分配。
6. 最后做置信度校准与性能压缩。

一句话判断：

现有引擎是“核心积木能用，但总闸门放错地方”。这轮最该重构的不是相似度函数本身，而是决定谁有资格说“这题我已经确定了”的那一层。
