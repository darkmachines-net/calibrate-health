/** @file help: Routes the help category into the shared settings implementation. */

import { SettingsScreen } from './settings';

/** Routes the help category into the shared settings implementation. */
export default function HelpSettingsRoute() {
    return <SettingsScreen category="help" />;
}
