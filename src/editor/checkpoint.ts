/**
 * Turn checkpoint sink. A mutating file tool must record a file's pre-mutation
 * state BEFORE it changes it, so the whole turn can be reverted. Instead of the
 * agent loop sniffing tool names to decide what to capture (fragile — every new
 * mutation tool has to be added to that list), the tools themselves announce
 * their mutations here. The provider registers a recorder for the active turn;
 * any tool that calls recordPreMutation() is captured, whatever its name.
 */

export type PreMutationRecorder = (relPath: string) => Promise<void>;

let recorder: PreMutationRecorder | undefined;

/** Register (or clear, with undefined) the recorder for the current turn. */
export function setPreMutationRecorder(r: PreMutationRecorder | undefined): void {
  recorder = r;
}

/**
 * Record a file's pre-mutation state via the active recorder. Best-effort: a
 * failure here must never block the mutation itself (the checkpoint is a safety
 * net, not a gate). No-op when no turn is active.
 */
export async function recordPreMutation(relPath: string): Promise<void> {
  if (!recorder || !relPath) { return; }
  try {
    await recorder(relPath);
  } catch {
    /* checkpoint capture is best-effort */
  }
}
