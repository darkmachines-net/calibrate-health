/** @file Regression coverage for weight trend v1: computeWeightTrendV1: reproduces the retired scalar Kalman output. */

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeWeightTrendV1 } = require('../src/services/weightTrendV1');

function round(value) {
  return Number(value.toFixed(6));
}

test('computeWeightTrendV1: reproduces the retired scalar Kalman output', () => {
  const dates = ['2025-01-01', '2025-01-02', '2025-01-04', '2025-01-07', '2025-01-08', '2025-01-12'];
  const weights = [80, 79.8, 80.1, 79.6, 79.7, 79.3];
  const observations = dates.map((date, index) => ({
    date: new Date(`${date}T00:00:00.000Z`),
    weight: weights[index]
  }));

  const result = computeWeightTrendV1(observations);
  const snapshot = {
    weeklyRate: round(result.weeklyRate),
    volatility: result.volatility,
    params: Object.fromEntries(
      Object.entries(result.params).map(([key, value]) => [key, round(value)])
    ),
    points: result.points.map((point) => ({
      date: point.date.toISOString().slice(0, 10),
      weight: point.weight,
      trendWeight: round(point.trendWeight),
      trendStd: round(point.trendStd),
      lower95: round(point.lower95),
      upper95: round(point.upper95)
    }))
  };

  assert.deepEqual(snapshot, {
    weeklyRate: -0.40825,
    volatility: 'low',
    params: {
      driftPerDay: -0.061025,
      processVariance: 0.0004,
      measurementVariance: 0.0625
    },
    points: [
      {
        date: '2025-01-01',
        weight: 80,
        trendWeight: 80,
        trendStd: 0.176777,
        lower95: 79.653518,
        upper95: 80.346482
      },
      {
        date: '2025-01-02',
        weight: 79.8,
        trendWeight: 79.892257,
        trendStd: 0.144949,
        lower95: 79.608156,
        upper95: 80.176358
      },
      {
        date: '2025-01-04',
        weight: 80.1,
        trendWeight: 79.855522,
        trendStd: 0.127154,
        lower95: 79.6063,
        upper95: 80.104744
      },
      {
        date: '2025-01-07',
        weight: 79.6,
        trendWeight: 79.656693,
        trendStd: 0.116582,
        lower95: 79.428193,
        upper95: 79.885194
      },
      {
        date: '2025-01-08',
        weight: 79.7,
        trendWeight: 79.614752,
        trendStd: 0.106921,
        lower95: 79.405187,
        upper95: 79.824318
      },
      {
        date: '2025-01-12',
        weight: 79.3,
        trendWeight: 79.358464,
        trendStd: 0.103844,
        lower95: 79.154929,
        upper95: 79.561998
      }
    ]
  });
});
