/** @file Regression coverage for lose it import: parseLoseItExport parses Lose It exports with warnings for invalid rows. */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const {
  parseLoseItExport,
  inferLoseItWeightUnit,
  partitionLoseItWeightImportsByAsOfDate,
  buildImportTimestamp
} = require('../src/services/loseItImport');

const buildZipBuffer = (entries) => {
  const zip = new AdmZip();
  for (const { name, contents } of entries) {
    zip.addFile(name, Buffer.from(contents, 'utf8'));
  }
  return zip.toBuffer();
};

test('parseLoseItExport parses Lose It exports with warnings for invalid rows', () => {
  const foodCsv = [
    'Date,Meal,Name,Calories,Quantity,Units,Deleted',
    '1/2/2025,Breakfast,Greek Yogurt,200,2,cups,',
    '1/2/2025,Lunch,"Soup, tomato",150,1,bowl,',
    '1/2/2025,Mystery Meal,Soup,150,1,bowl,',
    '1/2/2025,Lunch,,300,1,plate,',
    'bad-date,Lunch,Salad,300,1,plate,',
    '1/3/2025,Dinner,Steak,,1,plate,',
    '1/3/2025,Dinner,Pasta,600,0,,',
    '1/3/2025,Breakfast,Toast,100,1,slice,TRUE'
  ].join('\n');

  const weightCsv = [
    'Date,Weight,Last Updated,Deleted',
    '1/2/2025,180,2025-01-02T10:00:00Z,',
    '1/2/2025,181,2025-01-02T12:00:00Z,',
    '1/2/2025,182,,',
    '1/3/2025,0,2025-01-03T08:00:00Z,',
    '1/4/2025,175,not-a-date,',
    '1/5/2025,170,2025-01-05T09:00:00Z,TRUE'
  ].join('\n');

  const bodyFatCsv = ['Date,Value', '1/2/2025,20', '1/2/2025,21', '1/3/2025,0'].join('\n');
  const profileCsv = ['Name,Value', 'Plan,Weight Loss (lb)', 'Height,68'].join('\n');

  const buffer = buildZipBuffer([
    { name: 'food-logs.csv', contents: foodCsv },
    { name: 'weights.csv', contents: weightCsv },
    { name: 'body-fat.csv', contents: bodyFatCsv },
    { name: 'profile.csv', contents: profileCsv }
  ]);

  const result = parseLoseItExport(buffer);

  assert.equal(result.foodLogs.length, 3);
  assert.equal(result.weights.length, 2);
  assert.equal(result.bodyFat.length, 1);
  assert.equal(result.profile.Plan, 'Weight Loss (lb)');
  assert.equal(result.foodDayCompletionStatus, 'unavailable');

  const greek = result.foodLogs.find((log) => log.name === 'Greek Yogurt');
  assert.ok(greek);
  assert.equal(greek.localDate, '2025-01-02');
  assert.equal(greek.localDateValue.toISOString(), '2025-01-02T00:00:00.000Z');
  assert.equal(greek.entryTimestamp.toISOString(), '2025-01-02T12:00:00.000Z');
  assert.equal(greek.mealPeriod, 'BREAKFAST');
  assert.equal(greek.calories, 200);
  assert.equal(greek.servingsConsumed, 2);
  assert.equal(greek.servingSizeQuantity, 1);
  assert.equal(greek.servingUnitLabel, 'cups');
  assert.equal(greek.caloriesPerServing, 100);

  const soup = result.foodLogs.find((log) => log.name === 'Soup, tomato');
  assert.ok(soup);
  assert.equal(soup.mealPeriod, 'LUNCH');
  assert.equal(soup.caloriesPerServing, 150);

  const pasta = result.foodLogs.find((log) => log.name === 'Pasta');
  assert.ok(pasta);
  assert.equal(pasta.servingsConsumed, null);
  assert.equal(pasta.servingUnitLabel, null);
  assert.equal(pasta.servingSizeQuantity, null);
  assert.equal(pasta.caloriesPerServing, null);

  const weightJan2 = result.weights.find((entry) => entry.localDate === '2025-01-02');
  assert.ok(weightJan2);
  assert.equal(weightJan2.weightValue, 181);
  assert.equal(weightJan2.lastUpdated.toISOString(), '2025-01-02T12:00:00.000Z');

  const weightJan4 = result.weights.find((entry) => entry.localDate === '2025-01-04');
  assert.ok(weightJan4);
  assert.equal(weightJan4.weightValue, 175);
  assert.equal(weightJan4.lastUpdated, null);

  assert.equal(result.bodyFat[0].localDate, '2025-01-02');
  assert.equal(result.bodyFat[0].value, 21);

  assert.ok(result.warnings.includes('Skipped a food log row with unknown meal "Mystery Meal".'));
  assert.ok(result.warnings.includes('Skipped a food log row with a blank name.'));
  assert.ok(result.warnings.includes('Skipped a row with an invalid date "bad-date".'));
  assert.ok(result.warnings.includes('Skipped "Steak" on 2025-01-03 because calories are missing.'));
  assert.ok(result.warnings.includes('Skipped a weight entry on 2025-01-03 because the value is invalid.'));
});

test('parseLoseItExport throws when food and weight CSVs are missing', () => {
  const buffer = buildZipBuffer([{ name: 'profile.csv', contents: 'Name,Value\nPlan,Weight Loss' }]);
  assert.throws(
    () => parseLoseItExport(buffer),
    /Export is missing food-logs\.csv and weights\.csv\./
  );
});

test('inferLoseItWeightUnit uses profile hints, then height heuristics, then fallback', () => {
  assert.deepEqual(inferLoseItWeightUnit({ Plan: 'Plan (kg)' }, 'LB'), {
    unit: 'KG',
    source: 'profile'
  });
  assert.deepEqual(inferLoseItWeightUnit({ Plan: 'Weight Loss lb' }, 'KG'), {
    unit: 'LB',
    source: 'profile'
  });
  assert.deepEqual(inferLoseItWeightUnit({ Height: '180' }, 'LB'), {
    unit: 'KG',
    source: 'heuristic'
  });
  assert.deepEqual(inferLoseItWeightUnit({ Height: '72' }, 'KG'), {
    unit: 'LB',
    source: 'heuristic'
  });
  assert.deepEqual(inferLoseItWeightUnit({ Height: 'N/A' }, 'KG'), {
    unit: 'KG',
    source: 'fallback'
  });
});

test('partitionLoseItWeightImportsByAsOfDate excludes future local dates', () => {
  const weights = ['2026-07-10', '2026-07-11', '2026-07-12'].map((localDate, index) => ({
    localDate,
    localDateValue: new Date(`${localDate}T00:00:00.000Z`),
    weightValue: 80 - index,
    lastUpdated: null
  }));

  const result = partitionLoseItWeightImportsByAsOfDate(
    weights,
    new Date('2026-07-11T00:00:00.000Z')
  );

  assert.deepEqual(result.eligible.map((entry) => entry.localDate), ['2026-07-10', '2026-07-11']);
  assert.deepEqual(result.future.map((entry) => entry.localDate), ['2026-07-12']);
});

test('buildImportTimestamp uses midday UTC without mutating inputs', () => {
  const localDateValue = new Date('2025-01-02T00:00:00.000Z');
  const timestamp = buildImportTimestamp(localDateValue);

  assert.equal(timestamp.toISOString(), '2025-01-02T12:00:00.000Z');
  assert.equal(localDateValue.toISOString(), '2025-01-02T00:00:00.000Z');
});
