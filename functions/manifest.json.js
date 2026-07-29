import { jsonResponse, handleOptions } from "../src/cors.js";
import addonInterface from "../src/addon.js";

export async function onRequestGet() {
  return jsonResponse(addonInterface.manifest);
}

export async function onRequestOptions() {
  return handleOptions();
}
