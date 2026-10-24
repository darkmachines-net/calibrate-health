/** @file security: Routes the security category into the shared settings implementation. */

import { SettingsScreen } from './settings';

/** Routes the security category into the shared settings implementation. */
export default function SecuritySettingsRoute() {
    return <SettingsScreen category="security" />;
}
