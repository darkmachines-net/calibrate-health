/** @file Regression coverage for use Confirm Discard Navigation: useConfirmDiscardNavigation. */

import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useConfirmDiscardNavigation } from './useConfirmDiscardNavigation';
import { requestGuardedNavigation } from '../navigation/guardedNavigation';

const mockDispatch = jest.fn();
let mockShouldPreventRemove = false;
let mockIsFocused = true;
let mockPreventRemove: ((options: { repeat: () => void }) => void) | undefined;
const mockConfirmDiscardChanges = jest.fn<Promise<boolean>, []>();

jest.mock('expo-router', () => ({
    useIsFocused: () => mockIsFocused,
    usePreventRemove: (
        shouldPrevent: boolean,
        callback: typeof mockPreventRemove
    ) => {
        mockShouldPreventRemove = shouldPrevent;
        mockPreventRemove = callback;
    }
}));

jest.mock('../components/confirmDiscardChanges', () => ({
    confirmDiscardChanges: () => mockConfirmDiscardChanges()
}));

describe('useConfirmDiscardNavigation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockShouldPreventRemove = false;
        mockIsFocused = true;
        mockPreventRemove = undefined;
    });

    it('confirms before a dirty route is removed and resumes the original action', async () => {
        mockConfirmDiscardChanges.mockResolvedValue(true);
        await renderHook(() => useConfirmDiscardNavigation(true));
        const action = { type: 'GO_BACK' };

        await act(() => {
            mockPreventRemove?.({ repeat: () => mockDispatch(action) });
        });

        expect(mockShouldPreventRemove).toBe(false);
        await waitFor(() => expect(mockDispatch).toHaveBeenCalledWith(action));
    });

    it('keeps an explicit navigation request on the page when discard is cancelled', async () => {
        mockConfirmDiscardChanges.mockResolvedValue(false);
        const navigate = jest.fn();
        const { result } = await renderHook(() => useConfirmDiscardNavigation(true));

        await act(async () => {
            await result.current.requestNavigation(navigate);
        });

        expect(navigate).not.toHaveBeenCalled();
    });

    it('blocks route removal without prompting while a save is pending', async () => {
        await renderHook(() => useConfirmDiscardNavigation(false, true));

        await act(() => {
            mockPreventRemove?.({ repeat: () => mockDispatch({ type: 'GO_BACK' }) });
        });

        expect(mockShouldPreventRemove).toBe(true);
        expect(mockConfirmDiscardChanges).not.toHaveBeenCalled();
        expect(mockDispatch).not.toHaveBeenCalled();
    });

    it('blocks shell pushes while saving, including an otherwise clean editor', async () => {
        const navigate = jest.fn();
        await renderHook(() => useConfirmDiscardNavigation(false, true));
        await act(() => requestGuardedNavigation(navigate));
        expect(navigate).not.toHaveBeenCalled();
        expect(mockConfirmDiscardChanges).not.toHaveBeenCalled();
    });

    it('discards once before an approved shell departure and re-arms a retained editor', async () => {
        mockConfirmDiscardChanges.mockResolvedValue(true);
        const discard = jest.fn();
        const navigate = jest.fn();
        const { rerender } = await renderHook(() => useConfirmDiscardNavigation(true, false, discard));
        await act(async () => requestGuardedNavigation(navigate));
        expect(discard).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(discard.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);

        mockIsFocused = false;
        await rerender({});
        await act(() => requestGuardedNavigation(navigate));
        expect(navigate).toHaveBeenCalledTimes(2);
        expect(mockShouldPreventRemove).toBe(false);

        mockIsFocused = true;
        await rerender({});
        mockConfirmDiscardChanges.mockResolvedValue(false);
        await act(async () => requestGuardedNavigation(navigate));
        expect(mockShouldPreventRemove).toBe(true);
        expect(mockConfirmDiscardChanges).toHaveBeenCalledTimes(2);
        expect(discard).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(2);
    });

    it('keeps the draft and guard until preparation succeeds, blocking duplicate preparation', async () => {
        mockConfirmDiscardChanges.mockResolvedValue(true);
        let finish: (ready: boolean) => void = () => {};
        const prepare = jest.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
        const discard = jest.fn();
        const navigate = jest.fn();
        await renderHook(() => useConfirmDiscardNavigation(true, false, discard));
        await act(async () => requestGuardedNavigation(navigate, prepare));
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(discard).not.toHaveBeenCalled();
        expect(mockShouldPreventRemove).toBe(true);
        await act(async () => requestGuardedNavigation(navigate, prepare));
        expect(prepare).toHaveBeenCalledTimes(1);
        expect(mockConfirmDiscardChanges).toHaveBeenCalledTimes(1);
        await act(async () => finish(false));
        expect(discard).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(mockShouldPreventRemove).toBe(true);

        mockConfirmDiscardChanges.mockResolvedValue(false);
        await act(async () => requestGuardedNavigation(navigate, prepare));
        expect(prepare).toHaveBeenCalledTimes(1);
        mockConfirmDiscardChanges.mockResolvedValue(true);
        await act(async () => requestGuardedNavigation(navigate, prepare));
        await act(async () => finish(true));
        expect(prepare).toHaveBeenCalledTimes(2);
        expect(discard).toHaveBeenCalledTimes(1);
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(discard.mock.invocationCallOrder[0]).toBeLessThan(navigate.mock.invocationCallOrder[0]);
        expect(mockShouldPreventRemove).toBe(false);
    });

    it('requires successful preparation even without a focused editor', async () => {
        mockIsFocused = false;
        await renderHook(() => useConfirmDiscardNavigation(true));
        const navigate = jest.fn();
        const prepare = jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        await act(async () => requestGuardedNavigation(navigate, prepare));
        expect(navigate).not.toHaveBeenCalled();
        await act(async () => requestGuardedNavigation(navigate, prepare));
        expect(navigate).toHaveBeenCalledTimes(1);
        expect(mockConfirmDiscardChanges).not.toHaveBeenCalled();
    });

    it('ignores duplicate shell requests while confirmation is pending', async () => {
        let confirm: (answer: boolean) => void = () => {};
        mockConfirmDiscardChanges.mockReturnValue(new Promise((resolve) => { confirm = resolve; }));
        const navigate = jest.fn();
        await renderHook(() => useConfirmDiscardNavigation(true));
        await act(() => {
            requestGuardedNavigation(navigate);
            requestGuardedNavigation(navigate);
        });
        expect(mockConfirmDiscardChanges).toHaveBeenCalledTimes(1);
        await act(async () => confirm(false));
        expect(navigate).not.toHaveBeenCalled();
    });
});
