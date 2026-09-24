# 2023–2025 数学专业考研真题资料

共 8 份 PDF，来自用户提供的 2023–2025 数学专业考研真题、完整答案解析和留白作答版，总大小 246,109,076 字节。

- [机器可读清单](manifest.json)
- [SHA-256 清单](SHA256SUMS)
- [GitHub Release 下载](https://github.com/LZY0105/Math-answer-to-question-matching-model/releases/tag/exam-corpus-20260924)
- [与三套语料测试套件的对照结果](EVALUATION.md)：上传的 2023 习题册没有题级书签，与测试套件依赖的版本不同

资料用于后续开发与测试，当前上传不代表已完成题目覆盖、答案准确率或匹配评测。完整答案解析与留白作答版是不同用途的输入，不能直接当作题目—答案配对结果。

使用 Node.js 18 或更新版本，在仓库根目录运行：

~~~sh
node datasets/exam-corpus-20260924/download.mjs --list
node datasets/exam-corpus-20260924/download.mjs --id exam-001 --out ../exam-corpus
node datasets/exam-corpus-20260924/download.mjs --all --out ../exam-corpus
~~~

下载器默认只列清单；下载时恢复原始中文文件名，并校验文件大小与 SHA-256。PDF 作为 Release 资产发布，不直接进入普通 Git 历史。
