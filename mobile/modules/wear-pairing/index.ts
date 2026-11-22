/** @file Typed Expo native-module boundary for Wear discovery, pairing messages, and phone/watch coordination. */

import { requireOptionalNativeModule } from 'expo-modules-core';

export type WearNode = {
    id: string;
    displayName: string;
    isNearby: boolean;
};

export type WearPairingMessage = {
    id: string;
    nodeId: string;
    path: string;
    payload: string;
    receivedAt: number;
};

type CalibrateWearPairingModule = {
    /** Discover reachable watch nodes advertising the Calibrate pairing capability. */
    getPairingNodes(): Promise<WearNode[]>;
    /** Send a bounded message on an allowed path and return the Data Layer request ID. */
    sendMessage(nodeId: string, path: string, payload: string): Promise<number>;
    /** Authorize only the pairing exchange for this node and origin until the supplied expiry. */
    prepareNetworkRelay(nodeId: string, serverOrigin: string, requestId: string, expiresAtEpochMs: number): void;
    /** Activate relay access for a completed pairing, requiring a matching pending or already active binding. */
    commitNetworkRelay(nodeId: string, serverOrigin: string, requestId: string): void;
    /** Restore relay access from a pairing retained before the native relay was introduced. */
    restoreNetworkRelay(nodeId: string, serverOrigin: string): void;
    /** Remove the pending authorization only if its node, origin, and request match. */
    clearPendingNetworkRelay(nodeId: string, serverOrigin: string, requestId: string): void;
    /** Remove the active authorization only for the matching node and origin. */
    clearNetworkRelay(nodeId: string, serverOrigin: string): void;
    /** Read retained inbound messages without removing them. */
    listMessages(): WearPairingMessage[];
    /** Remove processed messages from the native inbox by their retained IDs. */
    acknowledgeMessages(messageIds: string[]): void;
};

export default requireOptionalNativeModule<CalibrateWearPairingModule>('CalibrateWearPairing');
