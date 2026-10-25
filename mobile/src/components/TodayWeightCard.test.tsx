/** @file Regression coverage for Today Weight Card: TodayWeightCard. */

import { fireEvent, render, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import type { MetricEntry } from '@calibrate/api-client';
import { TodayWeightCard } from './TodayWeightCard';
import { themes } from '../theme';

jest.mock('@expo/vector-icons/Ionicons', () => () => null);

const TODAY_METRIC: MetricEntry = {
    id: 1,
    date: '2026-07-21T00:00:00.000Z',
    weight: 168.2
};

describe('TodayWeightCard', () => {
    it("shows today's saved weight and offers to edit it", async () => {
        const onPress = jest.fn();
        const screen = await render(
            <TodayWeightCard metric={TODAY_METRIC} weightUnit="LB" isToday onPress={onPress} />
        );

        expect(screen.queryByText("Today's weight")).toBeNull();
        expect(screen.getByText('168.2 lb')).toBeTruthy();
        expect(screen.getByText('Logged today')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Edit weight' })).toBeNull();
        expect(screen.getAllByRole('button')).toHaveLength(1);

        await fireEvent.press(screen.getByTestId('today-weight-card-press-layer'));
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it('offers a focused weigh-in action when today has no measurement', async () => {
        const screen = await render(
            <TodayWeightCard metric={null} weightUnit="KG" isToday onPress={jest.fn()} />
        );

        expect(screen.getByText('Weigh in')).toBeTruthy();
        expect(screen.getByText("Record today's weight")).toBeTruthy();
        expect(screen.getByLabelText("Today's weight. Weigh in. Log weight")).toBeTruthy();
        expect(screen.queryByText('No weigh-in yet')).toBeNull();
    });

    it('uses day-specific copy when browsing a previous date', async () => {
        const screen = await render(
            <TodayWeightCard metric={TODAY_METRIC} weightUnit="LB" isToday={false} onPress={jest.fn()} />
        );

        expect(screen.getByLabelText('Weight. 168.2 lb. Edit weight')).toBeTruthy();
        expect(screen.getByText('Logged for this day')).toBeTruthy();
    });

    it('uses one full-row target and lets compact weight copy wrap', async () => {
        const onPress = jest.fn();
        const screen = await render(
            <TodayWeightCard metric={TODAY_METRIC} weightUnit="LB" isToday onPress={onPress} />
        );
        const target = screen.getByTestId('today-weight-card-press-layer');

        expect(within(target).queryByRole('header')).toBeNull();
        expect(within(target).getByText('168.2 lb')).toBeTruthy();
        expect(within(target).queryByRole('button', { name: 'Edit weight' })).toBeNull();
        expect(screen.getByText('168.2 lb').props.numberOfLines).toBeUndefined();
        expect(StyleSheet.flatten(target.props.style)).toMatchObject({
            minHeight: themes.light.interaction.minimumTouchTarget,
            flex: 1
        });

        await fireEvent(target, 'hoverIn');
        expect(target).toHaveStyle({ backgroundColor: themes.light.colors.surfaceHovered });
        await fireEvent(target, 'hoverOut');
        await fireEvent.press(target);
        expect(onPress).toHaveBeenCalledTimes(1);
    });
});
