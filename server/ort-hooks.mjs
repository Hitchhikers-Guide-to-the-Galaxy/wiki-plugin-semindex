export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'onnxruntime-node') {
    return nextResolve(new URL('./ort-shim.mjs', import.meta.url).href, context)
  }
  return nextResolve(specifier, context)
}
