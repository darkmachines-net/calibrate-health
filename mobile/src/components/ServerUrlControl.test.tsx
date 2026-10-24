/** @file Regression coverage for Server Url Control: ServerUrlControl. */

import { fireEvent, render } from '@testing-library/react-native';
import { ServerUrlControl } from './ServerUrlControl';
import { HOSTED_SERVER_URL, type ServerConnectionState } from '../config/server';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const idleConnection: ServerConnectionState = {
    status: 'idle',
    testedInput: null,
    testedUrl: null,
    message: 'Test the connection before signing in.'
};

describe('ServerUrlControl', () => {
    it('keeps hosted connection details behind a generic Advanced disclosure', () => {
        const view = render(
            <ServerUrlControl
                value={HOSTED_SERVER_URL}
                onChangeText={jest.fn()}
                connection={idleConnection}
                onTestConnection={jest.fn(async () => true)}
            />
        );

        expect(view.getByText('Advanced')).toBeTruthy();
        expect(view.queryByText(HOSTED_SERVER_URL)).toBeNull();
        expect(view.queryByLabelText('Server URL')).toBeNull();
        expect(view.queryByText(idleConnection.message)).toBeNull();
        expect(view.getByLabelText('Show advanced connection options')).toHaveProp(
            'accessibilityState',
            { expanded: false }
        );
        fireEvent.press(view.getByLabelText('Show advanced connection options'));
        expect(view.queryByText('Self-hosted service')).toBeNull();
        expect(view.queryByText(/operator is responsible/)).toBeNull();
    });

    it('expands self-hosted controls and invokes an explicit connection test', () => {
        const onTestConnection = jest.fn(async () => true);
        const view = render(
            <ServerUrlControl
                value="http://10.0.2.2:3000"
                onChangeText={jest.fn()}
                connection={idleConnection}
                onTestConnection={onTestConnection}
            />
        );

        fireEvent.press(view.getByLabelText('Show advanced connection options'));
        fireEvent.press(view.getByLabelText('Test Calibrate server connection'));

        expect(view.getByLabelText('Server URL')).toHaveProp('keyboardType', 'url');
        expect(
            view.getByText('Release builds require HTTPS. Local HTTP is limited to development builds.')
        ).toBeTruthy();
        expect(view.getByText(
            /operator is responsible for privacy, security, availability, backups, and support/
        )).toBeTruthy();
        expect(onTestConnection).toHaveBeenCalledWith('http://10.0.2.2:3000');
    });

    it('announces the confirmed compatibility result for the current candidate', () => {
        const connected: ServerConnectionState = {
            status: 'connected',
            testedInput: 'https://self-hosted.example',
            testedUrl: 'https://self-hosted.example',
            message: 'Connected to Calibrate 1.2.3 (API v1).'
        };
        const view = render(
            <ServerUrlControl
                value="https://self-hosted.example/path"
                onChangeText={jest.fn()}
                connection={connected}
                onTestConnection={jest.fn(async () => true)}
            />
        );

        fireEvent.press(view.getByLabelText('Show advanced connection options'));

        expect(view.getByLabelText(connected.message)).toHaveProp('accessibilityLiveRegion', 'polite');
        expect(view.getByText(connected.message)).toBeTruthy();
    });

    it('does not show a stale success after the candidate changes and can restore hosted service', () => {
        const onChangeText = jest.fn();
        const connected: ServerConnectionState = {
            status: 'connected',
            testedInput: 'https://old.example',
            testedUrl: 'https://old.example',
            message: 'Connected to Calibrate 1.2.3 (API v1).'
        };
        const view = render(
            <ServerUrlControl
                value="https://new.example"
                onChangeText={onChangeText}
                connection={connected}
                onTestConnection={jest.fn(async () => true)}
            />
        );

        expect(view.getByText('Self-hosted service selected')).toBeTruthy();
        expect(view.queryByText(connected.message)).toBeNull();

        fireEvent.press(view.getByLabelText('Show advanced connection options'));
        expect(view.getByText('Test this address before continuing.')).toBeTruthy();
        fireEvent.press(view.getByLabelText('Use Calibrate hosted service'));
        expect(onChangeText).toHaveBeenCalledWith(HOSTED_SERVER_URL);
    });

    it('renders the editor directly inside an existing Advanced surface', () => {
        const view = render(
            <ServerUrlControl
                presentation="editor"
                value="https://self-hosted.example"
                onChangeText={jest.fn()}
                connection={idleConnection}
                onTestConnection={jest.fn(async () => true)}
            />
        );

        expect(view.queryByText('Advanced')).toBeNull();
        expect(view.getByLabelText('Server URL')).toBeTruthy();
    });
});
