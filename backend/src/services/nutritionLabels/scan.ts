/** @file Validates uploaded label images and coordinates OCR, parsing, and actionable scan errors. */

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHttpError } from '../../routes/myFoodsUtils';
import { NUTRITION_LABEL_OCR_WORKER } from './ocr';
import { parseNutritionLabel } from './parser';

export const MAX_LABEL_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_LABEL_IMAGE_PIXELS = 25_000_000;
const MAX_OCR_DIMENSION = 2400;
const SCAN_TIMEOUT_MS = 45_000;
let scanActive = false;

type OcrResult = { text: string; confidence: number } | { error: 'invalid-image' | 'ocr-failed' };

/** Runs locally with bundled language data; photos and recognized text are never persisted. */
export async function scanNutritionLabel(image: Buffer, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (image.length === 0 || image.length > MAX_LABEL_IMAGE_BYTES) {
    throw createHttpError(413, 'Choose a label photo smaller than 8 MB.');
  }
  if (scanActive) throw createHttpError(503, 'The label scanner is busy. Try again shortly.');
  scanActive = true;
  let worker: Worker | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortScan: (() => void) | undefined;
  try {
    worker = new Worker(NUTRITION_LABEL_OCR_WORKER, {
      eval: true,
      workerData: {
        image,
        sharpPath: require.resolve('sharp'),
        tesseractPath: require.resolve('tesseract.js'),
        langPath: path.join(path.dirname(require.resolve('@tesseract.js-data/eng')), '4.0.0'),
        maxPixels: MAX_LABEL_IMAGE_PIXELS,
        maxDimension: MAX_OCR_DIMENSION
      }
    });
    const result = await new Promise<OcrResult>((resolve, reject) => {
      abortScan = () => reject(signal?.reason ?? new Error('Label scan cancelled.'));
      signal?.addEventListener('abort', abortScan, { once: true });
      if (signal?.aborted) abortScan();
      worker!.once('message', resolve);
      worker!.once('error', reject);
      worker!.once('exit', () => reject(createHttpError(500, 'Label scanning stopped. Try again.')));
      timer = setTimeout(() => reject(createHttpError(504,
        'Reading this label took too long. Try a clearer, tightly cropped photo.')), SCAN_TIMEOUT_MS);
    });
    if ('error' in result) {
      if (result.error === 'invalid-image') {
        throw createHttpError(400, 'Choose a valid JPEG, PNG, or WebP label photo under 25 megapixels.');
      }
      throw createHttpError(500, 'The label could not be read. Try another photo or enter the details manually.');
    }
    const draft = parseNutritionLabel(result.text);
    if (result.confidence < 70) draft.warnings.unshift('This photo was difficult to read. Check every value or try a clearer photo.');
    return draft;
  } finally {
    if (timer) clearTimeout(timer);
    if (abortScan) signal?.removeEventListener('abort', abortScan);
    try {
      await worker?.terminate();
    } finally {
      scanActive = false;
    }
  }
}
