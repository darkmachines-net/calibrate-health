/** @file connections: Routes the connections category into the shared settings implementation. */

import { SettingsScreen } from './settings';

/** Routes the connections category into the shared settings implementation. */
export default function ConnectionsSettingsRoute() {
    return <SettingsScreen category="connections" />;
}
