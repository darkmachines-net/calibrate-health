/** @file server Switch: Confirm the candidate before mutating server-scoped credentials or persisted settings. */

import type { ServerConnectionResult } from '../config/server';

type ConfirmServerSwitchOptions = {
    candidate: string;
    currentServerUrl: string;
    testConnection: (candidate: string) => Promise<ServerConnectionResult>;
    clearCurrentSession: () => Promise<void>;
    persistServerUrl: (serverUrl: string) => Promise<void>;
};

type AuthenticateAgainstConfirmedServerOptions<T> = {
    candidate: string;
    confirmServer: (candidate: string) => Promise<ServerConnectionResult>;
    authenticate: (confirmedServerUrl: string) => Promise<T>;
};

/**
 * Confirm the candidate before mutating server-scoped credentials or persisted settings.
 *
 * This ordering is the safety invariant for switching away from a working self-hosted instance.
 */
export async function confirmServerSwitch(options: ConfirmServerSwitchOptions): Promise<ServerConnectionResult> {
    const connection = await options.testConnection(options.candidate);
    if (!connection.ok) return connection;

    if (connection.url !== options.currentServerUrl) {
        await options.clearCurrentSession();
    }
    await options.persistServerUrl(connection.url);
    return connection;
}

/**
 * Authenticate against the exact normalized origin that passed the server probe.
 *
 * React state updates do not refresh callbacks synchronously, so the credential
 * request must consume the confirmation result instead of a state-backed client.
 */
export async function authenticateAgainstConfirmedServer<T>(
    options: AuthenticateAgainstConfirmedServerOptions<T>
): Promise<T | null> {
    const connection = await options.confirmServer(options.candidate);
    if (!connection.ok) return null;

    return options.authenticate(connection.url);
}
