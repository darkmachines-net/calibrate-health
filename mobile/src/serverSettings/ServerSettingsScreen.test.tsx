/** @file Regression coverage for Server Settings Screen: admin can enable and disable the server setting and sees the persisted result. */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppText } from '../components/AppText';
import ServerSettingsScreen from './ServerSettingsScreen';
import { serverSettingsQueryKey, useServerSettings } from './useServerSettings';

const mockApi = { getServerSettings: jest.fn(), updateServerSettings: jest.fn() };
let mockServerUrl = 'https://one.example';
let mockUser = { id: 1 };
let mockOnline = true;
jest.mock('@expo/vector-icons/Ionicons', () => () => null);
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({
    api: mockApi, user: mockUser, serverUrl: mockServerUrl, isLoading: false
}) }));
jest.mock('expo-router', () => ({ Redirect: () => null }));
jest.mock('../components/TabScreen', () => ({ TabScreen: require('react-native').View }));
jest.mock('../components/AsyncStateBoundary', () => ({ useOnlineStatus: () => mockOnline }));

const response = (enabled: boolean, admin = true) => ({
    features: { nutrition_label_scanning: enabled }, is_admin: admin
});
function setup() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false, gcTime: 0 } } });
    const screen = render(<QueryClientProvider client={client}><ServerSettingsScreen /></QueryClientProvider>);
    return { screen, client };
}
beforeEach(() => {
    jest.clearAllMocks();
    mockServerUrl = 'https://one.example';
    mockUser = { id: 1 };
    mockOnline = true;
    mockApi.getServerSettings.mockResolvedValue(response(false));
    mockApi.updateServerSettings.mockImplementation(async (features) => ({ features, is_admin: true }));
});
afterEach(cleanup);

test('admin can enable and disable the server setting and sees the persisted result', async () => {
    const { screen } = setup();
    const toggle = await screen.findByRole('switch', { name: 'Nutrition label scanning' });
    expect(toggle.props.accessibilityState.checked).toBe(false);
    fireEvent.press(toggle);
    await waitFor(() => expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(true));
    expect(mockApi.updateServerSettings).toHaveBeenLastCalledWith({ nutrition_label_scanning: true });
    fireEvent.press(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(false));
    expect(mockApi.updateServerSettings).toHaveBeenLastCalledWith({ nutrition_label_scanning: false });
});

test('a direct admin URL does not expose controls to a non-admin', async () => {
    mockApi.getServerSettings.mockResolvedValue(response(false, false));
    const { screen } = setup();
    await screen.findByText(/administrator access is required/);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(mockApi.updateServerSettings).not.toHaveBeenCalled();
});

test('failed saves retain the server value and permit retry', async () => {
    mockApi.updateServerSettings.mockRejectedValueOnce(new Error('Unavailable'));
    const { screen } = setup();
    fireEvent.press(await screen.findByRole('switch'));
    await screen.findByText('The setting could not be saved. Try again.');
    expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(false);
    fireEvent.press(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByRole('switch').props.accessibilityState.checked).toBe(true));
});

test('loading and failed configuration never expose a toggle and can be retried', async () => {
    mockApi.getServerSettings.mockRejectedValueOnce(new Error('Unavailable'));
    const { screen } = setup();
    expect(screen.queryByRole('switch')).toBeNull();
    await screen.findByText('Server settings could not be loaded.');
    fireEvent.press(screen.getByText('Try again'));
    await screen.findByRole('switch');
});

test('offline administration cannot send a mutation', async () => {
    mockOnline = false;
    const { screen } = setup();
    expect(screen.getByText('Connect to the server to manage its settings.')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(mockApi.updateServerSettings).not.toHaveBeenCalled();
});

test('feature reads fail closed after refresh errors and never cross server or account boundaries', async () => {
    mockApi.getServerSettings.mockResolvedValue(response(true));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    function Probe() {
        const settings = useServerSettings();
        return <AppText>{settings.nutritionLabelScanning ? 'enabled' : 'disabled'}</AppText>;
    }
    const tree = () => <QueryClientProvider client={client}><Probe /></QueryClientProvider>;
    const screen = render(tree());
    await screen.findByText('enabled');
    mockApi.getServerSettings.mockRejectedValue(new Error('Unavailable'));
    await act(async () => { await client.invalidateQueries({ queryKey: serverSettingsQueryKey(mockServerUrl, 1) }); });
    await screen.findByText('disabled');
    mockApi.getServerSettings.mockImplementation(() => new Promise(() => {}));
    mockServerUrl = 'https://two.example';
    screen.rerender(tree());
    expect(screen.getByText('disabled')).toBeTruthy();
    mockUser = { id: 2 };
    screen.rerender(tree());
    expect(screen.getByText('disabled')).toBeTruthy();
});
