# 2023–2025 数学专业考研真题语料

本目录登记 9 个用户提供的 2023–2025 年数学专业考研 PDF，共 246,776,725 字节，供后续开发、离线运行和匹配测试使用。

- [文件清单](manifest.json)
- [SHA-256 校验值](SHA256SUMS)
- [上传核验记录](upload-verification.json)
- [GitHub Release 下载页](https://github.com/LZY0105/Math-answer-to-question-matching-model/releases/tag/exam-corpus-20260924)
- [与三套语料测试套件的对照结果](EVALUATION.md)

PDF 二进制文件存放在 GitHub Release 资产中，主分支只保存清单、校验值、核验记录和下载工具。该语料不代表新的匹配准确率结论。

需要 Node.js 18 或更高版本。列出文件：

```sh
node datasets/exam-corpus-20260924/download.mjs --list
node datasets/exam-corpus-20260924/download.mjs --id exam-009 --out ../exam-corpus
node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus
```
