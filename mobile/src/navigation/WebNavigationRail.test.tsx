/** @file Regression coverage for Web Navigation Rail: exposes only canonical primary links and the actual selected tab. */

import React from 'react';
import { Platform } from 'react-native';
import { registerNavigationGuard } from './guardedNavigation';
import { WebNavigationRail } from './WebNavigationRail.web';
import { WebNavigationRail as NativeRail } from './WebNavigationRail';
import type { WebNavigationRailProps } from './WebNavigationRail.types';

const renderer = require('react-test-renderer') as {
    act: (callback: () => void) => void;
    create: (element: React.ReactElement) => { root: {
        findAllByType: (type: string) => Array<{ props: Record<string, any> }>;
    }; unmount: () => void };
};
const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({
    Link: (props: object) => require('react').createElement('guarded-link', props),
    router: { navigate: (...args: unknown[]) => mockNavigate(...args) }
}));
let unregisterGuard: (() => void) | undefined;
beforeEach(() => {
    jest.clearAllMocks();
    jest.replaceProperty(Platform, 'OS', 'web');
});
afterEach(() => {
    unregisterGuard?.();
    unregisterGuard = undefined;
    jest.restoreAllMocks();
});
jest.mock('../theme', () => ({
    spacing: { xs: 4, sm: 8 }, radius: { md: 12, pill: 999 },
    useAppTheme: () => ({ colors: { primary: 'green', background: 'white', muted: 'gray' } })
}));

function setup(index = 0, prevented = false) {
    const emit = jest.fn(() => ({ defaultPrevented: prevented }));
    const dispatch = jest.fn();
    const routes = [
        { key: 'today-key', name: '(today)' },
        { key: 'progress-key', name: '(progress)' },
        { key: 'settings-key', name: '(settings)' }
    ];
    const props = {
        state: { key: 'tabs-key', index, routes },
        descriptors: Object.fromEntries(routes.map(route => [route.key, { options: {} }])),
        navigation: { emit, dispatch }, insets: { top: 0, right: 0, bottom: 0, left: 0 }, onWidthChange: jest.fn()
    } as unknown as WebNavigationRailProps;
    let tree!: ReturnType<typeof renderer.create>;
    renderer.act(() => { tree = renderer.create(<WebNavigationRail {...props} />); });
    return { tree, links: tree.root.findAllByType('guarded-link'), emit, dispatch, props };
}

it('exposes only canonical primary links and the actual selected tab', () => {
    const { links, tree } = setup(1);
    expect(links.map(link => [link.props.href, link.props['aria-label'], link.props['aria-selected']]))
        .toEqual([['/today', 'Today', false], ['/progress', 'Progress', true]]);
    renderer.act(() => tree.unmount());
});

it.each([false, true])('honors tabPress cancellation (%s) after the guarded link allows navigation', prevented => {
    const { links, emit, dispatch, tree } = setup(0, prevented);
    const event = { preventDefault: jest.fn() };
    links[1].props.onPress(event);
    expect(emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'progress-key', canPreventDefault: true });
    expect(event.preventDefault).toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledTimes(prevented ? 0 : 1);
    if (!prevented) expect(mockNavigate).toHaveBeenCalledWith('/progress');
    renderer.act(() => tree.unmount());
});

it('emits reselection and long press without adding a duplicate route', () => {
    const { links, emit, dispatch, tree, props } = setup();
    links[0].props.onPress({ preventDefault: jest.fn() });
    links[0].props.onLongPress();
    expect(dispatch).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({ type: 'tabLongPress', target: 'today-key' });
    expect(NativeRail(props)).toBeNull();
    renderer.act(() => tree.unmount());
});

it.each([false, true])('replays the cancellable tab event only after guard approval (%s)', prevented => {
    let resume: (() => void) | undefined;
    unregisterGuard = registerNavigationGuard(async (navigate) => { resume = navigate; });
    const { links, emit, dispatch, tree } = setup(0, prevented);
    const event = { preventDefault: jest.fn() };
    links[1].props.onPress(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    // A dismissed confirmation does not call resume; approval must retain tab listeners.
    expect(resume).toBeDefined();
    resume?.();
    expect(emit).toHaveBeenCalledWith({ type: 'tabPress', target: 'progress-key', canPreventDefault: true });
    expect(dispatch).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledTimes(prevented ? 0 : 1);
    if (!prevented) expect(mockNavigate).toHaveBeenCalledWith('/progress');
    renderer.act(() => tree.unmount());
});
