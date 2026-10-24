/** @file Regression coverage for Calorie Balance Card: CalorieBalanceCard. */

import { act, render } from '@testing-library/react-native';
import { Dimensions, processColor, StyleSheet } from 'react-native';
import { themes } from '../theme';
import { CalorieBalanceCard } from './CalorieBalanceCard';

async function setWindowDimensions(width: number, fontScale: number) {
    const dimensions = { width, height: 768, scale: 1, fontScale };
    await act(() => {
        Dimensions.set({ window: dimensions, screen: dimensions });
    });
}

describe('CalorieBalanceCard', () => {
    afterEach(async () => await setWindowDimensions(1_024, 1));

    it('keeps the card focused on percentage eaten and calories remaining', async () => {
        const screen = await render(
            <CalorieBalanceCard totalCalories={1456} targetCalories={1820} compact />
        );

        expect(screen.getByText('80%', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.getByText('eaten', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.getByText('364')).toBeTruthy();
        expect(screen.getByText('kcal remaining')).toBeTruthy();
        expect(screen.queryByText('Eaten')).toBeNull();
        expect(screen.queryByText('Target')).toBeNull();
    });

    it('retains the detailed calorie bookkeeping in the accessibility summary', async () => {
        const screen = await render(
            <CalorieBalanceCard totalCalories={1456} targetCalories={1820} compact />
        );

        expect(screen.getByLabelText(
            'Daily balance. 364 kcal remaining. 1,456 eaten out of 1,820 calorie target.'
        )).toBeTruthy();
    });

    it.each(['Compared with current target', 'Compared with saved target'])('exposes %s visually and to assistive technology at 320px', async comparisonLabel => {
        await setWindowDimensions(320, 1);
        const screen = await render(<CalorieBalanceCard totalCalories={1800} targetCalories={2100} comparisonLabel={comparisonLabel} compact open />);
        expect(screen.getByText(comparisonLabel)).toBeTruthy();
        expect(screen.getByText('kcal remaining')).toBeTruthy();
        expect(screen.getByLabelText(`Daily balance. 300 kcal remaining. 1,800 eaten out of 2,100 calorie target. ${comparisonLabel}.`)).toBeTruthy();
    });

    it('keeps neutral progress styling through target and uses danger only when over', async () => {
        const atTarget = await render(
            <CalorieBalanceCard totalCalories={1820} targetCalories={1820} compact />
        );

        expect(atTarget.getByTestId('calorie-balance-value', { includeHiddenElements: true }).props.children).toBe('0');
        expect(atTarget.getByTestId('calorie-gauge-progress', { includeHiddenElements: true }).props.stroke.payload)
            .toEqual(processColor(themes.light.colors.primary));

        await atTarget.unmount();
        const overTarget = await render(
            <CalorieBalanceCard totalCalories={2000} targetCalories={1820} compact />
        );
        expect(overTarget.getByTestId('calorie-balance-value', { includeHiddenElements: true }).props.children).toBe('180');
        expect(overTarget.getByText('kcal over target')).toBeTruthy();
        expect(overTarget.getByTestId('calorie-gauge-progress', { includeHiddenElements: true }).props.stroke.payload)
            .toEqual(processColor(themes.light.colors.danger));
    });

    it('keeps an unavailable target out of the gauge without losing logged calories', async () => {
        const screen = await render(
            <CalorieBalanceCard
                totalCalories={1456}
                targetCalories={null}
                unavailableLabel="Plan needs review"
                compact
            />
        );

        expect(screen.getByText('Plan needs review')).toBeTruthy();
        expect(screen.getByText('1,456 kcal logged')).toBeTruthy();
        expect(screen.queryByTestId('calorie-gauge-progress', { includeHiddenElements: true })).toBeNull();
        expect(screen.getByText('-', { includeHiddenElements: true })).toBeTruthy();
        expect(screen.queryByText('0%', { includeHiddenElements: true })).toBeNull();
    });

    it.each([
        ['keeps the compact hero horizontal at the supported phone width', 320, 1, 'row'],
        ['stacks below the supported phone width', 319, 1, 'column'],
        ['stacks at the supported phone width for large text', 320, 1.6, 'column']
    ])('%s', async (_label, width, fontScale, flexDirection) => {
        await setWindowDimensions(width, fontScale);
        const screen = await render(
            <CalorieBalanceCard totalCalories={360} targetCalories={2100} compact />
        );

        expect(StyleSheet.flatten(screen.getByTestId('calorie-balance-hero').props.style))
            .toEqual(expect.objectContaining({ flexDirection }));
    });
});
