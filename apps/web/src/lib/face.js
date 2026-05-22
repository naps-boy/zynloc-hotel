// Face verification wrapper using @vladmandic/face-api
// Models are loaded from jsdelivr CDN on first use.

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.13/model";
let faceapi = null;
let modelsLoaded = false;

async function getFaceApi() {
  if (!faceapi) {
    faceapi = await import("@vladmandic/face-api");
  }
  return faceapi;
}

export async function loadFaceModels(onProgress) {
  if (modelsLoaded) return;
  const fa = await getFaceApi();
  onProgress?.("Loading face detection model…");
  await fa.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
  onProgress?.("Loading landmark model…");
  await fa.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
  onProgress?.("Loading recognition model…");
  await fa.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
  modelsLoaded = true;
}

/**
 * Extract a 128-float face descriptor from an HTMLImageElement or HTMLVideoElement.
 * Returns Float32Array or null if no face detected.
 */
export async function extractDescriptor(element) {
  const fa = await getFaceApi();
  const detection = await fa
    .detectSingleFace(element, new fa.SsdMobilenetv1Options({ minConfidence: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  return detection?.descriptor ?? null;
}

/**
 * Extract descriptor from a base64 data-URL string.
 */
export async function extractDescriptorFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = async () => resolve(await extractDescriptor(img));
    img.onerror = reject;
    img.src     = dataUrl;
  });
}

/**
 * Compare two descriptors (Float32Array or plain number[]).
 * Returns { distance, verified } where verified = distance < 0.6
 */
export function compareDescriptors(a, b) {
  const fa32 = new Float32Array(a);
  const fb32 = new Float32Array(b);
  let sum = 0;
  for (let i = 0; i < fa32.length; i++) sum += (fa32[i] - fb32[i]) ** 2;
  const distance = Math.sqrt(sum);
  return { distance: Math.round(distance * 1000) / 1000, verified: distance < 0.6 };
}
