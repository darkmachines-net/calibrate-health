/** @file Barcode Camera: Mounts the native camera only while this route is visible, active, and unobscured. */

import { StyleSheet, View } from 'react-native';
import { CameraView, type BarcodeScanningResult } from 'expo-camera';
import { radius, useAppTheme } from '../theme';

const SCAN_FRAME_WIDTH = 260; // Keeps a typical retail barcode comfortably inside the guide.
const SCAN_FRAME_HEIGHT = 160; // Leaves enough preview around the code for camera focus.

type BarcodeCameraProps = {
    active: boolean;
    onBarcodeScanned: (result: BarcodeScanningResult) => void;
    onCameraUnavailable: () => void;
};

/** Mounts the native camera only while this route is visible, active, and unobscured. */
export function BarcodeCamera({ active, onBarcodeScanned, onCameraUnavailable }: BarcodeCameraProps) {
    const theme = useAppTheme();

    if (!active) return null;

    return (
        <CameraView
            testID="barcode-camera"
            style={styles.camera}
            facing="back"
            accessible
            accessibilityLabel="Barcode camera preview"
            barcodeScannerSettings={{
                barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e']
            }}
            onBarcodeScanned={onBarcodeScanned}
            onMountError={onCameraUnavailable}
        >
            <View style={styles.scanOverlay}>
                <View
                    accessible={false}
                    style={[
                        styles.scanFrame,
                        { borderColor: theme.colors.onSurface }
                    ]}
                />
            </View>
        </CameraView>
    );
}

const styles = StyleSheet.create({
    camera: {
        flex: 1
    },
    scanOverlay: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.12)'
    },
    scanFrame: {
        width: SCAN_FRAME_WIDTH,
        height: SCAN_FRAME_HEIGHT,
        borderRadius: radius.md,
        borderWidth: 3,
        backgroundColor: 'transparent'
    }
});
