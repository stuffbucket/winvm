export function rejectLikeTauri(payload: unknown): Promise<never> {
  // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Tauri invoke and the CLI sidecar reject with a bare string or a plain serialized object, never an Error, and the code under test parses exactly that
  return Promise.reject(payload)
}
