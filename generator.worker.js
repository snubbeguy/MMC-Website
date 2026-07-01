import { generateMask, renderDownload } from "./generator.shared.js";

self.addEventListener("message", async (event) => {
  const message = event.data;

  try {
    if (message.type === "preview") {
      const result = await generateMask({
        seed: message.seed,
        radius: message.radius,
        blocksPerPixel: message.blocksPerPixel,
        includeRaw: true,
        onProgress: (progressMessage) => {
          self.postMessage({ type: "progress", message: progressMessage });
        },
      });
      const transfers = [result.pixels.buffer];
      if (result.rawPixels) transfers.push(result.rawPixels.buffer);
      self.postMessage({
        type: "preview-result",
        width: result.width,
        height: result.height,
        blocksPerPixel: result.blocksPerPixel,
        durationMs: result.durationMs,
        pixels: result.pixels.buffer,
        rawPixels: result.rawPixels?.buffer,
      }, transfers);
      return;
    }

    if (message.type === "export") {
      const result = await renderDownload({
        seed: message.seed,
        radius: message.radius,
        blocksPerPixel: message.blocksPerPixel,
        format: message.format,
        source: message.source,
        onProgress: (progressMessage) => {
          self.postMessage({ type: "progress", message: progressMessage });
        },
      });
      const transfers = result.buffer ? [result.buffer] : [];
      self.postMessage({ type: "export-result", ...result }, transfers);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Something went wrong while generating the map.",
    });
  }
});
