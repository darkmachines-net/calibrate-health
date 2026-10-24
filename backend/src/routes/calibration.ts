/** @file Authenticated calibration assessment, recommendation acceptance, and scheduled-change cancellation endpoints. */

import express from 'express';
import { parsePositiveInteger } from '../utils/requestParsing';
import { ClientOperationConflictError, parseClientOperationId } from '../services/clientOperations';
import {
    applyCalibrationRecommendation,
    buildCalibrationStatus,
    cancelScheduledCalibrationChange,
    CalibrationConflictError
} from '../services/calibration';

const router = express.Router();

router.use((req, res, next) => {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ message: 'Not authenticated' });
});

router.get('/status', async (req, res) => {
    const user = req.user as { id: number };
    try {
        return res.json(await buildCalibrationStatus(user.id));
    } catch (error) {
        if (error instanceof CalibrationConflictError) {
            return res.status(409).json({ message: error.message });
        }
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/recommendations/:id/apply', async (req, res) => {
    const user = req.user as { id: number };
    const recommendationId = parsePositiveInteger(req.params.id);
    if (recommendationId === null) {
        return res.status(400).json({ message: 'Invalid recommendation id' });
    }
    const operationId = parseClientOperationId(
        req.get('x-client-operation-id') ?? req.headers['x-client-operation-id']
    );
    if (operationId === null) {
        return res.status(400).json({ message: 'Invalid x-client-operation-id' });
    }

    try {
        return res.json(await applyCalibrationRecommendation({ userId: user.id, recommendationId, operationId }));
    } catch (error) {
        if (error instanceof CalibrationConflictError) {
            return res.status(409).json({ message: error.message });
        }
        if (error instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: error.message,
                code: error.code,
                retryable: error.code === 'OPERATION_IN_PROGRESS'
            });
        }
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/recommendations/:id/cancel', async (req, res) => {
    const user = req.user as { id: number };
    const recommendationId = parsePositiveInteger(req.params.id);
    if (recommendationId === null) {
        return res.status(400).json({ message: 'Invalid recommendation id' });
    }
    const operationId = parseClientOperationId(
        req.get('x-client-operation-id') ?? req.headers['x-client-operation-id']
    );
    if (operationId === null) {
        return res.status(400).json({ message: 'Invalid x-client-operation-id' });
    }

    try {
        return res.json(await cancelScheduledCalibrationChange({ userId: user.id, recommendationId, operationId }));
    } catch (error) {
        if (error instanceof CalibrationConflictError) {
            return res.status(409).json({ message: error.message });
        }
        if (error instanceof ClientOperationConflictError) {
            return res.status(409).json({
                message: error.message,
                code: error.code,
                retryable: error.code === 'OPERATION_IN_PROGRESS'
            });
        }
        return res.status(500).json({ message: 'Server error' });
    }
});

export default router;
