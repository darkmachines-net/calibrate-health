/** @file confirm Discard Changes: Cross-platform confirmation shared by dismissible editing overlays. */

import { confirmAction } from './confirmAction';

const DISCARD_TITLE = 'Discard changes?';
const DISCARD_MESSAGE = 'Your unsaved changes will be lost.';

/** Cross-platform confirmation shared by dismissible editing overlays. */
export function confirmDiscardChanges(): Promise<boolean> {
    return confirmAction({
        title: DISCARD_TITLE,
        message: DISCARD_MESSAGE,
        cancelLabel: 'Keep editing',
        confirmLabel: 'Discard',
        destructive: true
    });
}