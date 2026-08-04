import { jsonResponse, handleOptions } from "../../../../src/cors.js";
import { handleStream } from "../../../../src/cfStream.js";

export async function onRequestGet(context) {
  try {
    return await handleStream(context, context.params.config);
  } catch (err) {
    console.error(`[stream] config-prefixed handler error:`, err.message);
    return jsonResponse({ streams: [] });
  }
}

export async function onRequestOptions() {
  return handleOptions();
}
