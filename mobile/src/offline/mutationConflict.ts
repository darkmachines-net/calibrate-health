/** @file mutation Conflict: Only bounded local validation messages may bypass generic action error copy. */

const messages = {
    pausedDay: 'Tracking changed to paused. Resume tracking or explicitly backfill this day before changing its status.',
    "failed": "Resolve the failed pause change in Review saved changes before trying again.",
    "active": "Tracking is already paused. Update or resume the saved pause before starting another.",
    "pending": "A resume is already saved. Synchronize or resolve it before changing the pause.",
    "inactive": "Tracking is already resumed. Refresh before changing the pause.",
    "duplicate": "This pause change is already saved. Wait for synchronization or use its existing recovery action.",
    "copy": "Synchronize saved changes before copying food."
} as const;

/** Only bounded local validation messages may bypass generic action error copy. */
export class OfflineMutationConflict extends Error {
    /** Creates a safe user-facing conflict error from the supported offline conflict reasons. */
    constructor(reason: keyof typeof messages) {
        super(messages[reason]);
        this.name = 'OfflineMutationConflict';
    }
}
