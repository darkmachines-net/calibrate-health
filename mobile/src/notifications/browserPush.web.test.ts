/** @file Regression coverage for browser Push web: browser push session cleanup logging. */

import {
    cleanupBrowserPushBeforeSessionChange,
    registerBrowserPushSessionCleanup
} from './browserPush.web';

describe('browser push session cleanup logging', () => {
    it('continues cleanup without logging an exception that may contain an endpoint', async () => {
        const sensitiveEndpoint = 'https://push.example/old?account=person@example.com';
        const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const unregister = registerBrowserPushSessionCleanup(async () => {
            throw new Error(`Unable to remove ${sensitiveEndpoint}`);
        });

        await expect(cleanupBrowserPushBeforeSessionChange()).resolves.toBeUndefined();

        expect(consoleWarn).toHaveBeenCalledWith(
            'Could not remove the browser push endpoint from the previous Calibrate session.'
        );
        expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain(sensitiveEndpoint);

        unregister();
        consoleWarn.mockRestore();
    });
});
