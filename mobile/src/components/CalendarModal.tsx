/** @file Calendar Modal: Native calendar presentation keeps the app's standard animated bottom sheet. */

import React from 'react';
import { BottomSheetModal } from './BottomSheetModal';

export type CalendarModalProps = {
    visible: boolean;
    onRequestClose: () => void;
    children: React.ReactNode;
};

/** Native calendar presentation keeps the app's standard animated bottom sheet. */
export const CalendarModal: React.FC<CalendarModalProps> = ({
    visible,
    onRequestClose,
    children
}) => (
    <BottomSheetModal visible={visible} onRequestClose={onRequestClose} maxHeight="94%">
        {children}
    </BottomSheetModal>
);
