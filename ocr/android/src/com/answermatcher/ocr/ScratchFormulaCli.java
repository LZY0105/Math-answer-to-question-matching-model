package com.answermatcher.ocr;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.file.Files;

/** Desktop smoke-test entry point. This class is not required in an Android application. */
public final class ScratchFormulaCli {
    private static String jsonString(String value) {
        StringBuilder output = new StringBuilder("\"");
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\': output.append("\\\\"); break;
                case '"': output.append("\\\""); break;
                case '\n': output.append("\\n"); break;
                case '\r': output.append("\\r"); break;
                case '\t': output.append("\\t"); break;
                default:
                    if (c < 32) output.append(String.format("\\u%04x", (int) c));
                    else output.append(c);
            }
        }
        return output.append('"').toString();
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || args.length > 4) {
            throw new IllegalArgumentException("Usage: ScratchFormulaCli BUNDLE INPUT.f32 [MAX_TOKENS] [THREADS]");
        }
        int threads = args.length == 4 ? Integer.parseInt(args[3]) : 2;
        byte[] bytes = Files.readAllBytes(new File(args[1]).toPath());
        if (bytes.length % Float.BYTES != 0) throw new IllegalArgumentException("Invalid float32 input size");
        FloatBuffer input = ByteBuffer.allocateDirect(bytes.length).order(ByteOrder.nativeOrder()).asFloatBuffer();
        FloatBuffer littleEndian = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer();
        input.put(littleEndian).flip();
        try (ScratchFormulaRecognizer recognizer = new ScratchFormulaRecognizer(new File(args[0]), threads)) {
            ScratchFormulaRecognizer.Prediction prediction = recognizer.recognize(
                input, args.length >= 3 ? Integer.parseInt(args[2]) : recognizer.maximumOutputTokens());
            System.out.println("{\"latex\":" + jsonString(prediction.latex)
                + ",\"tokenIds\":" + prediction.tokenIds
                + ",\"endedWithEos\":" + prediction.endedWithEos
                + ",\"meanLogProbability\":" + prediction.meanLogProbability
                + ",\"modelTrainingStatus\":" + jsonString(prediction.modelTrainingStatus)
                + ",\"reviewRequired\":true,\"reasonCodes\":["
                + prediction.reasonCodes.stream().map(ScratchFormulaCli::jsonString)
                    .collect(java.util.stream.Collectors.joining(",")) + "]}");
            if (!prediction.endedWithEos || prediction.latex.isEmpty()) {
                recognizer.close();
                System.exit(2);
            }
        }
    }
}
