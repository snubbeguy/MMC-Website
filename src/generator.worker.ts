import { generateMask, renderDownload } from "./generator.shared";

interface PreviewMessage {
  type: "preview";
  seed: string;
  radius: number;
  blocksPerPixel: number;
}

interface ExportMessage {
  type: "export";
  seed: string;
  radius: number;
  blocksPerPixel: number;
  format: string;
  source: string;
}

type WorkerMessage = PreviewMessage | ExportMessage;

self.addEventListener("message", async (event: MessageEvent<WorkerMessage>) => {
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
      const transfers: ArrayBuffer[] = [result.pixels.buffer as ArrayBuffer];
      if (result.rawPixels) transfers.push(result.rawPixels.buffer as ArrayBuffer);
      self.postMessage({
        type: "preview-result",
        width: result.width,
        height: result.height,
        blocksPerPixel: result.blocksPerPixel,
        durationMs: result.durationMs,
        pixels: result.pixels.buffer,
        rawPixels: result.rawPixels?.buffer,
      }, transfers as any);
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
      const transfers: ArrayBuffer[] = result.buffer ? [result.buffer] : [];
      self.postMessage({ type: "export-result", ...result }, transfers as any);
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Something went wrong while generating the map.",
    });
  }
});
