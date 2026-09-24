# 书本资料：2026-09-24

完整归档维护者提供的“书本”目录：63 份 PDF、1 份原始分类说明，共 8,758,976,034 字节（约 8.16 GiB）。书本原件放在 [GitHub Release](https://github.com/LZY0105/Math-answer-to-question-matching-model/releases/tag/test-corpus-20260924)，普通 git clone 只获取清单与工具。

- [逐文件下载目录](CATALOG.md)
- [机器可读清单及 SHA-256](manifest.json)
- [原始分类说明](source-inventory.txt)
- [首轮评估：22 卷的文本层、书签结构、科目判定与配对矩阵](EVALUATION.md)
- [Android 实测与复审方案](../../docs/android-performance/2026-09-13/README.md)

使用 Node.js 18 或更新版本，在仓库根目录运行：

~~~sh
node datasets/books-20260924/download.mjs --list
node datasets/books-20260924/download.mjs --id book-001 --out ../find-engine-books
node datasets/books-20260924/download.mjs --all --out ../find-engine-books
~~~

默认只列清单；下载恢复中文原名并校验大小及 SHA-256。已存在且校验一致的文件跳过，不覆盖不一致的文件。完整下载约 8.76 GB，请按需选择。Release 资产采用稳定英文文件名，原名映射以 manifest 为准。

这些资料供后续开发与测试，不是已验证的标注集。分类说明的“电子书/答案”是提供方标签，未逐项验证。当前归档未验证 PDF 页数、题目覆盖、答案正确率或书籍配对；不得将 2023 有书签资料的测试数字直接用于本目录。资料包含第三方出版物，仓库代码许可不构成对这些出版物的重新授权。
