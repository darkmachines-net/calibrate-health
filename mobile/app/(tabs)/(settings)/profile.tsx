/** @file profile: Routes the profile category into the shared settings implementation. */

import { SettingsScreen } from './settings';

/** Routes the profile category into the shared settings implementation. */
export default function ProfileSettingsRoute() {
    return <SettingsScreen category="profile" />;
}
