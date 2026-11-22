/** @file Shared presentation contract; web renders no native provider controls. */
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';
import type { ReactNode } from 'react';

export type SocialAuthButtonsProps = {
    serverUrl: string;
    disabled: boolean;
    label?: string;
    /** Optional separator rendered only when at least one provider is visible. */
    children?: ReactNode;
    onPress: (provider: SocialAuthProvider) => void;
};
