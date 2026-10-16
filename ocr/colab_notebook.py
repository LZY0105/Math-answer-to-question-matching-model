"""生成在 Google Colab 上训练公式 OCR 的 notebook。

  python ocr/colab_notebook.py --out formula-ocr.ipynb --run-tag NAME --epochs 12 \\
      --addon-zip texteller-norm-addon.zip --label-normalization texteller-norm-v1 --gpu-type L4

notebook 依次：检查 GPU → 挂载云端硬盘（等授权最多 15 分钟）→ 把基础数据包（和补充包）
复制到本地盘解压 → 写出 ocr/ 下的训练与评估代码 → 训练（输出写在云端硬盘上，断线后重跑
训练格会从最后一个完整轮次续训）→ 训练曲线 → 在完整验证集上评估 → 打印检查点哈希。
结果从云端硬盘取回，不在浏览器里下载。

扫参模式（--sweep 配置.json，内容为 [{"name": ..., "args": "额外参数"}, ...]）在同一个会话里
依次训练每组设置，只需授权一次：每组写到 runs/NAME/组名/，训练完各自在完整验证集上评估，
最后汇总成一张表。会话中途断开时重跑扫参格，已评估的组跳过，未完成的组从最近一轮续训。
--train-every K 只取每 K 条训练样本中的 1 条，做更省的缩小版对照。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

OCR = Path(__file__).resolve().parent
EMBEDDED = ("scratch_model.py", "train_scratch.py", "evaluate_scratch.py", "export_scratch.py", "evaluate_matching.py")


def lines(source: str) -> list[str]:
    parts = source.strip("\n").split("\n")
    return [f"{part}\n" for part in parts[:-1]] + [parts[-1]]


def code(source: str) -> dict:
    return {"cell_type": "code", "execution_count": None, "metadata": {}, "outputs": [], "source": lines(source)}


def markdown(source: str) -> dict:
    return {"cell_type": "markdown", "metadata": {}, "source": lines(source)}


def build(args: argparse.Namespace) -> dict:
    height, width = args.image_height, args.image_width
    run = f"/content/drive/MyDrive/formula-ocr/runs/{args.run_tag}"
    suffix = "-norm" if args.addon_zip else ""
    train_manifest = f"/content/data/train{suffix}.jsonl"
    early_stop = f"/content/data/validation-disjoint{suffix}.jsonl"
    full_validation = f"/content/data/validation{suffix}.jsonl"
    if args.train_every > 1:
        train_manifest = f"/content/data/train{suffix}-every{args.train_every}.jsonl"
        early_stop = f"/content/data/validation-disjoint{suffix}-every{args.train_every}.jsonl"
    sweep_validation = full_validation
    if args.eval_every > 1:
        sweep_validation = f"/content/data/validation{suffix}-every{args.eval_every}.jsonl"
    flags = [f"--teacher-model {args.teacher_model}"] if args.teacher_model else []
    if args.label_normalization:
        flags.append(f"--label-normalization {args.label_normalization}")
    if args.bn_recalibration_images:
        # 不重估时，高学习率下逐轮验证会被过期的 BN 统计拖垮，最后一轮的检查点也一样
        flags.append(f"--bn-recalibration-images {args.bn_recalibration_images}")
    zips = [args.base_zip] + ([args.addon_zip] if args.addon_zip else [])
    sweep = json.loads(Path(args.sweep).read_text(encoding="utf-8")) if args.sweep else None
    base_args = [f"--train-manifest {train_manifest}", f"--val-manifest {early_stop}",
                 f"--device cuda --batch-size 128 --epochs {args.epochs} --learning-rate {args.learning_rate}",
                 "--warmup-steps 1000 --eval-samples 500 --threads 2",
                 f"--augment --patience {args.patience} --log-every 200",
                 f"--image-height {height} --image-width {width}",
                 f"--decoder-layers {args.decoder_layers} {' '.join(flags)}".strip()]

    cells = [
        markdown(f"""
# 公式 OCR {'扫参' if sweep else '训练'}：{args.run_tag}

**数据**：63 本考研教材的真实公式裁图，标签由 TexTeller-3.0 生成，按「书 + 页」划分。
{'标签已按 `' + args.label_normalization + '` 统一写法（补充包 `' + args.addon_zip + '`）。' if args.addon_zip else ''}
{f'**缩小版对照**：训练集每 {args.train_every} 条取 1 条。' if args.train_every > 1 else ''}

**模型**{'（基准，各组的改动见「扫参」）' if sweep else ''}：解码器 {args.decoder_layers} 层，`d_model` 192、编码器 2 层、前馈 576、6 头、视觉部分 v1；画布 {width} × {height}。
**训练**：{args.epochs} 轮{'，不早停（余弦学习率走完全程）' if args.patience == 0 else f'，早停耐心 {args.patience} 轮'}。
{('**扫参**：' + '；'.join(f"`{c['name']}`（{c['args'] or '基准'}）" for c in sweep) + '。') if sweep else ''}

**运行前**：{f'执行阶段类型选 **{args.gpu_type} GPU**；' if args.gpu_type else ''}`{'`、`'.join(zips)}` 要在云端硬盘「我的云端硬盘」里；执行挂载格时需要本人在弹窗里授权（最多等 15 分钟）。
"""),
        code("""
import torch, subprocess
print('torch', torch.__version__, '| CUDA', torch.version.cuda, '| 可用', torch.cuda.is_available())
if not torch.cuda.is_available():
    raise SystemExit('没有 GPU：执行阶段 -> 变更执行阶段类型 -> 选一种 GPU')
print(torch.cuda.get_device_name(0), '%.1f GB' % (torch.cuda.get_device_properties(0).total_memory / 2**30))
print('CPU 核数', subprocess.run(['nproc'], capture_output=True, text=True).stdout.strip())
"""),
        markdown("## 1. 挂载云端硬盘并把数据解压到本地盘"),
        code("""
from google.colab import drive
# 默认只等 2 分钟授权；放宽到 15 分钟，免得人还没点完就超时
drive.mount('/content/drive', timeout_ms=900000)
"""),
        code(f"""
import glob, os, shutil, subprocess, time
os.makedirs('/content/data', exist_ok=True)
for name in {zips!r}:
    hits = glob.glob('/content/drive/MyDrive/**/' + name, recursive=True)
    if not hits:
        raise SystemExit('云端硬盘里找不到 ' + name + '，请确认已上传完成')
    t = time.time()
    shutil.copy(hits[0], '/content/' + name)
    subprocess.run(['unzip', '-q', '-o', '/content/' + name, '-d', '/content/data'], check=True)
    os.remove('/content/' + name)
    print('%s %.2f GB，复制并解压 %.0f 秒' % (name, os.path.getsize(hits[0]) / 2**30, time.time() - t))
"""),
    ]
    if args.train_every > 1:
        cells.append(code(f"""
import json, re
# 缩小版：每 {args.train_every} 条取 1 条；早停子集只留 token 全在缩小后词表里的样本
TOKEN = re.compile(r"\\\\(?:begin|end)\\{{[a-zA-Z*]+\\}}|\\\\[A-Za-z]+|\\\\.|.", re.DOTALL)
tokens = lambda latex: [t for t in TOKEN.findall(latex) if not t.isspace()]
rows = open('/content/data/train{suffix}.jsonl', encoding='utf-8').read().splitlines()[::{args.train_every}]
open({train_manifest!r}, 'w', encoding='utf-8').write('\\n'.join(rows) + '\\n')
vocab = {{t for line in rows for t in tokens(json.loads(line)['latex'])}}
kept = [line for line in open('/content/data/validation-disjoint{suffix}.jsonl', encoding='utf-8').read().splitlines()
        if set(tokens(json.loads(line)['latex'])) <= vocab]
open({early_stop!r}, 'w', encoding='utf-8').write('\\n'.join(kept) + '\\n')
print('训练', len(rows), '条，早停子集', len(kept), '条')
"""))
    if args.eval_every > 1:
        cells.append(code(f"""
# 扫参各组在验证集每 {args.eval_every} 条取 1 条上评估：同一批样本逐条配对比较，省下大半评估时间
rows = open({full_validation!r}, encoding='utf-8').read().splitlines()[::{args.eval_every}]
open({sweep_validation!r}, 'w', encoding='utf-8').write('\\n'.join(rows) + '\\n')
"""))
    cells.append(code(f"""
for name in ({train_manifest!r}, {early_stop!r}, {sweep_validation!r}):
    print(name, sum(1 for _ in open(name, encoding='utf-8')), '行')
"""))
    cells += [markdown("## 2. 写出代码"), code("!mkdir -p /content/work/ocr")]
    for name in EMBEDDED:
        cells.append(code(f"%%writefile /content/work/ocr/{name}\n" + (OCR / name).read_text(encoding="utf-8")))

    if sweep:
        cells += sweep_cells(run, base_args, sweep, sweep_validation)
    else:
        cells += single_run_cells(run, base_args, early_stop, full_validation, bool(suffix))

    colab = {"provenance": [], "name": f"formula-ocr-{args.run_tag}.ipynb"}
    if args.gpu_type:
        colab["gpuType"] = args.gpu_type        # Colab 打开时据此申请这种 GPU
    return {"nbformat": 4, "nbformat_minor": 0,
            "metadata": {"colab": colab, "kernelspec": {"name": "python3", "display_name": "Python 3"},
                         "language_info": {"name": "python"}, "accelerator": "GPU"},
            "cells": cells}


def single_run_cells(run: str, base_args: list[str], early_stop: str, full_validation: str, normalized: bool) -> list[dict]:
    cells = [
        markdown(f"""
## 3. 训练

早停与挑最佳检查点用 `{Path(early_stop).name}`（验证集中标签不在训练集出现的子集，偏难）；
准确率以第 5 节在完整验证集上的结果为准。输出写在云端硬盘：断线后重新执行第 1、2 节和本格，
会从最后一个完整轮次续训。数据加载进程数按 CPU 核数自动定，只影响速度，不改变样本顺序。
"""),
        code(f"""
import os
RUN = {run!r}
os.makedirs(RUN, exist_ok=True)
workers = max(2, (os.cpu_count() or 2) - 2)
args = {base_args!r} + [f'--output-dir {{RUN}} --workers {{workers}}']
if os.path.exists(f'{{RUN}}/last.pt'):
    args.append(f'--resume {{RUN}}/last.pt')
    print('发现 last.pt，续训')
cmd = 'cd /content/work && python -m ocr.train_scratch ' + ' '.join(args)
print(cmd)
get_ipython().system(cmd)
"""),
        markdown("## 4. 训练曲线"),
        code(f"""
import json
rows = [json.loads(l) for l in open('{run}/metrics.jsonl', encoding='utf-8')]
for r in rows:
    if r['event'] == 'validation':
        print('epoch %2d  验证 loss %.4f  训练 loss %.4f  早停子集一致 %d/%d = %.1f%%  未写完 %d%s'
              % (r['epoch'], r['loss_per_token'], r['train_loss_per_token'], r['greedy_exact_count'],
                 r['greedy_samples'], 100 * r['greedy_exact_match'], r['truncated_count'], '  *' if r['best_updated'] else ''))
fin = [r for r in rows if r['event'] == 'finished']
if fin:
    print('\\n步数 %d，耗时 %.1f 分钟' % (fin[0]['steps'], fin[0]['elapsed_seconds'] / 60))
"""),
        markdown(f"""
## 5. 完整验证集评估

用最后一轮的检查点 `last.pt`：余弦学习率走完后最后一轮通常最好，按早停子集 500 条抽样挑出的
`best.pt` 噪声太大。衡量的是**与 TexTeller 输出的一致率**，不是人工真值下的正确率。
{'参考为统一写法后的标签；按原始写法计分可在本机用同一份识别结果重算，不必再跑一遍。' if normalized else ''}
"""),
        code(f"""
!cd /content/work && python ocr/evaluate_scratch.py --checkpoint {run}/last.pt --manifest {full_validation} \\
  --output {run}/validation-full.json --device cuda --batch-size 128 --threads 2 | tail -c 400
"""),
        code(f"""
import json
r = json.load(open('{run}/validation-full.json', encoding='utf-8'))
print('%d 条  精确一致 %d = %.2f%%  未写完 %d  token 错误率 %.4f'
      % (r['samples'], r['exact_count'], 100 * r['exact_rate'], r['missing_eos'], r['token_error_rate']))
"""),
    ]
    cells += [
        markdown("## 6. 校验\n\n打印检查点的 SHA-256，供本机从云端硬盘同步后核对。"),
        code(f"!sha256sum {run}/best.pt {run}/last.pt && ls -l {run}"),
    ]
    return cells


def sweep_cells(run: str, base_args: list[str], sweep: list[dict], validation: str) -> list[dict]:
    return [
        markdown(f"""
## 3. 扫参

依次训练每组设置，并用各组最后一轮的检查点在 `{Path(validation).name}` 上评估（按早停子集
500 条抽样挑出的「最佳」轮次噪声太大，不用）。中途断开时重新执行第 1、2 节和本格：已评估的组
跳过，未完成的组从最近一个完整轮次续训。
"""),
        code(f"""
import os, subprocess
BASE = {run!r}
SWEEP = {[(c['name'], c['args']) for c in sweep]!r}
workers = max(2, (os.cpu_count() or 2) - 2)
for name, extra in SWEEP:
    run = f'{{BASE}}/{{name}}'
    if os.path.exists(f'{{run}}/validation-sweep.json'):
        print(name, '已完成，跳过')
        continue
    os.makedirs(run, exist_ok=True)
    args = {base_args!r} + [f'--output-dir {{run}} --workers {{workers}}', extra]
    if os.path.exists(f'{{run}}/last.pt'):
        args.append(f'--resume {{run}}/last.pt')
    finished = os.path.exists(f'{{run}}/metrics.jsonl') and '"finished"' in open(f'{{run}}/metrics.jsonl', encoding='utf-8').read()
    if not finished:
        print('==', name, extra or '（基准）')
        code = subprocess.run('cd /content/work && python -m ocr.train_scratch ' + ' '.join(args) + f' > {{run}}/train.log 2>&1',
                              shell=True).returncode
        if code:
            # 一组失败（如学习率过高导致损失溢出）不拖累其余各组；原因见该组 train.log
            print(name, '训练失败，退出码', code, '，跳过；末尾日志：', open(f'{{run}}/train.log', encoding='utf-8').read()[-300:])
            continue
    code = subprocess.run(f'cd /content/work && python ocr/evaluate_scratch.py --checkpoint {{run}}/last.pt '
                          f'--manifest {validation} --output {{run}}/validation-sweep.json --device cuda '
                          f'--batch-size 128 --threads 2 > {{run}}/evaluate.log 2>&1', shell=True).returncode
    print(name, '完成' if code == 0 else f'评估失败，退出码 {{code}}')
"""),
        markdown(f"## 4. 汇总\n\n`{Path(validation).name}` 上与 TexTeller（统一写法后）的一致率；规范化口径同配对引擎（evaluate_matching）。"
                 "带标签平滑的组，训练 loss 含平滑项，不能和其他组直接比。"),
        code(f"""
import json, sys
sys.path.insert(0, '/content/work/ocr')
from evaluate_matching import Features
BASE = {run!r}
print('%-16s %8s %8s %6s %9s %9s %7s' % ('组', '精确', '规范化', '未写完', '早停loss', '训练loss', '分钟'))
for name, extra in {[(c['name'], c['args']) for c in sweep]!r}:
    try:
        r = json.load(open(f'{{BASE}}/{{name}}/validation-sweep.json', encoding='utf-8'))
    except FileNotFoundError:
        print('%-16s 未完成或失败（见该组 train.log）' % name)
        continue
    p = r['predictions']
    canon = sum(1 for x in p if x['ended_with_eos'] and Features(x['expected']).text == Features(x['predicted']).text)
    ev = [json.loads(l) for l in open(f'{{BASE}}/{{name}}/metrics.jsonl', encoding='utf-8')]
    val = [e for e in ev if e['event'] == 'validation'][-1]
    fin = [e for e in ev if e['event'] == 'finished'][-1]
    print('%-16s %7.2f%% %7.2f%% %6d %9.4f %9.4f %7.0f' % (name, 100 * r['exact_rate'], 100 * canon / len(p), r['missing_eos'],
          val['loss_per_token'], val['train_loss_per_token'], fin['elapsed_seconds'] / 60))
"""),
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run-tag", required=True, help="云端硬盘 formula-ocr/runs/ 下的输出目录名")
    parser.add_argument("--epochs", type=int, default=6)
    parser.add_argument("--patience", type=int, default=0)
    parser.add_argument("--learning-rate", type=float, default=0.001)
    parser.add_argument("--decoder-layers", type=int, default=3)
    parser.add_argument("--image-height", type=int, default=256)
    parser.add_argument("--image-width", type=int, default=768)
    parser.add_argument("--base-zip", default="texteller-dataset.zip")
    parser.add_argument("--addon-zip", default=None, help="prepare_normalized_dataset.py 生成的补充包")
    parser.add_argument("--teacher-model", default="TexTeller-3.0-ONNX")
    parser.add_argument("--label-normalization", default=None)
    parser.add_argument("--gpu-type", default=None, choices=("T4", "L4", "A100", "G4"),
                        help="写进 notebook 元数据的 GPU 类型；不给则用 Colab 默认")
    parser.add_argument("--sweep", default=None, help="扫参配置 JSON：[{\"name\": ..., \"args\": ...}]")
    parser.add_argument("--train-every", type=int, default=1, help="只取每 K 条训练样本中的 1 条")
    parser.add_argument("--eval-every", type=int, default=1, help="扫参时只在每 K 条验证样本中的 1 条上评估")
    parser.add_argument("--bn-recalibration-images", type=int, default=3200,
                        help="每轮验证前用这么多张训练图重估 BN 统计（train_scratch 同名参数）；0 关闭")
    args = parser.parse_args()
    if bool(args.addon_zip) != bool(args.label_normalization):
        parser.error("--addon-zip 与 --label-normalization 要一起给")
    if args.train_every < 1 or args.eval_every < 1:
        parser.error("--train-every 与 --eval-every 至少为 1")
    if args.bn_recalibration_images < 0:
        parser.error("--bn-recalibration-images 不能为负")
    notebook = build(args)
    args.out.write_text(json.dumps(notebook, ensure_ascii=False, indent=1), encoding="utf-8")
    print("写出 %s（%d 格）" % (args.out, len(notebook["cells"])))


if __name__ == "__main__":
    main()
