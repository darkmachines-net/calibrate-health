/** @file Keep native provider SDKs and controls out of the browser auth bundle. */
import type { SocialAuthButtonsProps } from './SocialAuthButtons.types';

/** Browser sessions continue using the existing email/password flow. */
export function SocialAuthButtons(_props: SocialAuthButtonsProps) {
    return null;
}
