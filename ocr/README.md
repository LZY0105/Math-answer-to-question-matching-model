# Find-Engine 自建轻量公式 OCR

这个目录提供从随机参数训练的公式识别核心：输入单个印刷公式裁图，输出 LaTeX。没有使用现成 OCR 模型、预训练权重或教师模型。PyTorch 用于训练，MathJax 和 sharp 用于渲染自编公式，ONNX Runtime 用于本地推理。

目标设备为荣耀 GT Pro（12 GB 内存）；当前训练和验证使用本机 NVIDIA GeForce RTX 4050 Laptop GPU（6 GB 显存）及桌面 CPU。所有实现均位于答案匹配引擎仓库，Android 应用未改动。

## 状态与入口

- [MODEL_CARD.md](MODEL_CARD.md)：模型状态、评估范围和未验证事项。
- [PDF_DATA.md](PDF_DATA.md)：用户提供 PDF 的提取、视觉转写和分区规则。
- [reports/v1/](reports/v1/)：第一轮历史结果；复杂结构泛化不足，不能作为上线依据。
- [android/](android/)：Java 推理封装、桌面一致性验证和 Android 接入契约。

这是实验模型。`reviewRequired` 始终为 `true`，`meanLogProbability` 不是校准后的置信度。输出需核对后才能用于自动答案匹配。整页检测、中文题干识别和手写识别不在这个核心的范围内。

## 结构与输入

自编卷积视觉编码器接两层 Transformer 编码器、三层自回归解码器。隐藏维度 192、前馈维度 576，第二版共 2,407,462 个参数。词表只从训练标签建立，含 184 个公式符号及 3 个特殊标记。

第二版输入为 192 × 512 灰度图。预处理在白色背景上合成透明通道，按灰度低于 245 的内容裁去空白，保留比例缩放、居中并留四像素边距，最后使用 `pixel / 127.5 - 1`。Python 使用 Pillow LANCZOS；Android 图像预处理需要独立验证一致性，现有 Java 核心接收已经处理好的浮点张量。

LaTeX 目标去除不可见的间距、字号及自动定界符尺寸命令，保留可见括号、上下标、运算符、环境和标点，不做代数化简。原始转写保存在本地清单的 `source_latex` 中。

## 本地推理

推理只需要 NumPy、Pillow 和 ONNX Runtime，不需要 PyTorch。`--bundle` 指向已导出且验证过的本地模型目录：

```sh
python -m pip install -r ocr/requirements.txt
python ocr/recognize_scratch.py --bundle PATH_TO_BUNDLE --image formula.png
```

返回 JSON 包含 `latex`、`tokenIds`、`endedWithEos`、`meanLogProbability`、`reviewRequired` 和原因代码。空输出或未终止输出的退出码为 2。模型、词表及运行参数在加载时校验；推理过程不下载模型、不调用云服务。

## 数据集与人工复核

训练标签怎么来的，这几个脚本是完整记录。它们之前一直散在仓库根目录、没进版本控制——模型进了仓，做出模型的过程没进。

按运行顺序：

| 脚本 | 做什么 |
|---|---|
| `extract_formula_dataset.py` | 从源书 PDF 渲染页面、切出公式候选 |
| `build_pure_formula_dataset.py` | 候选 → 纯公式数据集：检测、以 TexTeller 为教师打标签、分区落到 SQLite |
| `verify_training_ready_dataset.py` | 开训之前的闸：重复 id、缺图、空标签、标签里混进汉字或控制字符 |
| `review_pending_formula_labels.py` | 人工复核待定标签；`--phase adjudicate --decisions-file` 把裁决结果并回去 |
| `inspect_review_nearest.py` | 复核时看某条候选在数据集里最近的几个邻居 |

`review_decisions_batch_001.jsonl` 是已经做过的那一批人工裁决（`accept_visual` 一类的判定，带 LaTeX 和理由）。它和其它数据不一样：**重跑不出来**，所以它进仓。

两条关于路径的约定：

- `--source` 和 `--output` 没有默认值，必须显式给。源书目录和数据集落地处都是机器相关的，给默认值等于把某一台机器的路径当成约定——主干的 `b0b5d56`（Keep home directories out of the extractor and its output）记的就是这件事。
- `pdftoppm` 从 PATH 上找，`--pdftoppm` 可以覆盖，和 `import_pdf_formulas.py` 一致。`extract_formula_dataset.py` 另外把它落进 `PDFTOPPM` 环境变量，因为渲染在 `ProcessPoolExecutor` 的工作进程里跑，而 Windows 用 spawn 起子进程，父进程改过的全局变量到不了那边。

训练数据、中间产物和各轮评估输出都不进仓：数据在被忽略的 `tmp/` 下，评估输出在被忽略的 `reports/` 下。

## 复现第二轮训练

已验证环境为 Python 3.12、PyTorch 2.10.0 + CUDA 12.6、Node.js 24。其余工具版本固定在 requirements 和 npm lockfile 中。以下 `python` 应指向安装了这些依赖的解释器：

```sh
npm ci --prefix ocr --ignore-scripts --no-audit --no-fund
python -m pip install torch==2.10.0 --index-url https://download.pytorch.org/whl/cu126
python -m pip install -r ocr/requirements.txt
node ocr/generate-diverse-data.mjs --output tmp/formula-diverse-data-v2 --train 40000 --validation 1500 --test 1500 --seed 9152026 --image-height 192 --image-width 512
node ocr/generate-symbol-data.mjs --output tmp/formula-symbols-v2-fixed
node ocr/audit-formula-syntax.mjs --dataset tmp/formula-diverse-data-v2 --output tmp/formula-diverse-strict-audit-v2.json
node ocr/audit-formula-syntax.mjs --dataset tmp/formula-symbols-v2-fixed --splits train --output tmp/formula-symbols-strict-audit-v2-fixed.json
```

按 [PDF 数据说明](PDF_DATA.md) 重建已核对的本地 PDF 清单后，混合并训练：

```sh
python -m ocr.prepare_mixed_data --synthetic tmp/formula-diverse-data-v2 --symbols tmp/formula-symbols-v2-fixed --pdf tmp/ocr-pdf-reviewed-v1 --output tmp/formula-mixed-data-v2-fixed --pdf-repeats 32
python -m ocr.train_scratch --train-manifest tmp/formula-mixed-data-v2-fixed/train.jsonl --val-manifest tmp/formula-mixed-data-v2-fixed/validation.jsonl --output-dir tmp/formula-scratch-run-v2-fixed --device cuda --batch-size 64 --epochs 30 --learning-rate 0.001 --warmup-steps 300 --eval-samples 158 --workers 4 --threads 4 --augment --patience 6 --log-every 100 --image-height 192 --image-width 512
```

最终清单有 40,000 张递归公式、1,446 张符号覆盖图和 64 张真实 PDF 训练裁图。PDF 裁图各重复采样 32 次，共 43,494 行；重复采样不增加独立样本数。符号覆盖图包含 482 个标签的三种渲染。另有 1,508 个验证样本、1,510 个测试样本和 28 个自编结构挑战样本。公式标签、图片哈希和真实 PDF 页分区均检查隔离；与评估集冲突的三张符号图已排除。

模型选择使用固定的前 158 个验证样本（8 个 PDF 和 150 个合成公式）的完整贪心识别率，验证损失覆盖全部 1,508 个样本。测试与结构挑战集只用于冻结模型后的评估。第一版的 12 个挑战样本已被查看，属于历史开发证据，不再作为新盲测。

`best.pt` 按验证识别率优先、损失次优选择；`last.pt` 支持完整轮次恢复。恢复时需保持原训练配置和清单哈希。训练图片、用户 PDF、转写、检查点与缓存留在 Git 忽略的 `tmp/` 中，源 PDF 不会被修改。

## 导出与验证

冻结最佳检查点后分别导出 FP32 和动态 INT8，在完整验证集上比较识别结果，再选择发布精度：

```sh
python ocr/export_scratch.py --checkpoint PATH_TO_FROZEN_CHECKPOINT --output tmp/formula-fp32
python ocr/export_scratch.py --checkpoint PATH_TO_FROZEN_CHECKPOINT --output tmp/formula-int8 --quantize-dynamic
python ocr/evaluate_scratch.py --bundle tmp/formula-int8 --manifest tmp/formula-mixed-data-v2-fixed/validation.jsonl --output tmp/formula-int8-validation.json
```

INT8 量化矩阵乘法和线性层，卷积仍为 FP32；导出文件体积不包括 ONNX Runtime 或 APK。导出检查验证多个解码长度上的数值一致性，不能替代识别评估。Windows 中文临时目录的量化兼容处理见 [Java 部署说明](android/README.md)。

最终评估应分别报告 `synthetic-test.jsonl`、`pdf-test.jsonl` 和 `challenge.jsonl`。同一渲染器生成的公式准确率不能代表真实书页；10 个 PDF 测试裁图也只构成小规模诊断。极端长式中的深层分数在最终输入尺寸下可能只有约 5–8 像素高的小字形。

```sh
python -m unittest ocr.test_scratch_model ocr.test_pdf_import ocr.test_mixed_data
node --test ocr/test_strict_mathjax.mjs
```

目标手机的速度、内存占用、拍照识别率和图像预处理一致性需要在设备上测量。桌面 Java 与 Python 一致性通过不等于已完成手机验收。
