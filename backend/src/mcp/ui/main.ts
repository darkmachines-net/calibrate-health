/** @file Focused, single-view progress explorer with optional detail and contextual host-chat actions. */
import { App, applyHostStyleVariables, type McpUiHostContext } from '@modelcontextprotocol/ext-apps';
import { calibrateDesignTokens } from '../../../../shared/designTokens';
import type { ProgressComparisonSnapshot, ProgressExplorerSnapshot, ProgressFoodGroup, ProgressPeriodSummary, ProgressRange } from '../progressTypes';
import { foodChart, weightChart } from './charts';
import { contextualQuestion, escapeHtml as e, label, number, readRange, shiftDate } from './presentation';

const app = new App({ name: 'Calibrate Progress Explorer', version: '1.1.0' }, {}, { strict: true, autoResize: true });
const root = document.querySelector<HTMLElement>('#app')!;
const content = document.querySelector<HTMLElement>('#content')!;
const status = document.querySelector<HTMLElement>('#status')!;
let snapshot: ProgressExplorerSnapshot | undefined;
let comparison: ProgressComparisonSnapshot | undefined;
let connected = false;
let busy = false;
let sending = false;
let fallbackQuestion = '';
let expanded = false;
let requestSequence = 0;
let periodMode = '90';
type View = 'weight' | 'food' | 'compare';
let activeView: View = 'weight';
// Preserve disclosures through host updates and loading renders without expanding the default view.
const openDetails = new Set<string>();

/** Announce host operations and failures through the live region without replacing the current data view. */
function setStatus(text: string, error = false): void {
  status.textContent = text;
  status.classList.toggle('error', error);
}

/** Merge partial host theme/display updates with retained state; fall back to the system theme before connection. */
function applyTheme(context?: Partial<McpUiHostContext>): void {
  if (context?.displayMode) expanded = context.displayMode === 'fullscreen';
  const retainedTheme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const initialTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const theme = context?.theme ?? (document.documentElement.dataset.theme ? retainedTheme : initialTheme);
  const colors = calibrateDesignTokens.schemes[theme];
  const variables = {
    page: colors.background, ink: colors.onBackground, muted: colors.onSurfaceVariant,
    surface: colors.surface, outline: colors.outlineVariant, accent: colors.primary,
    'on-accent': colors.onPrimary, summary: colors.summaryContainer, 'summary-outline': colors.summaryOutline,
    hover: colors.surfaceHovered, focus: colors.focusRing, danger: colors.danger
  };
  for (const [name, value] of Object.entries(variables)) document.documentElement.style.setProperty(`--${name}`, value);
  document.documentElement.style.setProperty('--action-height', `${calibrateDesignTokens.interaction.minimumTouchTarget}px`);
  document.documentElement.style.setProperty('--space', `${calibrateDesignTokens.spacing.small}px`);
  document.documentElement.style.setProperty('--space-medium', `${calibrateDesignTokens.spacing.medium}px`);
  document.documentElement.style.setProperty('--space-large', `${calibrateDesignTokens.spacing.large}px`);
  document.documentElement.style.setProperty('--space-extra-large', `${calibrateDesignTokens.spacing.extraLarge}px`);
  document.documentElement.style.setProperty('--section-space', `${calibrateDesignTokens.spacing.jumbo}px`);
  document.documentElement.style.colorScheme = theme;
  document.documentElement.dataset.theme = theme;
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  const expand = document.getElementById('expand-view');
  if (expand) expand.textContent = expanded ? 'Exit expanded view' : 'Expand view';
}

/** Render escaped summary text; callers supply already formatted values and optional evidence context. */
function metric(title: string, value: string, detail?: string): string {
  return `<div class="metric"><span>${e(title)}</span><strong>${e(value)}</strong>${detail ? `<small>${e(detail)}</small>` : ''}</div>`;
}

/** Show actual-current goal context beside historical data, omitting percentage progress for maintenance. */
function goalSection(data: ProgressExplorerSnapshot): string {
  const goal = data.current_goal;
  if (!data.granted_sections.weight) return '<section class="goal"><h2>Your goal</h2><p class="notice">Weight and goal access was not granted for this connection.</p></section>';
  if (!goal) return '<section class="goal"><h2>Your goal</h2><p class="notice">No current goal is configured. You can still explore your recorded history.</p></section>';
  const progress = goal.progress_percent === null || goal.direction === 'maintenance' ? '' : `<progress max="100" value="${Math.min(100, Math.max(0, goal.progress_percent))}" aria-label="Progress from goal start to target"></progress>`;
  let caption = '';
  if (goal.direction === 'maintenance') caption = 'Maintenance';
  else if (goal.progress_percent !== null) caption = `${number(goal.progress_percent)}% of the way`;
  return `<section class="goal" aria-label="Current goal"><div class="goal-line"><span>Current goal</span><strong>${number(goal.target_weight, 1)} ${goal.weight_unit}</strong><span>${e(caption)}</span></div>${progress}</section>`;
}

/** Render selected-period observations and model evidence separately, with an explicit stale-evidence notice. */
function weightSection(data: ProgressExplorerSnapshot): string {
  if (!data.weight) return '<section><h2>Weight history</h2><p class="notice">Weight access is not available for this connection.</p></section>';
  const weight = data.weight;
  const trend = weight.trend;
  return `<section aria-label="Weight history"><div class="metrics">${metric('Observed change', weight.period_summary.raw_weight_change === null ? 'Unavailable' : `${number(weight.period_summary.raw_weight_change, 2)} ${weight.weight_unit}`, `${weight.period_summary.observation_count} observations`)}${metric('Latest in period', weight.period_summary.last_observation ? `${number(weight.period_summary.last_observation.weight, 1)} ${weight.weight_unit}` : 'Unavailable', weight.period_summary.last_observation?.date)}</div>
    <div id="weight-chart">${weightChart(weight, data.range)}</div>
    ${trend.freshness !== 'current' ? `<p class="notice">Model evidence is ${e(trend.freshness)} as of ${trend.as_of_date}; a current pace is unavailable.</p>` : ''}
    ${goalSection(data)}</section>`;
}

/** Keep goal projections and model evidence available behind a single disclosure, separate from observed values. */
function weightDetails(data: ProgressExplorerSnapshot): string {
  if (activeView !== 'weight') return '';
  const goal = data.current_goal;
  let details = '';
  if (goal) {
    let projection = 'A projection is not available for the current plan.';
    if (goal.direction === 'maintenance') projection = 'Maintenance focuses on stability over time.';
    else if (goal.projection_status === 'reached') projection = 'Your current goal has been reached.';
    else if (goal.projected_end_date) projection = `Steady-rate plan projection: ${goal.projected_end_date}. This is a plan estimate, not a prediction from your observed trend.`;
    details += `<p>Current goal as of ${data.as_of_date}: ${number(goal.start_weight, 1)} to ${number(goal.target_weight, 1)} ${goal.weight_unit}. Latest observation: ${number(goal.current_weight, 1)} ${goal.weight_unit}${goal.current_weight_date ? ` on ${goal.current_weight_date}` : ''}.</p><p>${e(projection)}</p>`;
  }
  const weight = data.weight;
  if (!weight) return details;
  const trend = weight.trend;
  const rate = trend.weekly_rate;
  const currentRate = trend.freshness === 'current' && rate !== null;
  const paceLabel = data.range.end_date === data.as_of_date ? 'Current modeled pace' : 'Modeled pace at period end';
  const modelLabel = `${label(trend.evidence_status)} evidence | ${label(trend.freshness)} | Last observation ${trend.latest_observation_date ?? 'unavailable'} | Evaluated ${trend.as_of_date}`;
  return `${details}<p>Raw points are scale observations. The line and shaded interval are model estimates; historical points outside the model window remain observations only.</p><div class="metrics">${metric('Latest modeled weight', trend.latest_trend ? `${number(trend.latest_trend.weight, 1)} ${weight.weight_unit}` : 'Unavailable', modelLabel)}${metric(paceLabel, currentRate ? `${number(rate.estimate, 2)} ${rate.unit}` : 'Unavailable', currentRate ? `95% interval ${number(rate.lower, 2)} to ${number(rate.upper, 2)}` : 'Needs fresh, sufficient evidence')}</div>`;
}

/** Display server-aggregated COMPLETE-day averages with their sample counts and escaped group labels. */
function patterns(title: string, groups: ProgressFoodGroup[]): string {
  return `<div><h3>${e(title)}</h3>${groups.map((group) => `<div class="pattern"><span>${e(label(group.key))}<br><small>${group.complete_day_count} complete days</small></span><strong>${number(group.average_daily_calories_kcal)}${group.average_daily_calories_kcal === null ? '' : ' kcal'}</strong></div>`).join('')}</div>`;
}

/** Present COMPLETE-day intake and saved-target coverage; defer logging and meal detail to disclosures. */
function foodSection(data: ProgressExplorerSnapshot): string {
  if (!data.food) return '<section><h2>Food and patterns</h2><p class="notice">Food access is not available for this connection.</p></section>';
  const food = data.food;
  const summary = food.summary;
  const currentTarget = data.current_calorie_plan.current_daily_target_kcal;
  return `<section aria-label="Intake history"><div class="metrics">${metric('Complete-day average', summary.average_daily_calories_kcal === null ? 'Unavailable' : `${number(summary.average_daily_calories_kcal)} kcal`, `${summary.complete_day_count} of ${data.range.day_count} days complete`)}${metric('Versus saved targets', summary.average_target_difference_kcal === null ? 'Unavailable' : `${number(summary.average_target_difference_kcal)} kcal/day`, `${summary.compared_day_count} days with target evidence`)}</div>
    <div id="food-chart">${foodChart(food, data.range)}</div><p class="range-details">Averages use complete days only. Missing or partial logging does not mean low intake.</p>
    <details id="food-details"><summary>Logging and target details</summary><p class="range-details">${summary.open_day_count} open | ${summary.incomplete_day_count} incomplete | ${summary.paused_day_count} paused | ${summary.before_tracking_day_count} before tracking. Target comparisons use saved daily targets, never today's plan.</p><p class="range-details">Current daily target: ${number(currentTarget)} kcal as of ${data.current_calorie_plan.as_of_date ?? data.as_of_date}.</p></details>
    <details id="food-patterns"><summary>Weekday and meal patterns</summary><div class="pattern-list">${patterns('Weekday averages', food.patterns.weekdays)}${patterns('Week parts', food.patterns.week_parts)}${patterns('Meal-period averages', food.patterns.meal_periods)}</div><p class="range-details">Complete-day averages describe logged calories, not cause and effect.</p></details></section>`;
}

/** Summarize one comparison period with its exact dates and denominators; unavailable evidence stays explicit. */
function periodSummary(period: ProgressPeriodSummary, title: string): string {
  const food = period.food?.summary;
  const weight = period.weight;
  return `<div><h3>${e(title)}</h3><small>${period.range.start_date} through ${period.range.end_date}</small><div class="metrics">${metric('Average intake', food?.average_daily_calories_kcal == null ? 'Unavailable' : `${number(food.average_daily_calories_kcal)} kcal/day`, food ? `${food.complete_day_count} complete days` : 'Food access unavailable')}${metric('Observed weight change', weight?.period_summary.raw_weight_change == null ? 'Unavailable' : `${number(weight.period_summary.raw_weight_change, 2)} ${weight.weight_unit}`, weight ? `${weight.period_summary.observation_count} observations` : 'Weight access unavailable')}</div></div>`;
}

/** Render both fetched periods without inventing results before a successful comparison request. */
function renderComparison(): string {
  if (!comparison) return '';
  return `<div class="comparison-grid">${periodSummary(comparison.first, 'Selected period')}${periodSummary(comparison.second, 'Comparison period')}</div>
    <p class="range-details">Compare coverage as well as numbers. Differences do not establish causes; raw changes include scale variation.</p>`;
}

/** Render just the chosen data view; other charts and analysis stay out of the reading flow. */
function selectedView(data: ProgressExplorerSnapshot, disabled: string): string {
  if (activeView === 'weight') return weightSection(data);
  if (activeView === 'food') return foodSection(data);
  return `<section aria-label="Period comparison"><form id="comparison-form"><div class="range-row"><label>Compare with<select id="comparison-mode"${disabled}><option value="previous">Previous equal period</option><option value="custom">Custom dates</option></select></label><button id="compare-periods" type="submit"${disabled}>Compare</button></div><div id="comparison-dates" class="range-row"${comparison ? '' : ' hidden'}><label>Comparison from<input id="compare-start" type="date" value="${comparison?.second.range.start_date ?? shiftDate(data.range.start_date, -data.range.day_count)}" max="${data.as_of_date}" required${disabled}></label><label>Comparison through<input id="compare-end" type="date" value="${comparison?.second.range.end_date ?? shiftDate(data.range.start_date, -1)}" max="${data.as_of_date}" required${disabled}></label></div></form>
    <div id="comparison-result">${comparison ? renderComparison() : '<p class="comparison-empty muted">See intake and weight change side by side for two periods.</p>'}</div></section>`;
}

/** Offer two view-specific questions, disabling comparison prompts until evidence has been loaded. */
function chatPrompts(): string {
  const prompts = {
    weight: [['Goal progress', 'How am I progressing toward my goal?'], ['Discuss trend', 'Help me understand my weight trend and the uncertainty around it.']],
    food: [['Explore patterns', 'What patterns stand out in my logged eating and tracking consistency?'], ['Intake versus target', 'How does my intake compare with my saved targets on complete days?']],
    compare: [['Discuss this comparison', 'Compare these periods. What changed, and how confident can we be given the logging and weight evidence?'], ['What changed?', 'What changed in my progress during this period?']]
  };
  return prompts[activeView].map(([title, question], index) => `<button id="chat-${index}" class="question" data-question="${e(question)}"${busy || sending || (activeView === 'compare' && !comparison) ? ' disabled' : ''}>${e(title)}</button>`).join('');
}

/** Rebuild the selected view from retained state, restore disclosure state, and bind only its visible workflow. */
function render(): void {
  if (!snapshot) return;
  const data = snapshot;
  root.setAttribute('aria-busy', String(busy));
  const disabled = !connected || busy || sending || !app.getHostCapabilities()?.serverTools ? ' disabled' : '';
  const expand = app.getHostContext()?.availableDisplayModes?.includes('fullscreen')
    ? `<button id="expand-view" type="button">${expanded ? 'Exit expanded view' : 'Expand view'}</button>` : '';
  const history = [data.available_history.food?.first_date, data.available_history.weight?.first_date].filter(Boolean).sort()[0];
  content.innerHTML = `<div class="toolbar"><div class="view-switch" role="group" aria-label="Data view">${([['weight', 'Weight'], ['food', 'Intake'], ['compare', 'Compare']] as const).map(([view, title]) => `<button id="view-${view}" data-view="${view}" aria-pressed="${activeView === view}"${busy || sending ? ' disabled' : ''}>${title}</button>`).join('')}</div><select id="period" aria-label="Period"${disabled}><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 365 days</option><option value="custom">Custom dates</option></select></div>
    <details id="period-details"><summary>${data.range.start_date} - ${data.range.end_date}</summary><form id="range-form"><div class="range-row"><label>From<input id="start-date" type="date" value="${data.range.start_date}" max="${data.as_of_date}" required${disabled}></label><label>Through<input id="end-date" type="date" value="${data.range.end_date}" max="${data.as_of_date}" required${disabled}></label><button id="apply-period" type="submit"${disabled}>Apply period</button></div></form><div class="period-navigation"><button id="previous-period"${disabled}>Previous period</button><button id="next-period"${disabled || (data.range.end_date >= data.as_of_date ? ' disabled' : '')}>Next period</button><button id="refresh" type="button"${disabled}>Refresh</button>${expand}</div><p class="range-details">${e(data.timezone)}${history ? ` | History from ${history}` : ''}. Up to 365 days per view.</p></details>
    ${selectedView(data, disabled)}
    <section class="chat-section" aria-label="Explore in chat"><p class="chat-label">Explore in chat</p><div class="questions">${chatPrompts()}</div><div id="chat-fallback" class="fallback"${fallbackQuestion ? '' : ' hidden'}><p class="notice">This host could not add the question to chat. Select and copy it into the conversation.</p><textarea id="fallback-question" rows="5" readonly aria-label="Question to copy into chat">${e(fallbackQuestion)}</textarea></div></section>
    <details id="reading-notes"><summary>About this data</summary>${weightDetails(data)}<ul>${data.interpretation_notes.map((note) => `<li>${e(note)}</li>`).join('')}</ul><p>Calories out is the profile-estimated TDEE: ${number(data.current_calorie_plan.profile_estimated_tdee_kcal)} kcal/day, not an estimate from logged intake or weight.</p></details>`;
  input<HTMLSelectElement>('period').value = periodMode;
  if (comparison && activeView === 'compare') {
    input<HTMLSelectElement>('comparison-mode').value = 'custom';
    input<HTMLInputElement>('compare-start').value = comparison.second.range.start_date;
    input<HTMLInputElement>('compare-end').value = comparison.second.range.end_date;
  }
  for (const details of content.querySelectorAll<HTMLDetailsElement>('details[id]')) {
    details.open = openDetails.has(details.id);
    details.addEventListener('toggle', () => {
      if (!details.isConnected) return;
      if (details.open) openDetails.add(details.id);
      else openDetails.delete(details.id);
    });
  }
  bindControls();
}

/** Resolve an element guaranteed by the current template; callers must guard controls belonging to other views. */
function input<T extends HTMLElement = HTMLInputElement>(id: string): T {
  return document.getElementById(id) as T;
}

/** Wire user gestures to local view changes and host operations; rendering alone never sends a chat message. */
function bindControls(): void {
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-question]')) {
    button.addEventListener('click', () => { void ask(button.dataset.question!, button.id); });
  }
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    button.addEventListener('click', () => {
      activeView = button.dataset.view as View;
      fallbackQuestion = '';
      render(); setStatus(''); restoreControlFocus(button.id);
    });
  }
  input<HTMLButtonElement>('previous-period').addEventListener('click', () => {
    const range = snapshot!.range;
    void refresh(readRange(shiftDate(range.start_date, -range.day_count), shiftDate(range.start_date, -1), snapshot!.as_of_date), 'previous-period');
  });
  input<HTMLButtonElement>('next-period').addEventListener('click', () => {
    const range = snapshot!.range;
    const end = shiftDate(range.end_date, range.day_count);
    void refresh(readRange(shiftDate(range.end_date, 1), end > snapshot!.as_of_date ? snapshot!.as_of_date : end, snapshot!.as_of_date), 'next-period');
  });
  document.getElementById('expand-view')?.addEventListener('click', () => {
    const mode = expanded ? 'inline' : 'fullscreen';
    void app.requestDisplayMode({ mode }).then((result) => {
      expanded = result.mode === 'fullscreen';
      input<HTMLButtonElement>('expand-view').textContent = result.mode === 'fullscreen' ? 'Exit expanded view' : 'Expand view';
    }).catch(() => { setStatus('The host could not expand this view. All exploration controls remain available here.'); });
  });
  input<HTMLSelectElement>('period').addEventListener('change', () => {
    periodMode = input<HTMLSelectElement>('period').value;
    if (periodMode !== 'custom' && snapshot) {
      openDetails.delete('period-details');
      void refresh(readRange(shiftDate(snapshot.as_of_date, 1 - Number(periodMode)), snapshot.as_of_date, snapshot.as_of_date), 'period');
    } else {
      openDetails.add('period-details');
      input<HTMLDetailsElement>('period-details').open = true;
      input<HTMLInputElement>('start-date').focus();
    }
  });
  for (const id of ['start-date', 'end-date']) input<HTMLInputElement>(id).addEventListener('change', () => {
    periodMode = 'custom'; input<HTMLSelectElement>('period').value = periodMode;
  });
  input<HTMLFormElement>('range-form').addEventListener('submit', (event) => {
    event.preventDefault();
    try { void refresh(readRange(input<HTMLInputElement>('start-date').value, input<HTMLInputElement>('end-date').value, snapshot!.as_of_date), 'apply-period'); }
    catch (error) { setStatus((error as Error).message, true); }
  });
  input<HTMLButtonElement>('refresh').addEventListener('click', () => { void refresh(snapshot!.range); });
  if (activeView !== 'compare') return;
  input<HTMLSelectElement>('comparison-mode').addEventListener('change', () => {
    input<HTMLElement>('comparison-dates').hidden = input<HTMLSelectElement>('comparison-mode').value !== 'custom';
    if (input<HTMLSelectElement>('comparison-mode').value === 'previous') {
      input<HTMLInputElement>('compare-start').value = shiftDate(snapshot!.range.start_date, -snapshot!.range.day_count);
      input<HTMLInputElement>('compare-end').value = shiftDate(snapshot!.range.start_date, -1);
    }
  });
  for (const id of ['compare-start', 'compare-end']) input<HTMLInputElement>(id).addEventListener('change', () => { input<HTMLSelectElement>('comparison-mode').value = 'custom'; });
  input<HTMLFormElement>('comparison-form').addEventListener('submit', (event) => {
    event.preventDefault();
    try { void compare(readRange(input<HTMLInputElement>('compare-start').value, input<HTMLInputElement>('compare-end').value, snapshot!.as_of_date)); }
    catch (error) { setStatus((error as Error).message, true); }
  });
}

/** Accept the supported host snapshot envelope, reset comparisons, and retain the prior view on invalid input. */
function acceptSnapshot(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('schema_version' in value) || value.schema_version !== 1 || !('range' in value) || !('granted_sections' in value)) return false;
  const initial = !snapshot;
  snapshot = value as ProgressExplorerSnapshot;
  if (initial && !snapshot.granted_sections.weight && snapshot.granted_sections.food) activeView = 'food';
  periodMode = snapshot.range.end_date === snapshot.as_of_date && [30, 90, 365].includes(snapshot.range.day_count)
    ? String(snapshot.range.day_count) : 'custom';
  comparison = undefined;
  render();
  return true;
}

/** Restore keyboard position after a render, falling back to the period selector when a button becomes disabled. */
function restoreControlFocus(id: string): void {
  const target = document.getElementById(id);
  if (target instanceof HTMLButtonElement && target.disabled) input<HTMLSelectElement>('period').focus();
  else target?.focus();
}

/** Fetch a validated range through the host; ignore superseded replies and keep the previous snapshot on failure. */
async function refresh(range: ProgressRange, focusId = 'refresh'): Promise<void> {
  if (busy || sending) return;
  const sequence = ++requestSequence;
  busy = true; render(); setStatus('Loading this period...');
  try {
    const result = await app.callServerTool({ name: 'get_progress_summary', arguments: { start_date: range.start_date, end_date: range.end_date } });
    if (sequence !== requestSequence) return;
    if (result.isError || !acceptSnapshot(result.structuredContent)) throw new Error('Period unavailable');
    setStatus('Period updated. Choose a question to explore it.');
  } catch {
    if (sequence === requestSequence) setStatus('This period could not be loaded. Your previous view is still available; try Refresh or reconnect Calibrate.', true);
  } finally {
    if (sequence === requestSequence) { busy = false; render(); restoreControlFocus(focusId); }
  }
}

/** Compare a validated range with the selected period; serialize requests and preserve evidence after failures. */
async function compare(range: ProgressRange): Promise<void> {
  if (busy || sending) return;
  const sequence = ++requestSequence;
  busy = true; render(); setStatus('Comparing periods...');
  try {
    const result = await app.callServerTool({ name: 'compare_progress_periods', arguments: {
      first: { start_date: snapshot!.range.start_date, end_date: snapshot!.range.end_date },
      second: { start_date: range.start_date, end_date: range.end_date }
    } });
    if (sequence !== requestSequence) return;
    const value = result.structuredContent;
    if (result.isError || !value || typeof value !== 'object' || !('first' in value) || !('second' in value)) throw new Error('Comparison unavailable');
    comparison = value as ProgressComparisonSnapshot;
    setStatus('Comparison ready. Discuss what changed in chat.');
  } catch {
    if (sequence === requestSequence) setStatus('The comparison could not be loaded. Try again or ask about these dates in chat.', true);
  } finally {
    if (sequence === requestSequence) { busy = false; render(); restoreControlFocus('compare-periods'); }
  }
}

/** Send one contextual user question through the host; prevent duplicate sends and offer copyable text on failure. */
async function ask(question: string, focusId: string): Promise<void> {
  if (!snapshot || sending || busy) return;
  const comparisonRange = activeView === 'compare' ? comparison?.second.range : undefined;
  const text = contextualQuestion(question, snapshot, comparisonRange);
  const fallback = () => {
    fallbackQuestion = text;
    render();
    input<HTMLTextAreaElement>('fallback-question').focus();
    input<HTMLTextAreaElement>('fallback-question').select();
  };
  if (!connected || !app.getHostCapabilities()?.message) { fallback(); return; }
  sending = true;
  fallbackQuestion = '';
  render();
  setStatus('Adding your question to chat...');
  try {
    if (app.getHostCapabilities()?.updateModelContext) {
      // The question contains the same period context, so a host declining context updates need not block chat.
      await app.updateModelContext({ structuredContent: { source: 'calibrate-progress-explorer', range: snapshot.range, comparison_range: comparisonRange ?? null, as_of_date: snapshot.as_of_date } }).catch(() => undefined);
    }
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    if (result.isError) throw new Error('Host declined message');
    setStatus('Question added to chat. Continue the conversation there.');
  } catch {
    setStatus('Your question could not be added automatically.', true);
    fallback();
  } finally {
    sending = false;
    render();
    if (fallbackQuestion) {
      input<HTMLTextAreaElement>('fallback-question').focus();
      input<HTMLTextAreaElement>('fallback-question').select();
    } else restoreControlFocus(focusId);
  }
}

app.ontoolresult = (result) => {
  requestSequence += 1;
  busy = false;
  if (result.isError || !acceptSnapshot(result.structuredContent)) {
    render();
    setStatus('Calibrate could not load this view. Reconnect or ask for your progress again in chat.', true);
    root.setAttribute('aria-busy', 'false');
    return;
  }
  setStatus('');
};
app.ontoolcancelled = () => { requestSequence += 1; busy = false; render(); root.setAttribute('aria-busy', 'false'); setStatus('The request was cancelled. You can ask again in chat.'); };
app.onhostcontextchanged = applyTheme;
window.addEventListener('resize', () => {
  // Resize only chart regions so date edits, disclosures, and keyboard focus survive host resizing.
  if (snapshot?.weight && document.getElementById('weight-chart')) input<HTMLElement>('weight-chart').innerHTML = weightChart(snapshot.weight, snapshot.range);
  if (snapshot?.food && document.getElementById('food-chart')) input<HTMLElement>('food-chart').innerHTML = foodChart(snapshot.food, snapshot.range);
});
applyTheme();
void app.connect(undefined, { timeout: 10_000 }).then(() => {
  connected = true;
  applyTheme(app.getHostContext());
  render();
  if (!snapshot) setStatus('Waiting for your Calibrate progress...');
}).catch(() => {
  root.setAttribute('aria-busy', 'false');
  setStatus('This view needs a compatible MCP App host. You can still ask Calibrate questions in the conversation.', true);
  if (!snapshot) content.replaceChildren();
});
