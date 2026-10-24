/** @file readiness: Keep readiness responses non-sensitive while distinguishing DB loss from process liveness. */

export type ReadinessProbe = () => Promise<unknown>;

/** Keep readiness responses non-sensitive while distinguishing DB loss from process liveness. */
export async function checkDatabaseReadiness(probe: ReadinessProbe): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch {
    return false;
  }
}
