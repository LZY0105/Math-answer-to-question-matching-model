# Offline formula runner for Android

This folder contains the engine repository's own Java inference wrapper. It loads the custom model's encoder, autoregressive decoder, and vocabulary from local files. It does not modify or build the tablet application.

The desktop JAR is a reusable wrapper, not an APK. A successful desktop parity test does not establish Android compatibility, speed, memory use, battery use, or real-world OCR accuracy.

## Bundle and runtime

Export a locally trained checkpoint from the repository root:

~~~powershell
python ocr/export_scratch.py --checkpoint tmp/formula-scratch-run-v1/best.pt --output tmp/formula-scratch-fp32
~~~

The generated bundle contains:

- encoder.onnx and decoder.onnx: model weights and computation graphs.
- metadata.json: preprocessing, dimensions, decoding rules, provenance, hashes, and model status.
- tokenizer.json: the dataset-derived TeX vocabulary.
- model.properties: the same generated Java runtime fields and base64-encoded vocabulary, avoiding an extra JSON library. The runner verifies that these tokens reproduce the canonical UTF-8/LF tokenizer.json checksum; do not edit or reformat either vocabulary view independently.
- export-validation.json: ONNX checker and numerical comparisons; this is not an accuracy report.

For an Android application, use the official Maven runtime dependency:

~~~kotlin
implementation("com.microsoft.onnxruntime:onnxruntime-android:1.23.2")
~~~

The wrapper uses Java 11 source compatibility and standard APIs available on Android API 26+. Include only the desired Android ABIs when packaging, and measure the resulting APK separately from model weight size. The desktop onnxruntime JAR is for desktop verification and must not be packaged in the Android app.

Runtime documentation: [ONNX Runtime Java](https://onnxruntime.ai/docs/get-started/with-java.html) and [OnnxTensor API](https://onnxruntime.ai/docs/api/java/ai/onnxruntime/OnnxTensor.html).

### ORT 格式包（给精简版 ONNX Runtime 用）

官方 Android 包每个架构的原生库有十几到二十多兆。只跑这个模型的话，可以从源码编一个只含所用算子的精简版，对页就是这样做的，三个架构合计 6.3 MB。但精简版只认 ORT 格式的模型，所以先转换：

~~~powershell
python ocr/android/to_ort_bundle.py --bundle ocr/models/formula-scratch-kv-int8-texteller-r10 --output tmp/formula-scratch-kv-int8-texteller-r10-ort --manifest <验证清单.jsonl>
~~~

- **输出包：**
  - `encoder.ort`、`decoder.ort`；`tokenizer.json` 原样拷过去。
  - 改写过的 `model.properties`、`metadata.json`：用 `encoder_file` / `decoder_file`（`metadata.json` 里是 `model_files`）写明文件名，哈希换成新文件的。
- **算子清单：** 同时写出 `required_operators_and_types.config`，这是编精简版时 `--include_ops_by_config` 用的清单，按数据类型精简过。
- **转换设置：** 与官方 `convert_onnx_models_to_ort` 的 Fixed 风格、`--target_platform arm` 相同。
- **转完核对：** 在 `--limit` 张验证图上，与原包按 ARM 的做法加载（关掉 x86 专用的 NCHWc 布局）对比，编码器输出要逐位相同、识别结果要逐记号相同。
- **读包：**
  - `ScratchFormulaRecognizer` 和 `recognize_scratch.py` 都照 `encoder_file` / `decoder_file` 读文件，没写时读 `encoder.onnx` / `decoder.onnx`。
  - 官方完整版运行时也能读 ORT 格式包，`verify_parity.py` 照常可用。

精简版的编法记在对页仓库的 `android/ort-minimal/README.md`。

## Input and output contract

Instantiate ScratchFormulaRecognizer once, reuse its sessions, and close it when finished. Its recognize(FloatBuffer) method accepts exactly imageHeight() * imageWidth() finite float32 values in row-major NCHW order for a single grayscale image. A direct native-order FloatBuffer avoids an input copy. Call inference off the Android UI thread.

### 两种解码接口

model.properties 里的 architecture 决定解码方式，ScratchFormulaRecognizer 和 recognize_scratch.py 两种都支持：

- scratch-formula-ocr-v1：encoder.onnx 输出 memory；decoder.onnx 每步输入 memory 和整段前缀 tokens，取最后一个位置的 logits。前缀越长，每步越慢。
- scratch-formula-ocr-v1-kv（导出时加 --cached-decoder）：encoder.onnx 直接输出各解码层对图像的 cross_keys / cross_values，形状为 [解码层数, 头数, 图像位置数, 每头维度]。decoder.onnx 每步只输入最新一个记号 token（[1, 1]），以及上一步传回的 past_keys / past_values（第一步传长度为 0 的空张量）和 cross_keys / cross_values；输出 logits（[1, 词表大小]）和 present_keys / present_values，后者就是下一步的 past。投影权重只存一份，包不变大。

在本机 CPU 上用第八轮、2 线程测了 201 张验证图。FP32 中位耗时从 46 ms 降到 30 ms，p95 从 202 ms 降到 73 ms；41 个记号以上的长式快约 2.9 倍，短式约 1.3 倍，短式的时间主要花在编码器上。FP32 下两种接口的输出逐记号相同。不认识 -kv 的旧运行器会在加载时报 Unexpected model architecture，不会跑错。

The wrapper deliberately accepts an already preprocessed tensor. The upstream image pipeline must reproduce metadata.json: composite transparency on white, convert to grayscale, crop the bounding box of pixels below 245, preserve aspect ratio with a four-pixel margin using Pillow-equivalent LANCZOS, center on white, then normalize pixel/127.5-1. Passing raw bitmap bytes or using an unverified resize implementation breaks input parity.

Reference tensors can be generated without PyTorch:

~~~powershell
python ocr/recognize_scratch.py --bundle tmp/formula-scratch-fp32 --image formula.png --save-tensor tmp/formula.f32
~~~

The result includes:

- latex and tokenIds: greedy output, excluding BOS/EOS.
- endedWithEos: false means output reached the length limit and is incomplete.
- meanLogProbability: mean full-vocabulary log probability of generated tokens, including EOS when emitted. This is not calibrated confidence or recognition accuracy.
- reviewRequired: always true for this prototype.
- reasonCodes: MODEL_NOT_REALWORLD_VALIDATED, plus NO_EOS or EMPTY when applicable.

Both Python and desktop Java CLIs print the partial result and return exit code 2 for empty or unfinished output. A complete sequence still requires review. Do not pass an unreviewed result to automatic answer matching based on its model score.

The runner opens only local files, verifies model and vocabulary SHA-256 hashes, rejects empty/duplicate tokens and altered special token IDs, uses the CPU execution provider, and never downloads a model or calls a service. INT8 export is optional and requires separate recognition validation before selection.

## Build and desktop parity verification

Download the official desktop runtime JAR from Maven Central into a temporary directory. It is a development dependency and is not committed.

~~~powershell
./ocr/android/build.ps1 -RuntimeJar tmp/ocr-scratch-java/onnxruntime-1.23.2.jar -JavaBin C:/Path/To/JDK/bin
~~~

Then compare the same tensor in Python and Java:

~~~powershell
python ocr/android/verify_parity.py --bundle tmp/formula-scratch-fp32 --image formula.png --java C:/Path/To/JDK/bin/java.exe --runner-jar tmp/ocr-scratch-java/build/scratch-formula-ocr.jar --runtime-jar tmp/ocr-scratch-java/onnxruntime-1.23.2.jar --output tmp/formula-scratch-parity
~~~

Use --image repeatedly for multiple images. The test verifies token equality, EOS/review flags, mean log-probability agreement within 1e-5, and incomplete-output exit codes. It also creates isolated corrupted vocabulary copies and requires rejection of token swaps, duplicates, empty tokens, special-ID swaps, and altered tokenizer JSON. It records the checkpoint hash. Its results are desktop deployment evidence only.

On this Windows host, the Android Studio JBR's bundled older VC runtime could not initialize the ORT native library. The already installed JDK 21.0.11 succeeded. Its non-ASCII installation path required a temporary ASCII drive mapping for the launcher. No JDK files were modified; no system runtime was replaced.

Actual acceptance on the intended Honor GT Pro requires running the final bundle on that device and recording independent formula accuracy, input preprocessing agreement, warm/cold latency, and peak memory. This repository's desktop check does not claim those device results.

On this host, ONNX Runtime's dynamic quantizer also required an ASCII temporary path because its native shape-inference function could not create files below the default non-ASCII Windows temporary directory. Set TMPDIR to an existing ASCII path (a temporary mapping of a folder inside this repository is sufficient) for the export process, then restore the environment. The quantizer and installed dependencies do not need modification.

The v1 trained INT8 baseline passed desktop Python/Java parity on five validation images covering the requested formula families; its report is tmp/formula-scratch-int8-v1-parity/parity-report.json. This baseline is retained separately while broader structure training is evaluated. The latest recognition-accuracy and delivery status is owned by the model card, not this deployment guide.
