/** @file Pure nutrition-label text parsing into a reviewable serving and calorie draft. */

export type NutritionLabelDraft = {
  calories_per_serving: number | null;
  serving_size_quantity: number | null;
  serving_unit_label: string | null;
  serving_text: string | null;
  warnings: string[];
};

const FRACTIONS: Record<string, string> = {
  '¼': ' 1/4', '½': ' 1/2', '¾': ' 3/4', '⅓': ' 1/3', '⅔': ' 2/3',
  '⅛': ' 1/8', '⅜': ' 3/8', '⅝': ' 5/8', '⅞': ' 7/8'
};
const NUMBER = String.raw`(?:\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)`;
const SERVING = new RegExp(`^(${NUMBER})\\s*([a-z][a-z .-]*(?:\\([^\\n)]*\\))?)$`, 'i');

function parseQuantity(value: string): number | null {
  const parts = value.trim().split(/\s+(?=\d+\s*\/)/);
  const fraction = parts[parts.length - 1].split('/').map((part) => Number(part.trim().replace(',', '.')));
  let quantity = fraction[0];
  if (fraction.length === 2) quantity /= fraction[1];
  if (parts.length === 2) quantity += Number(parts[0]);
  return Number.isFinite(quantity) && quantity > 0 ? quantity : null;
}

/** Only fill values tied to a single printed basis; unknowns must never become zero. */
export function parseNutritionLabel(text: string): NutritionLabelDraft {
  const lines = text.replace(/[¼½¾⅓⅔⅛⅜⅝⅞]/g, (char) => FRACTIONS[char])
    .replace(/⁄/g, '/').split(/\r?\n/).map((line) => line.trim().replace(/[ \t]+/g, ' ')).filter(Boolean);
  const draft: NutritionLabelDraft = {
    calories_per_serving: null, serving_size_quantity: null, serving_unit_label: null,
    serving_text: null, warnings: []
  };
  const servingLines: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^serving size\s*:?\s*(.*)$/i);
    if (match) servingLines.push(match[1] || lines[index + 1] || '');
  }
  if (servingLines.length === 1) {
    draft.serving_text = servingLines[0].slice(0, 160);
    const match = servingLines[0].match(SERVING);
    if (match && match[2].trim().length <= 48) {
      draft.serving_size_quantity = parseQuantity(match[1]);
      if (draft.serving_size_quantity !== null) draft.serving_unit_label = match[2].trim();
    }
  }

  const calorieValues: number[] = [];
  let ambiguousCalories = false;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^calories\b(.*)$/i);
    if (!match || /^\s*from\s+fat/i.test(match[1])) continue;
    const value = (match[1].trim() || lines[index + 1] || '').replace(/^:\s*/, '');
    if (/^\d+(?:\.\d+)?(?:\s*kcal)?$/i.test(value)) {
      calorieValues.push(Number.parseFloat(value));
      const nextLine = lines[index + (match[1].trim() ? 1 : 2)] ?? '';
      if (/^\d+(?:\.\d+)?(?:\s*kcal)?$/i.test(nextLine)) ambiguousCalories = true;
    }
    else ambiguousCalories = true;
  }

  // Multiple columns and per-100g panels cannot safely be paired with a printed serving size.
  const basisText = lines.filter((line) => !/^(?:about\s+)?[\d.,]+\s+servings?\s+per\s+(?:container|package)\b/i.test(line)).join(' ');
  const differentBasis = /\bper\s*(?:100\s*(?:g|ml)\b|container\b|package\b)|\bas prepared\b|\bas packaged\b/i.test(basisText);
  if (calorieValues.length === 1 && !ambiguousCalories && !differentBasis) {
    draft.calories_per_serving = calorieValues[0];
  } else if (calorieValues.length > 1 || ambiguousCalories || differentBasis) {
    draft.warnings.push('Check the calorie column. Enter calories for the serving size below, not for the whole package or per 100 g.');
  }
  if (draft.serving_size_quantity === null) draft.warnings.push('Serving size could not be read. Enter the quantity and unit printed on the label.');
  if (draft.calories_per_serving === null && calorieValues.length <= 1 && !ambiguousCalories && !differentBasis) draft.warnings.push('Calories could not be read. Enter the calories per serving printed on the label.');
  return draft;
}
