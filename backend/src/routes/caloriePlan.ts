import express from 'express';
import { evaluateCaloriePlan } from '../../../shared/caloriePolicy';
import { getAuthenticatedUser, requireAuthenticatedUser } from '../middleware/authenticatedUser';
import { isActivityLevel, isSex } from '../utils/profile';
import { parseWeightToGrams } from '../utils/units';

const router = express.Router();
router.use(requireAuthenticatedUser);

type DraftParseResult = {
  ok: true;
  value: {
    timezone: string;
    dateOfBirth: string | null;
    sex: 'MALE' | 'FEMALE' | null;
    activityLevel: 'SEDENTARY' | 'LIGHT' | 'MODERATE' | 'ACTIVE' | 'VERY_ACTIVE' | null;
    heightMm: number | null;
    weightGrams: number | null;
  };
} | { ok: false; field: string; message: string };

const finiteNumber = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function parseDraft(body: unknown): DraftParseResult {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, field: 'body', message: 'A calorie plan draft is required.' };
  const record = body as Record<string, unknown>;
  if (typeof record.timezone !== 'string') return { ok: false, field: 'timezone', message: 'Timezone is required.' };
  if (!(record.date_of_birth === null || typeof record.date_of_birth === 'string')) return { ok: false, field: 'date_of_birth', message: 'Date of birth is invalid.' };
  if (!(record.sex === null || record.sex === '' || isSex(record.sex))) return { ok: false, field: 'sex', message: 'Sex is invalid.' };
  if (!(record.activity_level === null || record.activity_level === '' || isActivityLevel(record.activity_level))) {
    return { ok: false, field: 'activity_level', message: 'Activity level is invalid.' };
  }
  if (!record.height || typeof record.height !== 'object' || Array.isArray(record.height)) return { ok: false, field: 'height', message: 'Height is required.' };
  const height = record.height as Record<string, unknown>;
  let heightMm: number | null = null;
  if (height.unit === 'CM') {
    const centimeters = finiteNumber(height.centimeters);
    if (centimeters !== null) heightMm = Math.round(centimeters * 10);
  } else if (height.unit === 'FT_IN') {
    const feet = finiteNumber(height.feet);
    const inches = finiteNumber(height.inches);
    if (feet !== null && inches !== null) heightMm = Math.round((feet * 12 + inches) * 25.4);
  } else return { ok: false, field: 'height.unit', message: 'Height unit is invalid.' };

  if (!record.weight || typeof record.weight !== 'object' || Array.isArray(record.weight)) return { ok: false, field: 'weight', message: 'Weight is required.' };
  const weight = record.weight as Record<string, unknown>;
  if (weight.unit !== 'KG' && weight.unit !== 'LB') return { ok: false, field: 'weight.unit', message: 'Weight unit is invalid.' };
  let weightGrams: number | null;
  try { weightGrams = parseWeightToGrams(weight.value, weight.unit); } catch { weightGrams = null; }

  return {
    ok: true,
    value: {
      timezone: record.timezone,
      dateOfBirth: record.date_of_birth,
      sex: isSex(record.sex) ? record.sex : null,
      activityLevel: isActivityLevel(record.activity_level) ? record.activity_level : null,
      heightMm,
      weightGrams
    }
  };
}

router.post('/options', (req, res) => {
  getAuthenticatedUser(req);
  const parsed = parseDraft(req.body);
  if (!parsed.ok) {
    return res.status(400).json({
      message: 'Invalid calorie plan draft',
      code: 'INVALID_REQUEST',
      retryable: false,
      field_errors: { [parsed.field]: [parsed.message] }
    });
  }
  const evaluation = evaluateCaloriePlan({
    profile: {
      timezone: parsed.value.timezone,
      dateOfBirth: parsed.value.dateOfBirth,
      sex: parsed.value.sex,
      activityLevel: parsed.value.activityLevel,
      heightMm: parsed.value.heightMm
    },
    latestWeightGrams: parsed.value.weightGrams
  });
  return res.json({
    eligibility: evaluation.eligibility,
    bmr: evaluation.bmr,
    tdee: evaluation.tdee,
    minimumDailyCalorieTarget: evaluation.minimumDailyCalorieTarget,
    planOptions: evaluation.planOptions
  });
});

export default router;
