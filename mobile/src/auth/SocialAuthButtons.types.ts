/** @file Shared presentation contract; web renders no native provider controls. */
import type { SocialAuthProvider } from '@calibrate/shared/socialAuth';

export type SocialAuthButtonsProps = {
    serverUrl: string;
    disabled: boolean;
    label?: string;
    onPress: (provider: SocialAuthProvider) => void;
};
