/** @file Isolated image preprocessing and local Tesseract OCR worker using bundled language data. */

// Isolate decoding and OCR initialization so the deadline can terminate all work, including failed startup.
export const NUTRITION_LABEL_OCR_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const sharp = require(workerData.sharpPath);
const { createWorker, OEM } = require(workerData.tesseractPath);
(async () => {
  let prepared;
  try {
    const source = sharp(Buffer.from(workerData.image), { limitInputPixels: workerData.maxPixels });
    const metadata = await source.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format) || (metadata.pages || 1) !== 1) {
      throw new Error('Unsupported image');
    }
    prepared = await source.rotate().resize({
      width: workerData.maxDimension, height: workerData.maxDimension, fit: 'inside', withoutEnlargement: true
    }).flatten({ background: '#ffffff' }).greyscale().normalize().png().toBuffer();
  } catch {
    parentPort.postMessage({ error: 'invalid-image' });
    return;
  }
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    langPath: workerData.langPath,
    gzip: true,
    cacheMethod: 'none',
    errorHandler: () => parentPort.postMessage({ error: 'ocr-failed' })
  });
  try {
    const { data } = await worker.recognize(prepared);
    parentPort.postMessage({ text: data.text, confidence: data.confidence });
  } finally {
    await worker.terminate();
  }
})().catch(() => parentPort.postMessage({ error: 'ocr-failed' }));
`;
