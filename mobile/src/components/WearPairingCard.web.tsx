/** @file Wear Pairing Card: The phone-to-Wear bridge is native-only; keep shared Settings routes safe on web. */

import { AppSection } from './AppSection';
import { SectionHeader } from './SectionHeader';

/** The phone-to-Wear bridge is native-only; keep shared Settings routes safe on web. */
export function WearPairingCard() {
    return (
        <AppSection>
            <SectionHeader
                title="Wear OS"
                description="Pair and manage a Calibrate watch from the Android app."
            />
        </AppSection>
    );
}
