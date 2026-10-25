/** @file Regression coverage for Async State Boundary: AsyncStateBoundary. */

import { Text } from 'react-native';
import type { TestInstance as ReactTestInstance } from 'test-renderer';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { ApiError } from '@calibrate/api-client';
import { ASYNC_RESOURCE_STATES } from '../asyncState/resolveAsyncState';
import { AsyncStateBoundary } from './AsyncStateBoundary';

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
};

function isDescendantOf(node: ReactTestInstance, ancestor: ReactTestInstance): boolean {
    let parent = node.parent;
    while (parent) {
        if (parent === ancestor) return true;
        parent = parent.parent;
    }
    return false;
}

describe('AsyncStateBoundary', () => {
    const baseProps = {
        resourceLabel: 'food log',
        loading: <Text>Shaped food skeleton</Text>,
        empty: <Text>No food logged yet</Text>,
        children: <Text>Cached breakfast</Text>
    };

    it('renders exactly the selected loading or empty branch', async () => {
        const view = await render(
            <AsyncStateBoundary {...baseProps} state={{ kind: ASYNC_RESOURCE_STATES.LOADING, error: null }} />
        );
        expect(view.getByText('Shaped food skeleton')).toBeTruthy();
        expect(view.queryByText('No food logged yet')).toBeNull();
        expect(view.queryByText('Cached breakfast')).toBeNull();

        await view.rerender(
            <AsyncStateBoundary {...baseProps} state={{ kind: ASYNC_RESOURCE_STATES.EMPTY, error: null }} />
        );
        expect(view.getByText('No food logged yet')).toBeTruthy();
        expect(view.queryByText('Shaped food skeleton')).toBeNull();
    });

    it('uses safe terminal copy and preserves a bounded request reference', async () => {
        const rawMessage = 'SELECT password_hash FROM users failed';
        const error = new ApiError(rawMessage, 500, {
            message: rawMessage,
            code: 'SERVER_ERROR',
            retryable: true,
            request_id: 'request-123'
        });
        const view = await render(
            <AsyncStateBoundary
                {...baseProps}
                state={{ kind: ASYNC_RESOURCE_STATES.ERROR, error }}
                onRetry={jest.fn()}
            />
        );

        expect(view.getByRole('alert')).toBeTruthy();
        expect(view.getByText("Can't load food log")).toBeTruthy();
        expect(view.getByText('Reference: request-123')).toBeTruthy();
        expect(view.queryByText(rawMessage)).toBeNull();
        expect(view.queryByText('No food logged yet')).toBeNull();

        const alertCopy = view.getByTestId('async-state-error-copy');
        const retryButton = view.getByRole('button', { name: 'Retry' });
        expect(alertCopy).toHaveProp('accessibilityRole', 'alert');
        expect(alertCopy).toHaveProp('accessibilityLiveRegion', 'assertive');
        expect(isDescendantOf(retryButton, alertCopy)).toBe(false);
    });

    it('keeps cached content visible in degraded mode and retries only its supplied resource', async () => {
        const retryGate = deferred();
        const retryFood = jest.fn(() => retryGate.promise);
        const retryProfile = jest.fn();
        const view = await render(
            <AsyncStateBoundary
                {...baseProps}
                state={{ kind: ASYNC_RESOURCE_STATES.DEGRADED, error: new Error('private provider text') }}
                onRetry={retryFood}
            />
        );

        expect(view.getByText('Cached breakfast')).toBeTruthy();
        expect(view.getByText("Couldn't refresh food log")).toBeTruthy();
        await fireEvent.press(view.getByLabelText('Retry'));
        expect(retryFood).toHaveBeenCalledTimes(1);
        expect(retryProfile).not.toHaveBeenCalled();
        expect(view.getByLabelText('Retrying...')).toHaveProp('accessibilityState', { busy: true, disabled: true });
        expect(view.getByText('Retrying food log')).toHaveProp('accessibilityLiveRegion', 'polite');

        retryGate.resolve();
        await waitFor(() => expect(view.getByLabelText('Retry')).toHaveProp(
            'accessibilityState',
            { busy: false, disabled: false }
        ));
    });

    it('labels cached offline content without offering a doomed retry', async () => {
        const view = await render(
            <AsyncStateBoundary
                {...baseProps}
                state={{ kind: ASYNC_RESOURCE_STATES.STALE, error: null }}
                onRetry={jest.fn()}
            />
        );

        expect(view.getByText('Cached breakfast')).toBeTruthy();
        expect(view.getByText('Offline - showing saved information')).toBeTruthy();
        expect(view.queryByLabelText('Retry')).toBeNull();
    });

    it('lets a parent boundary own stale copy without hiding cached content or degraded recovery', async () => {
        const view = await render(
            <AsyncStateBoundary
                {...baseProps}
                state={{ kind: ASYNC_RESOURCE_STATES.STALE, error: null }}
                suppressStaleNotice
            />
        );

        expect(view.getByText('Cached breakfast')).toBeTruthy();
        expect(view.queryByText('Offline - showing saved information')).toBeNull();

        await view.rerender(
            <AsyncStateBoundary
                {...baseProps}
                state={{ kind: ASYNC_RESOURCE_STATES.DEGRADED, error: new Error('private provider text') }}
                onRetry={jest.fn()}
                suppressStaleNotice
            />
        );
        expect(view.getByText("Couldn't refresh food log")).toBeTruthy();
        expect(view.getByLabelText('Retry')).toBeTruthy();
    });

    it('renders uncached offline content as a connection-specific terminal state without Retry', async () => {
        const view = await render(
            <AsyncStateBoundary
                {...baseProps}
                state={{
                    kind: ASYNC_RESOURCE_STATES.ERROR,
                    error: new Error('private transport details'),
                    terminalReason: 'offline'
                }}
                onRetry={jest.fn()}
            />
        );

        expect(view.getByText("You're offline")).toBeTruthy();
        expect(view.getByText('Connect to the internet to load food log.')).toBeTruthy();
        expect(view.queryByText("Can't load food log")).toBeNull();
        expect(view.queryByText('private transport details')).toBeNull();
        expect(view.queryByLabelText('Retry')).toBeNull();
        expect(view.queryByText('Cached breakfast')).toBeNull();
        expect(view.queryByText('No food logged yet')).toBeNull();
    });
});
