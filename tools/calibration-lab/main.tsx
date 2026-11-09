/** @file Synthetic progress preview with historical calibration diagnostics; no live accounts or target changes. */

import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { CalibrationInput, CalibrationResult } from '@calibrate/shared/calibration';
import type { CalibrationStatusResponse, PlanCheckResponse } from '@calibrate/api-client';
import { summarizeTracking } from '../../backend/src/services/planCheckSummary';
import { PlanCheckCardView } from '../../mobile/src/components/PlanCheckCardView';
import {
    applyPreviewRecommendation,
    buildPreviewStatus,
} from './status.mjs';

type CalibrationScenario = {
    id: string;
    name: string;
    description: string;
    input: CalibrationInput;
    previewState?: 'scheduled';
};

function LabApp() {
    const [scenarios, setScenarios] = useState<CalibrationScenario[]>([]);
    const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(null);
    const [description, setDescription] = useState('Loading preset histories...');
    const [historyInput, setHistoryInput] = useState('');
    const [status, setStatus] = useState<CalibrationStatusResponse>();
    const [summary, setSummary] = useState<PlanCheckResponse>();
    const [error, setError] = useState<Error | null>(null);
    const [isEvaluating, setIsEvaluating] = useState(false);

    const rawOutput = useMemo(
        () => status ? JSON.stringify(status.evaluation, null, 2) : 'Waiting for an evaluation...',
        [status]
    );

    async function evaluate(json: string, fingerprint: string, previewState?: CalibrationScenario['previewState']) {
        setIsEvaluating(true);
        setError(null);
        try {
            const input = JSON.parse(json) as CalibrationInput;
            const dates = [...input.foodDays.map(day => day.date), ...input.weightPoints.map(point => point.date)].sort();
            setSummary({
                ...summarizeTracking({
                    localDate: new Date(input.asOfDate), trackingSince: dates[0] ? new Date(dates[0]) : null,
                    weightUnit: input.weightUnit, weights: input.weightPoints.map(point => ({ date: new Date(point.date), weight_grams: point.weightKg * 1000 })),
                    food: input.foodDays.filter(day => day.entryCount > 0).map(day => ({ local_date: new Date(day.date), calories: day.calories })),
                    days: input.foodDays.filter(day => day.isComplete).map(day => ({ local_date: new Date(day.date), status: 'COMPLETE' }))
                }), weeklyReports: [], weeklyReportsEnabled: false
            });
            const response = await fetch('/api/evaluate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(input)
            });
            const body = await response.json() as CalibrationResult | { message?: string };
            if (!response.ok) {
                throw new Error('message' in body && body.message ? body.message : 'Unable to evaluate history.');
            }
            const nextStatus = buildPreviewStatus(body as CalibrationResult, fingerprint);
            setStatus(previewState === 'scheduled' && nextStatus.recommendation
                ? applyPreviewRecommendation(nextStatus, nextStatus.recommendation.id)
                : nextStatus);
        } catch (nextError) {
            setError(nextError instanceof Error ? nextError : new Error('Invalid calibration history.'));
        } finally {
            setIsEvaluating(false);
        }
    }

    function selectScenario(scenarioId: string, availableScenarios = scenarios) {
        const scenario = availableScenarios.find((candidate) => candidate.id === scenarioId);
        if (!scenario) return;
        const json = JSON.stringify(scenario.input, null, 2);
        setSelectedScenarioId(scenario.id);
        setDescription(scenario.description);
        setHistoryInput(json);
        const url = new URL(window.location.href);
        url.searchParams.set('scenario', scenario.id);
        window.history.replaceState(null, '', url);
        void evaluate(json, `lab-${scenario.id}`, scenario.previewState);
    }

    useEffect(() => {
        void (async () => {
            try {
                const response = await fetch('/api/scenarios');
                const nextScenarios = await response.json() as CalibrationScenario[];
                setScenarios(nextScenarios);
                const requestedScenario = new URLSearchParams(window.location.search).get('scenario');
                const initialScenario = nextScenarios.some((scenario) => scenario.id === requestedScenario)
                    ? requestedScenario
                    : nextScenarios[0]?.id;
                if (initialScenario) selectScenario(initialScenario, nextScenarios);
            } catch (nextError) {
                setError(nextError instanceof Error ? nextError : new Error('Unable to load preset histories.'));
            }
        })();
    }, []);

    function updateHistoryInput(value: string) {
        setHistoryInput(value);
        setSelectedScenarioId(null);
        setDescription('Custom JSON input. Select a preset to restore a known history.');
        const url = new URL(window.location.href);
        url.searchParams.delete('scenario');
        window.history.replaceState(null, '', url);
    }

    return (
        <main>
            <header>
                <div>
                    <span className="eyebrow">Development tool</span>
                    <h1>Calibration history lab</h1>
                    <p>Preview descriptive progress summaries from synthetic tracking histories. Retired calibration results remain below for historical diagnostics.</p>
                </div>
                <div className="scenario-control">
                    <label htmlFor="preset-history">Preset history</label>
                    <select
                        id="preset-history"
                        value={selectedScenarioId ?? ''}
                        onChange={(event) => selectScenario(event.target.value)}
                    >
                        {selectedScenarioId === null && <option value="">Custom history</option>}
                        {scenarios.map((scenario) => (
                            <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
                        ))}
                    </select>
                    <span className="scenario-description">{description}</span>
                </div>
            </header>

            <section className="preview-panel" aria-labelledby="preview-title">
                <div className="preview-heading">
                    <div>
                        <span className="eyebrow">Shared product component</span>
                        <h2 id="preview-title">End-user preview</h2>
                        <p>This is the descriptive Plan check shown on Progress. Edit the history to explore duration, sparse logging and stale weigh-ins.</p>
                    </div>
                    <span className="preview-state">{isEvaluating ? 'Evaluating...' : 'Live preview'}</span>
                </div>
                <div className="product-preview">
                    <SafeAreaProvider>
                        <PlanCheckCardView status={summary} isLoading={isEvaluating && !summary} />
                    </SafeAreaProvider>
                </div>
            </section>

            <section className="workspace" aria-label="Calibration developer diagnostics">
                <article className="panel editor">
                    <div className="panel-heading">
                        <div>
                            <h2>History input</h2>
                            <p>Edit a preset directly, then evaluate it to refresh the product preview.</p>
                        </div>
                        <button
                            type="button"
                            disabled={isEvaluating}
                            onClick={() => void evaluate(
                                historyInput,
                                `lab-${selectedScenarioId ?? 'custom'}`,
                                scenarios.find((scenario) => scenario.id === selectedScenarioId)?.previewState
                            )}
                        >
                            {isEvaluating ? 'Evaluating...' : 'Evaluate history'}
                        </button>
                    </div>
                    {error && <div className="error" role="alert">{error.message}</div>}
                    <textarea
                        aria-label="Calibration history JSON"
                        value={historyInput}
                        spellCheck={false}
                        onChange={(event) => updateHistoryInput(event.target.value)}
                    />
                </article>

                <article className="panel result">
                    <div className="panel-heading">
                        <div>
                            <h2>Evaluator output</h2>
                            <p>Raw deterministic output for debugging intervals, assumptions, and evidence classification.</p>
                        </div>
                    </div>
                    <pre>{rawOutput}</pre>
                </article>
            </section>
        </main>
    );
}

const root = document.getElementById('root');
if (!root) throw new Error('Calibration lab root was not found.');
createRoot(root).render(<LabApp />);
