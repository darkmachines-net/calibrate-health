/** @file Wear Pairing Card: Phone-owned discovery and one-time credential relay for the signed Calibrate watch app. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import type { WearNode } from '@calibrate/wear-pairing';
import { useAuth } from '../auth/AuthContext';
import {
    getWearPairingErrorMessage,
    getReachableWearNodes,
    processWearPairingInbox,
    readStoredWearPairing,
    startWearPairing,
    type StoredWearPairing
} from '../wear/pairing';
import { pollWearPairingInbox, type WearPairingInboxCheck } from '../wear/pairingPoll';
import { spacing, useAppTheme, type AppTheme } from '../theme';
import { AppButton } from './AppButton';
import { AppSection } from './AppSection';
import { AppText } from './AppText';
import { SectionHeader } from './SectionHeader';

/** Phone-owned discovery and one-time credential relay for the signed Calibrate watch app. */
export function WearPairingCard() {
    const theme = useAppTheme();
    const styles = useMemo(() => createStyles(theme), [theme]);
    const { api, serverUrl, user } = useAuth();
    const [nodes, setNodes] = useState<WearNode[]>([]);
    const [pairing, setPairing] = useState<StoredWearPairing | null>(null);
    const [isChecking, setIsChecking] = useState(false);
    const [status, setStatus] = useState('Open Calibrate on your watch, then check for its pairing request.');
    const scope = `${serverUrl}|${user?.id ?? 'signed-out'}`;
    const activeScope = useRef(scope);
    const activeCheck = useRef<object | null>(null);

    useEffect(() => {
        let active = true;
        activeScope.current = scope;
        activeCheck.current = null;
        setPairing(null);
        setNodes([]);
        setIsChecking(false);
        setStatus('Open Calibrate on your watch, then check for its pairing request.');
        if (user) {
            void readStoredWearPairing(serverUrl, user.id).then((stored) => {
                if (!active) return;
                setPairing(stored);
                if (stored) setStatus('Galaxy Watch pairing complete.');
            });
        }
        return () => {
            active = false;
            activeCheck.current = null;
        };
    }, [scope, serverUrl, user]);

    async function checkForWatch() {
        if (!user || activeCheck.current) return;
        const checkedScope = scope;
        const check = {};
        activeCheck.current = check;
        const isActive = () => activeScope.current === checkedScope && activeCheck.current === check;
        setIsChecking(true);
        try {
            const reachable = await getReachableWearNodes();
            if (!isActive()) return;
            setNodes(reachable);
            const processInbox = () => processWearPairingInbox({
                api,
                serverOrigin: serverUrl,
                userId: user.id
            });
            const initialResult = await processInbox();
            if (!isActive()) return;
            if (initialResult.paired) {
                setPairing(initialResult.paired);
                setStatus('Galaxy Watch pairing complete.');
                return;
            }
            if (initialResult.errors.length > 0) {
                setStatus(initialResult.errors[0]);
                return;
            }
            if (initialResult.processed > 0) {
                setStatus('Pairing securely with your watch...');
            } else if (reachable.length > 0) {
                const node = reachable.find(({ isNearby }) => isNearby) ?? reachable[0];
                await startWearPairing({ node, serverOrigin: serverUrl, userId: user.id });
                if (!isActive()) return;
                setStatus(`Pairing request sent to ${node.displayName || 'your watch'}. Keep Calibrate open there.`);
            } else {
                setStatus('No compatible reachable Calibrate watch app was found.');
                return;
            }

            const updateProgress = (result: WearPairingInboxCheck) => {
                if (isActive() && result.processed > 0 && !result.paired && result.errors.length === 0) {
                    setStatus('Pairing securely with your watch...');
                }
            };
            const result = await pollWearPairingInbox({
                processInbox,
                isActive,
                onProgress: updateProgress
            });
            if (!isActive() || result.cancelled) return;
            if (result.paired) {
                setPairing(result.paired);
                setStatus('Galaxy Watch pairing complete.');
            } else if (result.errors.length > 0) {
                setStatus(result.errors[0]);
            } else if (result.timedOut) {
                setStatus('The watch did not finish pairing. Keep Calibrate open on both devices and try again.');
            }
        } catch (error) {
            if (isActive()) {
                setStatus(getWearPairingErrorMessage(error));
            }
        } finally {
            if (activeCheck.current === check) {
                activeCheck.current = null;
                if (activeScope.current === checkedScope) setIsChecking(false);
            }
        }
    }

    const content = (
        <>
            <SectionHeader
                title="Galaxy Watch"
                description="Pair the signed Wear OS companion without copying your phone session or password."
            />
            <View accessibilityLiveRegion="polite" style={styles.statusPanel}>
                <AppText style={styles.status}>{status}</AppText>
                <AppText variant="caption">
                    Selected server: {serverUrl}. Changing the phone server never retargets an already-paired watch.
                </AppText>
            </View>
            {pairing && (
                <AppText variant="caption">
                    Paired {pairing.watchDeviceName ?? pairing.watchDeviceId} to {pairing.serverOrigin}.
                </AppText>
            )}
            {nodes.map((node) => (
                <AppText key={node.id} variant="caption">
                    {node.displayName || 'Wear OS watch'} | {node.isNearby ? 'nearby' : 'reachable'}
                </AppText>
            ))}
            <AppButton
                title={isChecking ? 'Checking...' : 'Check for watch'}
                disabled={isChecking}
                onPress={() => void checkForWatch()}
            />
        </>
    );

    return <AppSection>{content}</AppSection>;
}

const createStyles = (theme: AppTheme) => StyleSheet.create({
    statusPanel: {
        gap: spacing.xs,
        padding: spacing.md,
        borderLeftWidth: theme.interaction.focusRingWidth,
        borderLeftColor: theme.colors.primary,
        backgroundColor: theme.colors.summaryContainer
    },
    status: {
        color: theme.colors.onSurface,
        fontWeight: '600'
    }
});
