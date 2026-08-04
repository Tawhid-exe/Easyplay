import { jsonResponse, handleOptions } from "../../src/cors.js";
import addonInterface from "../../src/addon.js";
import { logRequest } from "../../src/cfStream.js";

export async function onRequestGet(context) {
  logRequest(context, { handledBy: "manifest" });
  return jsonResponse(addonInterface.manifest);
}

export async function onRequestOptions() {
  return handleOptions();
}
