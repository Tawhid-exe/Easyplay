import { jsonResponse, handleOptions } from "../../../src/cors.js";
import { handleStream } from "../../../src/cfStream.js";

export async function onRequestGet(context) {
  try {
    return await handleStream(context);
  } catch (err) {
    console.error(`[stream] handler error:`, err.message);
    return jsonResponse({ streams: [] });
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
