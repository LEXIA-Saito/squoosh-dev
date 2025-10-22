import WorkerBridge from '../worker-bridge';
import {
  encoderMap,
  defaultPreprocessorState,
  defaultProcessorState,
  type EncoderType,
  type EncoderOptions,
  type EncoderState,
  type ProcessorState,
  type PreprocessorState,
} from '../feature-meta';
import {
  blobToText,
  sniffMimeType,
  canDecodeImageType,
  builtinDecode,
  abortable,
  assertSignal,
  type ImageMimeTypes,
} from '../util';
import { drawableToImageData } from '../util/canvas';
import { resize } from 'features/processors/resize/client';

export interface ConvertOptions {
  encoder: EncoderType; // 例: 'mozJPEG' | 'webP' など
  encoderOptions?: EncoderOptions; // 未指定ならデフォルト
  preprocessorState?: PreprocessorState; // 回転など
  processorState?: ProcessorState; // リサイズ・量子化など
}

export interface ConvertResult {
  input: File;
  output: File; // 変換後ファイル
  processed?: ImageData; // エンコード直前の画素（UIでのプレビューに利用可）
}

async function decodeImage(
  signal: AbortSignal,
  blob: Blob,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  const mimeType = await abortable(signal, sniffMimeType(blob));
  const canDecode = await abortable(signal, canDecodeImageType(mimeType));

  try {
    if (!canDecode) {
      if (mimeType === 'image/avif') {
        return await workerBridge.avifDecode(signal, blob);
      }
      if (mimeType === 'image/webp') {
        return await workerBridge.webpDecode(signal, blob);
      }
      if (mimeType === 'image/jxl') {
        return await workerBridge.jxlDecode(signal, blob);
      }
      if (mimeType === 'image/webp2') {
        return await workerBridge.wp2Decode(signal, blob);
      }
      if (mimeType === 'image/qoi') {
        return await workerBridge.qoiDecode(signal, blob);
      }
    }
    // それ以外はブラウザ組み込みにフォールバック
    return await builtinDecode(signal, blob);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw Error("Couldn't decode image");
  }
}

async function preprocessImage(
  signal: AbortSignal,
  data: ImageData,
  preprocessorState: PreprocessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let processedData = data;
  if (preprocessorState.rotate.rotate !== 0) {
    processedData = await workerBridge.rotate(
      signal,
      processedData,
      preprocessorState.rotate,
    );
  }
  return processedData;
}

async function processImage(
  signal: AbortSignal,
  source: { preprocessed: ImageData; decoded: ImageData },
  processorState: ProcessorState,
  workerBridge: WorkerBridge,
): Promise<ImageData> {
  assertSignal(signal);
  let result = source.preprocessed;
  if (processorState.resize.enabled) {
    result = await resize(signal, { preprocessed: result, decoded: source.decoded } as any, processorState.resize, workerBridge);
  }
  if (processorState.quantize.enabled) {
    result = await workerBridge.quantize(signal, result, processorState.quantize);
  }
  return result;
}

async function encodeImage(
  signal: AbortSignal,
  image: ImageData,
  encodeData: EncoderState,
  sourceFilename: string,
  workerBridge: WorkerBridge,
): Promise<File> {
  assertSignal(signal);
  const encoder = encoderMap[encodeData.type];
  const compressedData = await encoder.encode(
    signal,
    workerBridge,
    image,
    encodeData.options as any,
  );
  const type: ImageMimeTypes = encoder.meta.mimeType;
  const filename = sourceFilename.replace(/\.[^.]*$/, `.${encoder.meta.extension}`);
  return new File([compressedData], filename, { type });
}

export async function convertFile(
  file: File,
  opts: ConvertOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<ConvertResult> {
  const worker = new WorkerBridge();
  const encoderState: EncoderState = {
    type: opts.encoder,
    options: (opts.encoderOptions ?? encoderMap[opts.encoder].meta.defaultOptions) as any,
  };
  const preState = opts.preprocessorState ?? defaultPreprocessorState;
  const procState = opts.processorState ?? defaultProcessorState;

  const decoded = await decodeImage(signal, file, worker);
  const preprocessed = await preprocessImage(signal, decoded, preState, worker);
  const processed = await processImage(
    signal,
    { preprocessed, decoded },
    procState,
    worker,
  );
  const output = await encodeImage(signal, processed, encoderState, file.name, worker);
  return { input: file, output, processed };
}

export interface BatchOptions extends ConvertOptions {
  concurrency?: number; // 既定: 2
  onProgress?: (done: number, total: number) => void;
}

export async function convertFiles(
  files: File[],
  opts: BatchOptions,
  signal: AbortSignal = new AbortController().signal,
): Promise<ConvertResult[]> {
  const total = files.length;
  const results: ConvertResult[] = [];
  const conc = Math.max(1, Math.min(opts.concurrency ?? 2, 8));
  let done = 0;

  const queue = files.map((f, i) => i);

  const run = async () => {
    while (queue.length) {
      const idx = queue.shift()!;
      const file = files[idx];
      try {
        const res = await convertFile(file, opts, signal);
        results[idx] = res;
      } finally {
        done += 1;
        opts.onProgress?.(done, total);
      }
    }
  };

  const workers = Array.from({ length: Math.min(conc, total) }, () => run());
  await Promise.all(workers);
  return results;
}
