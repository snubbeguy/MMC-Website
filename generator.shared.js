import * as ds from "https://esm.sh/deepslate@0.26.0/es2022/worldgen.bundle.mjs";
import {
  OVERWORLD_NOISE_SETTINGS,
  WORLDGEN_DENSITY_FUNCTIONS,
  WORLDGEN_NOISE,
} from "./data/vanilla-overworld-data.js";

const LAND_RGB = [255, 255, 255];
const WATER_COLORS = {
  deep: [0, 45, 120],
  cold: [88, 158, 214],
  regular: [0, 92, 255],
  warm: [0, 142, 168],
  swamp: [78, 132, 118],
};
const SEA_LEVEL = OVERWORLD_NOISE_SETTINGS.sea_level;

let worldgenRegistered = false;
let sharedSettings = null;
let cachedEngine = null;

export async function generateMask(options) {
  const startedAt = performance.now();
  const engine = getEngine(options.seed);
  const diameter = options.radius * 2 + 1;
  const width = Math.ceil(diameter / options.blocksPerPixel);
  const height = width;
  const pixels = new Uint8Array(width * height * 3);
  const rawPixels = options.includeRaw ? new Uint8Array(width * height * 3) : null;
  const coordinates = buildSampleCoordinates(width, options.radius, options.blocksPerPixel);
  const onProgress = options.onProgress || (() => {});

  onProgress("Sampling detailed biome and river data " + width.toLocaleString() + " x " + height.toLocaleString() + "...");

  for (let pixelY = 0; pixelY < height; pixelY += 1) {
    const sampleZ = coordinates[pixelY];
    let pixelOffset = pixelY * width * 3;

    for (let pixelX = 0; pixelX < width; pixelX += 1) {
      writePreviewPoint(engine, coordinates[pixelX], sampleZ, pixels, rawPixels, pixelOffset);
      pixelOffset += 3;
    }

    if (pixelY % 24 === 0) {
      await pause();
      const percent = Math.round(((pixelY + 1) / height) * 100);
      onProgress("Sampling detailed rivers and water... " + percent + "%");
    }
  }

  return {
    width,
    height,
    blocksPerPixel: options.blocksPerPixel,
    durationMs: performance.now() - startedAt,
    pixels,
    rawPixels,
  };
}

export async function renderDownload(options) {
  const startedAt = performance.now();
  const engine = getEngine(options.seed);
  const source = normalizeSource(options.source);
  const plan = createRenderPlan({ ...options, source });
  const fileBase = buildFilename(source, options.seed, options.radius, options.blocksPerPixel);
  const onProgress = options.onProgress || (() => {});

  if (options.format === "png") {
    onProgress("Streaming " + labelForSource(source) + " PNG rows...");
    const pngBytes = await encodeGeneratedPng(engine, plan, onProgress);
    return {
      filename: fileBase + ".png",
      mimeType: "image/png",
      buffer: pngBytes.buffer,
      durationMs: performance.now() - startedAt,
    };
  }

  onProgress("Painting " + labelForSource(source) + " JPEG canvas...");
  const jpegBlob = await encodeGeneratedJpeg(engine, plan, onProgress);
  return {
    filename: fileBase + ".jpg",
    mimeType: "image/jpeg",
    blob: jpegBlob,
    durationMs: performance.now() - startedAt,
  };
}

function ensureWorldgenRegistered() {
  if (worldgenRegistered) return;

  for (const [id, json] of Object.entries(WORLDGEN_NOISE)) {
    ds.WorldgenRegistries.NOISE.register(ds.Identifier.parse(id), ds.NoiseParameters.fromJson(json), true);
  }

  for (const [id, json] of Object.entries(WORLDGEN_DENSITY_FUNCTIONS)) {
    ds.WorldgenRegistries.DENSITY_FUNCTION.register(
      ds.Identifier.parse(id),
      ds.DensityFunction.fromJson(json),
      true,
    );
  }

  sharedSettings = ds.NoiseGeneratorSettings.create({
    noise: ds.NoiseSettings.fromJson(OVERWORLD_NOISE_SETTINGS.noise),
    surfaceRule: ds.SurfaceRule.NOOP,
    defaultBlock: ds.BlockState.fromJson(OVERWORLD_NOISE_SETTINGS.default_block),
    defaultFluid: ds.BlockState.fromJson(OVERWORLD_NOISE_SETTINGS.default_fluid),
    noiseRouter: ds.NoiseRouter.fromJson(OVERWORLD_NOISE_SETTINGS.noise_router),
    seaLevel: OVERWORLD_NOISE_SETTINGS.sea_level,
    disableMobGeneration: OVERWORLD_NOISE_SETTINGS.disable_mob_generation,
    aquifersEnabled: OVERWORLD_NOISE_SETTINGS.aquifers_enabled,
    oreVeinsEnabled: OVERWORLD_NOISE_SETTINGS.ore_veins_enabled,
    legacyRandomSource: OVERWORLD_NOISE_SETTINGS.legacy_random_source,
  });

  worldgenRegistered = true;
}

function getEngine(seedText) {
  ensureWorldgenRegistered();
  const seed = normalizeSeed(seedText);
  const seedKey = seed.toString();

  if (cachedEngine && cachedEngine.seedKey === seedKey) {
    return cachedEngine;
  }

  const randomState = new ds.RandomState(sharedSettings, seed);
  const climateContext = { x: 0, y: 0, z: 0 };
  const climateSample = {
    temperature: 0,
    vegetation: 0,
    continents: 0,
    erosion: 0,
    ridges: 0,
    surface: 0,
  };

  cachedEngine = {
    seed,
    seedKey,
    randomState,
    climateContext,
    climateSample,
    temperatureSampler: randomState.router.temperature,
    vegetationSampler: randomState.router.vegetation,
    continentsSampler: randomState.router.continents,
    erosionSampler: randomState.router.erosion,
    ridgesSampler: randomState.router.ridges,
    surfaceSampler: randomState.router.preliminarySurfaceLevel,
  };

  return cachedEngine;
}

function normalizeSeed(seedText) {
  const trimmed = String(seedText).trim();
  if (!trimmed) {
    throw new Error("Enter a Minecraft seed first.");
  }

  if (/^[+-]?\d+$/.test(trimmed)) {
    return BigInt.asIntN(64, BigInt(trimmed));
  }

  let hash = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash = ((hash * 31) + trimmed.charCodeAt(index)) | 0;
  }
  return BigInt.asIntN(64, BigInt(hash));
}

function writePreviewPoint(engine, blockX, blockZ, pixels, rawPixels, offset) {
  const climate = sampleClimate(engine, blockX, blockZ);
  const biome = biomeForClimate(climate);
  writeMaskColor(biome, climate, pixels, offset);

  if (rawPixels) {
    writeBiomeColor(biome, climate, rawPixels, offset);
  }
}

function sampleClimate(engine, blockX, blockZ) {
  const context = engine.climateContext;
  context.x = blockX;
  context.y = 0;
  context.z = blockZ;

  const sample = engine.climateSample;
  sample.temperature = engine.temperatureSampler.compute(context);
  sample.vegetation = engine.vegetationSampler.compute(context);
  sample.continents = engine.continentsSampler.compute(context);
  sample.erosion = engine.erosionSampler.compute(context);
  sample.ridges = engine.ridgesSampler.compute(context);
  sample.surface = engine.surfaceSampler.compute(context);
  return sample;
}

function biomeForClimate(climate) {
  const temperature = climate.temperature;
  const humidity = climate.vegetation;
  const continents = climate.continents;
  const erosion = climate.erosion;
  const ridges = climate.ridges;
  const surface = Number.isFinite(climate.surface) ? climate.surface : SEA_LEVEL;
  const valley = Math.abs(ridges) < 0.085;
  const high = ridges > 0.34 || surface > SEA_LEVEL + 42;

  if (continents < -1.05) return "mushroom_fields";

  if (continents < -0.455) {
    if (temperature < -0.45) return "deep_frozen_ocean";
    if (temperature < -0.15) return "deep_cold_ocean";
    if (temperature > 0.55) return "warm_ocean";
    if (temperature > 0.2) return "deep_lukewarm_ocean";
    return "deep_ocean";
  }

  if (continents < -0.19) {
    if (temperature < -0.45) return "frozen_ocean";
    if (temperature < -0.15) return "cold_ocean";
    if (temperature > 0.55) return "warm_ocean";
    if (temperature > 0.2) return "lukewarm_ocean";
    return "ocean";
  }

  if (valley && continents < 0.72 && erosion > -0.48) {
    return temperature < -0.45 ? "frozen_river" : "river";
  }

  if (continents < -0.105) {
    if (temperature < -0.45) return "snowy_beach";
    if (erosion < -0.42 || ridges > 0.36) return "stony_shore";
    return "beach";
  }

  if (high) {
    if (temperature < -0.45) return "snowy_slopes";
    if (temperature < -0.15) return "grove";
    if (humidity > 0.3) return "windswept_forest";
    return "windswept_hills";
  }

  if (temperature > 0.55 && humidity < -0.12) {
    return erosion < -0.4 ? "badlands" : "desert";
  }

  if (temperature > 0.55) {
    if (humidity > 0.35) return "jungle";
    if (humidity > 0.05) return "savanna";
    return "desert";
  }

  if (temperature > 0.2) {
    if (humidity > 0.42 && erosion > 0.05) return "swamp";
    if (humidity > 0.25) return "forest";
    if (humidity < -0.25) return "savanna";
    return "plains";
  }

  if (temperature > -0.15) {
    if (humidity > 0.3) return "birch_forest";
    if (humidity < -0.28) return "windswept_savanna";
    return "plains";
  }

  if (temperature > -0.45) {
    if (humidity > 0.25) return "taiga";
    return "old_growth_pine_taiga";
  }

  return humidity > 0.0 ? "snowy_taiga" : "snowy_plains";
}

function isWaterBiome(biome) {
  return biome.includes("ocean") || biome === "river" || biome === "frozen_river";
}

function isWaterPoint(biome, climate) {
  if (!Number.isFinite(climate.surface)) {
    return isWaterBiome(biome);
  }

  return climate.surface <= SEA_LEVEL;
}

function waterColorFor(biome) {
  if (biome.includes("frozen") || biome.includes("cold")) {
    return WATER_COLORS.cold;
  }

  if (biome.startsWith("deep_")) {
    return WATER_COLORS.deep;
  }

  if (biome.includes("warm")) {
    return WATER_COLORS.warm;
  }

  return WATER_COLORS.regular;
}

const DEFAULT_BIOME_COLOR = [104, 151, 82];
const BIOME_COLORS = {
  mushroom_fields: [132, 100, 143],
  beach: [218, 201, 142],
  snowy_beach: [232, 238, 226],
  stony_shore: [132, 132, 122],
  snowy_slopes: [225, 236, 239],
  grove: [124, 154, 142],
  windswept_forest: [82, 127, 82],
  windswept_hills: [126, 132, 116],
  badlands: [190, 112, 63],
  desert: [213, 183, 112],
  jungle: [42, 118, 48],
  savanna: [154, 172, 88],
  swamp: [76, 112, 75],
  forest: [54, 125, 63],
  birch_forest: [87, 144, 78],
  plains: [103, 158, 82],
  windswept_savanna: [137, 154, 84],
  taiga: [75, 126, 94],
  old_growth_pine_taiga: [66, 111, 82],
  snowy_taiga: [170, 190, 181],
  snowy_plains: [228, 235, 236],
};

function colorForBiome(biome, climate) {
  const color = [0, 0, 0];
  writeBiomeColor(biome, climate, color, 0);
  return color;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function buildFilename(source, seedText, radius, blocksPerPixel) {
  const safeSeed = String(seedText).trim().replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 48) || "seed";
  return "minecraft-" + source + "_" + safeSeed + "_r" + radius + "_s" + blocksPerPixel;
}

function buildSampleCoordinates(width, radius, blocksPerPixel) {
  const coordinates = new Int32Array(width);
  const halfStep = Math.floor(blocksPerPixel / 2);
  const minBlock = -radius;

  for (let index = 0; index < width; index += 1) {
    coordinates[index] = Math.min(radius, minBlock + index * blocksPerPixel + halfStep);
  }

  return coordinates;
}

function normalizeSource(source) {
  return source === "colored" ? "colored" : "uncolored";
}

function labelForSource(source) {
  return source === "colored" ? "Colored" : "Uncolored";
}

function createRenderPlan(options) {
  const diameter = options.radius * 2 + 1;
  return {
    radius: options.radius,
    blocksPerPixel: options.blocksPerPixel,
    width: Math.ceil(diameter / options.blocksPerPixel),
    height: Math.ceil(diameter / options.blocksPerPixel),
    halfStep: Math.floor(options.blocksPerPixel / 2),
    minBlock: -options.radius,
    source: normalizeSource(options.source),
  };
}

function writeColorAt(engine, blockX, blockZ, source, output, offset) {
  const climate = sampleClimate(engine, blockX, blockZ);
  const biome = biomeForClimate(climate);

  if (source === "colored") {
    writeBiomeColor(biome, climate, output, offset);
    return;
  }

  writeMaskColor(biome, climate, output, offset);
}

function writeMaskColor(biome, climate, output, offset) {
  if (!isWaterPoint(biome, climate)) {
    output[offset + 0] = LAND_RGB[0];
    output[offset + 1] = LAND_RGB[1];
    output[offset + 2] = LAND_RGB[2];
    return;
  }

  const color = waterColorFor(biome);
  output[offset + 0] = color[0];
  output[offset + 1] = color[1];
  output[offset + 2] = color[2];
}

function writeBiomeColor(biome, climate, output, offset) {
  if (isWaterPoint(biome, climate)) {
    const water = waterColorFor(biome);
    output[offset + 0] = water[0];
    output[offset + 1] = water[1];
    output[offset + 2] = water[2];
    return;
  }

  const base = BIOME_COLORS[biome] || DEFAULT_BIOME_COLOR;
  const surface = Number.isFinite(climate.surface) ? climate.surface : SEA_LEVEL;
  const relief = clamp((surface - SEA_LEVEL) / 110, -0.14, 0.22);
  const ridgeShade = clamp(climate.ridges * 0.08, -0.06, 0.09);
  const amount = relief + ridgeShade;
  output[offset + 0] = clamp(Math.round(base[0] * (1 + amount)), 0, 255);
  output[offset + 1] = clamp(Math.round(base[1] * (1 + amount)), 0, 255);
  output[offset + 2] = clamp(Math.round(base[2] * (1 + amount)), 0, 255);
}

async function encodeGeneratedPng(engine, plan, onProgress) {
  if (typeof CompressionStream === "undefined" || typeof TransformStream === "undefined") {
    throw new Error("Large PNG export needs CompressionStream and TransformStream support in this browser.");
  }

  const rowStride = plan.width * 3;
  const coordinates = buildSampleCoordinates(plan.width, plan.radius, plan.blocksPerPixel);
  const stream = new TransformStream();
  const compressedPromise = new Response(stream.readable.pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
  const writer = stream.writable.getWriter();
  const row = new Uint8Array(rowStride + 1);

  for (let y = 0; y < plan.height; y += 1) {
    row[0] = 0;

    const blockZ = coordinates[y];
    for (let x = 0; x < plan.width; x += 1) {
      writeColorAt(engine, coordinates[x], blockZ, plan.source, row, 1 + x * 3);
    }

    await writer.write(row.slice());

    if (y % 16 === 0) {
      const percent = Math.round(((y + 1) / plan.height) * 100);
      onProgress("Streaming " + labelForSource(plan.source) + " PNG rows... " + percent + "%");
      await pause();
    }
  }

  await writer.close();
  onProgress("Finalizing PNG...");
  const compressed = new Uint8Array(await compressedPromise);
  return assemblePng(plan.width, plan.height, compressed);
}

async function encodeGeneratedJpeg(engine, plan, onProgress) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("JPEG export needs OffscreenCanvas support in this browser. Use PNG instead.");
  }

  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const context = canvas.getContext("2d");
  const coordinates = buildSampleCoordinates(plan.width, plan.radius, plan.blocksPerPixel);
  const chunkHeight = Math.max(1, Math.min(64, plan.height));

  for (let yStart = 0; yStart < plan.height; yStart += chunkHeight) {
    const rows = Math.min(chunkHeight, plan.height - yStart);
    const image = context.createImageData(plan.width, rows);
    const data = image.data;

    for (let localY = 0; localY < rows; localY += 1) {
      const pixelY = yStart + localY;
      const blockZ = coordinates[pixelY];
      for (let x = 0; x < plan.width; x += 1) {
        const offset = (localY * plan.width + x) * 4;
        writeColorAt(engine, coordinates[x], blockZ, plan.source, data, offset);
        data[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, yStart);

    const percent = Math.round(((yStart + rows) / plan.height) * 100);
    onProgress("Painting " + labelForSource(plan.source) + " JPEG canvas... " + percent + "%");
    await pause();
  }

  onProgress("Encoding JPEG...");
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

function assemblePng(width, height, compressed) {
  const chunks = [
    pngSignature(),
    pngChunk("IHDR", buildIhdr(width, height)),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

async function encodeJpeg(pixels, width, height) {
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("JPEG export needs OffscreenCanvas support in this browser. Use PNG instead.");
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  const rgba = image.data;

  for (let index = 0; index < pixels.length / 3; index += 1) {
    const source = index * 3;
    const base = index * 4;
    rgba[base + 0] = pixels[source + 0];
    rgba[base + 1] = pixels[source + 1];
    rgba[base + 2] = pixels[source + 2];
    rgba[base + 3] = 255;
  }

  context.putImageData(image, 0, 0);
  return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

async function encodeRgbPng(pixels, width, height) {
  if (typeof CompressionStream === "undefined") {
    throw new Error("PNG export needs CompressionStream support in this browser.");
  }

  const rowStride = width * 3;
  const raw = new Uint8Array((rowStride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (rowStride + 1);
    raw[rowOffset] = 0;
    raw.set(pixels.subarray(y * rowStride, (y + 1) * rowStride), rowOffset + 1);

    if (y % 256 === 0) {
      await pause();
    }
  }

  const compressed = new Uint8Array(await compressDeflate(raw));
  const chunks = [
    pngSignature(),
    pngChunk("IHDR", buildIhdr(width, height)),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ];

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

async function compressDeflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return await new Response(stream).arrayBuffer();
}

function pngSignature() {
  return Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
}

function buildIhdr(width, height) {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = 8;
  data[9] = 2;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return data;
}

function pngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const output = new Uint8Array(12 + data.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  view.setUint32(output.length - 4, crc32(output.subarray(4, output.length - 4)));
  return output;
}

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pause() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
