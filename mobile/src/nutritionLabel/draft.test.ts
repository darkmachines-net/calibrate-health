/** @file Regression coverage for draft: preserves the printed serving basis when saving, without multiplying calories. */

import { labelFoodPayload, validateLabelFood } from './draft';

const fields = { title: ' Peanut butter ', quantity: '2', unit: ' tbsp (32 g) ', calories: '190' };

test('preserves the printed serving basis when saving, without multiplying calories', () => {
    expect(labelFoodPayload(fields)).toEqual({
        name: 'Peanut butter', serving_size_quantity: 2, serving_unit_label: 'tbsp (32 g)', calories_per_serving: 190
    });
});

test('requires a title and real finite values while allowing explicit zero calories', () => {
    expect(validateLabelFood({ ...fields, calories: '0' })).toBeNull();
    for (const patch of [{ title: ' ' }, { quantity: '0' }, { quantity: 'Infinity' }, { unit: '' }, { calories: '' }, { calories: '-1' }, { calories: 'NaN' }]) {
        expect(validateLabelFood({ ...fields, ...patch })).not.toBeNull();
        expect(() => labelFoodPayload({ ...fields, ...patch })).toThrow();
    }
});
