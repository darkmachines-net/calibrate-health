/** @file Server/provider discovery hides unavailable options and ignores responses for a previously selected server. */
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { SocialAuthButtons } from './SocialAuthButtons';
const mockProviders = jest.fn();
jest.mock('@calibrate/api-client', () => ({ CalibrateApiClient: class { getMobileSocialProviders = () => mockProviders(); } }));
jest.mock('./nativeSocialAuth', () => ({ nativeSocialProviders: async () => ['google.com', 'apple.com'] }));
jest.mock('@react-native-google-signin/google-signin', () => {
    const GoogleSigninButton = (props: object) => require('react').createElement(require('react-native').Button, { ...props, title: 'Google' });
    GoogleSigninButton.Size = { Wide: 1 };
    GoogleSigninButton.Color = { Light: 1 };
    return { GoogleSigninButton };
});
jest.mock('expo-apple-authentication', () => ({
    AppleAuthenticationButton: (props: object) => require('react').createElement(require('react-native').Button, { ...props, title: 'Apple' }),
    AppleAuthenticationButtonType: { CONTINUE: 1 }, AppleAuthenticationButtonStyle: { BLACK: 1 }
}));
beforeEach(() => { jest.useFakeTimers(); mockProviders.mockReset(); });
afterEach(() => { jest.useRealTimers(); });

test('shows the server-enabled subset and forwards the provider action', async () => {
    mockProviders.mockResolvedValue({ providers: ['google.com'] });
    const onPress = jest.fn();
    const screen = await render(<SocialAuthButtons serverUrl="https://one.example" disabled={false} onPress={onPress} />);
    await act(async () => { jest.advanceTimersByTime(300); });
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    expect(screen.queryByText('Apple')).toBeNull();
    await fireEvent.press(screen.getByText('Google'));
    expect(onPress).toHaveBeenCalledWith('google.com');
});
test('an old server response cannot enable provider controls for a new server', async () => {
    let resolveOld!: (value: unknown) => void;
    mockProviders.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue({ providers: [] });
    const screen = await render(<SocialAuthButtons serverUrl="https://one.example" disabled={false} onPress={jest.fn()} />);
    await act(async () => { jest.advanceTimersByTime(300); });
    await screen.rerender(<SocialAuthButtons serverUrl="https://two.example" disabled={false} onPress={jest.fn()} />);
    await act(async () => { resolveOld({ providers: ['google.com', 'apple.com'] }); jest.advanceTimersByTime(300); });
    expect(screen.queryByText('Google')).toBeNull();
    expect(screen.queryByText('Apple')).toBeNull();
});
test('older servers without discovery keep email sign-in usable', async () => {
    mockProviders.mockRejectedValue(new Error('Not found'));
    const screen = await render(<SocialAuthButtons serverUrl="https://one.example" disabled={false} onPress={jest.fn()} />);
    await act(async () => { jest.advanceTimersByTime(300); });
    expect(screen.queryByText('Google')).toBeNull();
});
