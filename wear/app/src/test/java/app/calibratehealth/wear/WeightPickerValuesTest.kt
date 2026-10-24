/** Regression tests and fixtures for Weight Picker Values. */

package app.calibratehealth.wear

import org.junit.Assert.assertEquals
import org.junit.Test

class WeightPickerValuesTest {
    /** Verifies that metric picker separates whole and decimal values. */
    @Test
    fun `metric picker separates whole and decimal values`() {
        val picker = WeightPickerValues.from(72_400, "kg")

        assertEquals(25, picker.minimumWhole)
        assertEquals(400, picker.maximumWhole)
        assertEquals(72, picker.wholeAt(picker.selectedWholeIndex))
        assertEquals(4, picker.selectedDecimal)
        assertEquals(72_400, picker.gramsFor(picker.selectedWholeIndex, picker.selectedDecimal))
    }

    /** Verifies that picker combines independently selected whole and decimal values. */
    @Test
    fun `picker combines independently selected whole and decimal values`() {
        val picker = WeightPickerValues.from(72_400, "kg")

        assertEquals(81_700, picker.gramsFor(81 - picker.minimumWhole, 7))
    }

    /** Verifies that imperial picker preserves canonical grams until selection changes. */
    @Test
    fun `imperial picker preserves canonical grams until selection changes`() {
        val picker = WeightPickerValues.from(72_400, "LB")

        assertEquals("lb", picker.unitLabel)
        assertEquals(159, picker.selectedWhole)
        assertEquals(6, picker.selectedDecimal)
        assertEquals(72_400, picker.gramsFor(picker.selectedWholeIndex, picker.selectedDecimal))
        assertEquals(72_892, picker.gramsFor(160 - picker.minimumWhole, 7))
    }

    /** Verifies that picker clamps decimal options at canonical boundaries. */
    @Test
    fun `picker clamps decimal options at canonical boundaries`() {
        val metricMaximum = WeightPickerValues.from(WeightPickerValues.MAX_WEIGHT_GRAMS, "kg")
        val imperialMinimum = WeightPickerValues.from(WeightPickerValues.MIN_WEIGHT_GRAMS, "lb")

        assertEquals(0, metricMaximum.decimalAt(metricMaximum.selectedWholeIndex, 9))
        assertEquals(2, imperialMinimum.decimalAt(imperialMinimum.selectedWholeIndex, 0))
        assertEquals(55, imperialMinimum.minimumWhole)
        assertEquals(881, WeightPickerValues.from(WeightPickerValues.MAX_WEIGHT_GRAMS, "lb").maximumWhole)
        assertEquals(
            8,
            WeightPickerValues.from(WeightPickerValues.MAX_WEIGHT_GRAMS, "lb")
                .decimalAt(
                    WeightPickerValues.from(WeightPickerValues.MAX_WEIGHT_GRAMS, "lb").selectedWholeIndex,
                    9
                )
        )
    }
}
