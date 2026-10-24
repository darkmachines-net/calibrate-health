/** @file goal Validation: Ensure goal start/target weights are coherent with the chosen deficit/surplus direction. */

/**
 * Ensure goal start/target weights are coherent with the chosen deficit/surplus direction.
 *
 * We infer goal type from `dailyDeficit`:
 * - dailyDeficit > 0 => target must be lower than start (weight loss)
 * - dailyDeficit < 0 => target must be higher than start (weight gain)
 * - dailyDeficit === 0 => no ordering constraint (maintenance)
 *
 * Returns a user-facing error message, or `null` when the goal definition is coherent.
 */
export function validateGoalWeightsForDailyDeficit(opts: {
  dailyDeficit: number;
  startWeightGrams: number;
  targetWeightGrams: number;
}): string | null {
  const { dailyDeficit, startWeightGrams, targetWeightGrams } = opts;

  if (dailyDeficit > 0 && startWeightGrams <= targetWeightGrams) {
    return 'For a weight loss goal, target weight must be less than start weight.';
  }

  if (dailyDeficit < 0 && startWeightGrams >= targetWeightGrams) {
    return 'For a weight gain goal, target weight must be greater than start weight.';
  }

  return null;
}

