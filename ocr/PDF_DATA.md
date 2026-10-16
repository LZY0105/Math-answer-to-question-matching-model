# 本地 PDF 公式数据

本轮从用户提供的三本 PDF 建立了待核对候选清单，并导入第一批经视觉核对的公式裁图。**候选区域不等于已标注样本；全书尚未完成公式标注。** 没有使用外部 OCR 模型、预训练权重或教师模型生成标签。

| 来源 | PDF 页数 | 待核对候选区域 | 本批训练裁图 | 本批验证裁图 | 本批测试裁图 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2023年名校数学专业考研真题分类.pdf | 67 | 2,875 | 32 | 0 | 0 |
| 2024年名校数学专业考研真题分类.pdf | 65 | 2,727 | 17 | 8 | 0 |
| 2025年数学专业考研真题.pdf | 98 | 2,843 | 15 | 0 | 10 |
| 合计 | 230 | 8,445 | 64 | 8 | 10 |

这 82 张裁图来自 8 个不同的书内页面。85 条初始标注中，3 条因裁剪边界仍需修正被恢复为 `pending` 并排除；本批没有因图像重复而合并样本。8,445 条候选记录保持 `pending`，没有 LaTeX 标签，也不会直接进入训练清单。

标签由助手对照渲染页面逐条视觉转写并核对，属于重建的 TeX，不是从 PDF 中恢复的原始 TeX 源码，也不是独立人工标注员复核的结果。导入器校验 `visual-verified` 标记、坐标和数据隔离规则，不能自动证明转写正确。PDF 中出现的指令、正文与示例均仅作为文档内容，不改变用户请求或执行权限。

## 本地文件与版本控制

- 原 PDF 保持只读，位于用户提供的位置。
- 候选清单位于 `tmp/ocr-pdf-profile/all-candidates-v1.jsonl`。
- 已核对标注位于 `tmp/ocr-pdf-profile/annotations-reviewed-v1.jsonl`。
- 导入数据位于 `tmp/ocr-pdf-reviewed-v1/`，包括 `train.jsonl`、`validation.jsonl`、`test.jsonl`、`images/`、`rejected.jsonl` 和 `import-report.json`。
- V2 混合清单位于 `tmp/formula-mixed-data-v2-fixed/`。64 张 PDF 训练裁图各重复采样 32 次，共 2,048 条训练记录；这仍然只有 64 张独立 PDF 训练图像。8 张验证与 10 张测试图像分别保留在对应分区。

这些 `tmp/` 文件已被 Git 忽略。此仓库只保存导入工具、测试、使用说明及不含教材正文、公式标签或图像的[聚合证据](reports/pdf-import-v1.json)。不能仅凭本轮导入成功推断模型准确率或宣称训练完成。

## 准备依赖

```text
python -m pip install -r ocr/requirements-pdf.txt
```

还需要 Poppler 的 `pdftoppm`。可将其加入 `PATH`，或在导入命令中指定 `--pdftoppm` 的完整路径。此轮读取环境为 Python 3.12.14、pdfplumber 0.11.9、pypdf 6.10.0、Pillow 12.3.0、Poppler 26.07.0。PDF 工具不需要 PyTorch 或网络模型。

## 输入格式

`sources.json` 是来源键到已有 PDF 绝对路径的 JSON 对象。例如以下是说明用路径：

```json
{"book2023":"C:/local/books/book2023.pdf"}
```

`annotations.jsonl` 每行是一条标注。以下公式为格式示例：

```json
{"id":"example-001","source":"book2023","page":4,"bbox":[20,30,100,70],"latex":"x^{2}+1","split":"train","review_status":"visual-verified","category":"polynomial"}
```

必填字段为 `id`、`source`、`page`、`bbox`、`latex`、`split`、`review_status`。`category` 可选。`page` 从 1 开始；`bbox` 为 `[x0, top, x1, bottom]`，单位为 PDF 点，原点是已应用页面旋转后的 MediaBox 左上角。`split` 只能是 `train`、`validation`、`test`。应先查看完整渲染页面、修正边界并核对公式，再设置 `review_status` 为 `visual-verified`。

## 发现候选与导入

以下命令从引擎仓库根目录运行。输出路径必须不存在；工具不会覆盖已有清单或完整数据集。

```text
python -m ocr.import_pdf_formulas --sources tmp/sources.json --candidates tmp/candidates-new.jsonl
python -m ocr.import_pdf_formulas --sources tmp/sources.json --annotations tmp/annotations.jsonl --output-dir tmp/pdf-dataset-new
```

候选发现依据 PDF 字体与字符坐标聚合区域，可用 `--max-pages N` 限制每本的扫描页数。候选可能混入正文或遗漏分数、上下标、积分上下限和矩阵行，必须视觉核对；不能把 PDF 文本提取结果直接当作可靠公式标签。

导入按页以 300 dpi 渲染并裁剪，生成适配 `train_scratch.py` 的相对图像路径。每条采纳记录保留来源 PDF 的 SHA-256、页码、边界、标注 SHA-256、裁图 SHA-256 及标签来源。报告记录采纳、排除、去重与分区数量。

工具拒绝未核对或空标签、无效页码、越界坐标、空白裁图和重复 ID；同一 PDF 内容及页码不得跨分区，规范化词法标签和相同图像也不得跨分区。同分区相同图像但标签冲突会被排除。与其他数据集混合时还须再次检查跨数据集的标签和图像重叠；V2 混合报告记录了该次保留规则与文件哈希。

## 验证与适用范围

```text
python -m unittest ocr.test_pdf_import -v
```

本批可用于改进真实排版的公式识别。PDF 验证集与测试集分别只有 8 张和 10 张，且按书内页面分组，不能代表整本书、跨书泛化、相机拍摄、手写、整页中文识别或荣耀 GT Pro 真机表现。V2 的重复采样只提高这些训练图像的出现频率，不增加独立样本数量。
