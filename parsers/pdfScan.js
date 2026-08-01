const fs = require('fs');
const { createCanvas } = require('@napi-rs/canvas');
const { createWorker } = require('tesseract.js');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.mjs');

class NodeCanvasFactory {
  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }
  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }
  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function pdfToText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const doc = await pdfjsLib.getDocument({ data, canvasFactory: new NodeCanvasFactory() }).promise;

  const worker = await createWorker('eng');
  let fullText = '';

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvasFactory = new NodeCanvasFactory();
      const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);

      await page.render({
        canvasContext: canvasAndContext.context,
        viewport,
        canvasFactory,
      }).promise;

      const buffer = canvasAndContext.canvas.toBuffer('image/png');
      const { data: ocrData } = await worker.recognize(buffer);
      fullText += ocrData.text + '\n';
    }
  } finally {
    await worker.terminate();
  }

  return fullText;
}

module.exports = { pdfToText };
