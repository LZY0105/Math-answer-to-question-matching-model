package com.answermatcher.ocr;

import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.file.Files;
import javax.imageio.ImageIO;

/**
 * 桌面对拍用：读 PNG，按 FormulaImagePreprocessor 处理，写出小端 float32 张量（与 recognize_scratch.py
 * --save-tensor 同格式）。只用于和 Python 的预处理逐字节比对（verify_preprocess.py），应用里不需要它。
 *
 * 用法：FormulaPreprocessCli HEIGHT WIDTH IN1.png OUT1.f32 [IN2.png OUT2.f32 ...]
 * 只认 RGB / RGBA 的 PNG：灰度 PNG 经 getRGB 会被做一次色彩空间换算，结果与 Pillow 不同。
 */
public final class FormulaPreprocessCli {
    private FormulaPreprocessCli() {}

    public static void main(String[] args) throws Exception {
        if (args.length < 4 || args.length % 2 != 0) {
            throw new IllegalArgumentException("Usage: FormulaPreprocessCli HEIGHT WIDTH IN.png OUT.f32 [...]");
        }
        int height = Integer.parseInt(args[0]);
        int width = Integer.parseInt(args[1]);
        int blank = 0;
        for (int i = 2; i < args.length; i += 2) {
            BufferedImage image = ImageIO.read(new File(args[i]));
            int type = image.getType();
            if (type != BufferedImage.TYPE_4BYTE_ABGR && type != BufferedImage.TYPE_3BYTE_BGR
                    && type != BufferedImage.TYPE_INT_ARGB && type != BufferedImage.TYPE_INT_RGB) {
                throw new IllegalArgumentException("Expected an RGB or RGBA PNG: " + args[i] + " (type " + type + ")");
            }
            int[] argb = image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth());
            float[] tensor;
            try {
                tensor = FormulaImagePreprocessor.preprocess(argb, image.getWidth(), image.getHeight(), height, width);
            } catch (FormulaImagePreprocessor.BlankImageException empty) {
                blank++;
                continue;
            }
            ByteBuffer bytes = ByteBuffer.allocate(tensor.length * Float.BYTES).order(ByteOrder.LITTLE_ENDIAN);
            bytes.asFloatBuffer().put(tensor);
            Files.write(new File(args[i + 1]).toPath(), bytes.array());
        }
        System.out.println("{\"images\":" + (args.length - 2) / 2 + ",\"blank\":" + blank + "}");
    }
}
