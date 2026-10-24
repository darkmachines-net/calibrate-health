/** @file Regression coverage for Nutrition Label Screen: disabled scanning cannot open a picker through a direct link and keeps manual entry available. */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import NutritionLabelScreen from './NutritionLabelScreen';

const mockApi = { scanNutritionLabel: jest.fn(), createMyFood: jest.fn() };
const mockChoose = jest.fn();
const mockRelease = jest.fn();
let mockOnline = true;
let mockScanningEnabled = true;
jest.mock('../serverSettings/useServerSettings', () => ({
    useServerSettings: () => ({ nutritionLabelScanning: mockScanningEnabled })
}));

jest.mock('expo-router', () => ({
    router: { replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
    useLocalSearchParams: () => ({}),
    Redirect: () => null
}));
jest.mock('../auth/AuthContext', () => ({ useAuth: () => ({ api: mockApi, user: { id: 1 }, isLoading: false }) }));
jest.mock('../components/AsyncStateBoundary', () => ({ useOnlineStatus: () => mockOnline }));
jest.mock('../components/Screen', () => ({ Screen: require('react-native').View }));
jest.mock('../components/confirmDiscardChanges', () => ({ confirmDiscardChanges: () => Promise.resolve(true) }));
jest.mock('./imagePicker', () => ({
    chooseLabelImage: (...args: unknown[]) => mockChoose(...args),
    releaseLabelImage: (...args: unknown[]) => mockRelease(...args),
    LabelImageError: class extends Error {}
}));

const draft = {
    calories_per_serving: 190, serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)',
    serving_text: '2 tbsp (32 g)', warnings: []
};

async function showScreen() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return await render(<QueryClientProvider client={queryClient}><NutritionLabelScreen /></QueryClientProvider>);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockScanningEnabled = true;
    mockChoose.mockResolvedValue({ uri: 'file:///label.jpg', upload: { uri: 'file:///label.jpg', name: 'label.jpg', type: 'image/jpeg' } });
    mockApi.scanNutritionLabel.mockResolvedValue(draft);
    mockApi.createMyFood.mockImplementation(async (payload) => ({ id: 9, ...payload }));
});
afterEach(cleanup);

test('disabled scanning cannot open a picker through a direct link and keeps manual entry available', async () => {
    mockScanningEnabled = false;
    const screen = await showScreen();
    expect(screen.queryByText('Choose photo')).toBeNull();
    expect(screen.queryByText('Take photo')).toBeNull();
    expect(screen.getByText(/scanning is unavailable/)).toBeTruthy();
    expect(screen.getByLabelText(/Food title/)).toBeTruthy();
    expect(mockChoose).not.toHaveBeenCalled();
    expect(mockApi.scanNutritionLabel).not.toHaveBeenCalled();
});

test('scan produces an editable draft and only saves after a title and explicit save', async () => {
    const screen = await showScreen();
    await fireEvent.press(screen.getByText('Choose photo'));
    await waitFor(() => expect(screen.getByDisplayValue('190')).toBeTruthy());
    expect(mockApi.createMyFood).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('tbsp (32 g)')).toBeTruthy();
    await fireEvent.changeText(screen.getByLabelText(/Food title/), 'Peanut butter');
    await fireEvent.changeText(screen.getByLabelText(/Calories per serving/), '200');
    const saveButton = screen.getByText('Save food');
    await fireEvent.press(saveButton);
    await fireEvent.press(saveButton);
    await waitFor(() => expect(screen.getByText('Food saved')).toBeTruthy());
    expect(mockApi.createMyFood).toHaveBeenCalledTimes(1);
    expect(mockApi.createMyFood).toHaveBeenCalledWith({
        name: 'Peanut butter', calories_per_serving: 200, serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)'
    });
});

test('missing calories remain empty and explicit zero can be saved', async () => {
    mockApi.scanNutritionLabel.mockResolvedValue({ ...draft, calories_per_serving: null, warnings: ['Enter calories from the label.'] });
    const screen = await showScreen();
    await fireEvent.press(screen.getByText('Take photo'));
    await waitFor(() => expect(screen.getByText('Enter calories from the label.')).toBeTruthy());
    expect(screen.getByLabelText(/Calories per serving/).props.value).toBe('');
    await fireEvent.changeText(screen.getByLabelText(/Food title/), 'Zero calorie drink');
    await fireEvent.changeText(screen.getByLabelText(/Calories per serving/), '0');
    await fireEvent.press(screen.getByText('Save food'));
    await waitFor(() => expect(mockApi.createMyFood).toHaveBeenCalledWith(expect.objectContaining({ calories_per_serving: 0 })));
});

test('canceling a slow scan immediately restores editing and ignores its late result', async () => {
    let finish!: (result: typeof draft) => void;
    mockApi.scanNutritionLabel.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const screen = await showScreen();
    await fireEvent.press(screen.getByText('Choose photo'));
    await waitFor(() => expect(mockApi.scanNutritionLabel).toHaveBeenCalledTimes(1));
    const signal = mockApi.scanNutritionLabel.mock.calls[0][1];
    await fireEvent.press(screen.getByText('Cancel scan'));
    expect(signal.aborted).toBe(true);
    expect(screen.queryByText('Reading label...')).toBeNull();
    await fireEvent.changeText(screen.getByLabelText(/Calories per serving/), '25');
    await act(async () => finish(draft));
    expect(screen.getByLabelText(/Calories per serving/).props.value).toBe('25');
});

test('save errors retain the review fields for retry', async () => {
    mockApi.createMyFood.mockRejectedValueOnce(new Error('unavailable'));
    const screen = await showScreen();
    await fireEvent.press(screen.getByText('Choose photo'));
    await waitFor(() => expect(screen.getByDisplayValue('190')).toBeTruthy());
    await fireEvent.changeText(screen.getByLabelText(/Food title/), 'Peanut butter');
    await fireEvent.press(screen.getByText('Save food'));
    await waitFor(() => expect(screen.getByText('Food could not be saved. Your details are still here. Try again.')).toBeTruthy());
    expect(screen.getByDisplayValue('Peanut butter')).toBeTruthy();
    expect(screen.getByDisplayValue('190')).toBeTruthy();
    await fireEvent.press(screen.getByText('Save food'));
    await waitFor(() => expect(screen.getByText('Food saved')).toBeTruthy());
});

test('picker cancellation does not call OCR and offline controls do not start requests', async () => {
    mockChoose.mockResolvedValueOnce(null);
    const screen = await showScreen();
    await fireEvent.press(screen.getByText('Choose photo'));
    await waitFor(() => expect(screen.queryByText('Reading label...')).toBeNull());
    expect(mockApi.scanNutritionLabel).not.toHaveBeenCalled();
    mockOnline = false;
    await screen.rerender(<QueryClientProvider client={new QueryClient()}><NutritionLabelScreen /></QueryClientProvider>);
    await fireEvent.press(screen.getByText('Take photo'));
    expect(mockChoose).toHaveBeenCalledTimes(1);
});
