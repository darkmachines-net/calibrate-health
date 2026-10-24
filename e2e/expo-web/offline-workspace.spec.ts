/** @file Regression coverage for offline workspace: auth outage retains a local weigh-in across reload and replays after reconnection. */

import { expect, test, expectApiFailure, activateFixtureOffline } from './fixtures';

test('auth outage retains a local weigh-in across reload and replays after reconnection', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some((key) => key.includes('offline-workspace')))).toBe(true);
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    const outage = async (route: import('@playwright/test').Route) => route.fulfill({
        status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication service unavailable', retryable: true })
    });
    await page.route('**/auth/me', outage);
    await page.reload();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('Pending reconnection');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await page.goto('/weight');
    const sheet = page.getByRole('dialog', { name: 'Weight entry' });
    await sheet.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('87.9');
    await sheet.getByRole('button', { name: /^(Log|Save) weight$/ }).click();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    await page.goto('/today');
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await page.reload();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await expect(page.getByTestId('today-weight-card')).toContainText('87.9 kg');
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'Review saved changes', exact: true }).click();
    const pending = page.getByRole('dialog', { name: 'Saved on this device' });
    await expect(pending).toContainText('Weight: 87.9 kg');
    await pending.getByRole('button', { name: /close/i }).click();
    // A successful cold auth must not erase cached tracking while endpoints are unavailable.
    await page.unroute('**/auth/me', outage);
    expectApiFailure(page, { method: 'GET', pathname: '/api/v1/profile', status: 503 });
    expectApiFailure(page, { method: 'POST', pathname: '/api/v1/metrics', status: 503 });
    const profileOutage = async (route: import('@playwright/test').Route) => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
    const metricOutage = async (route: import('@playwright/test').Route) => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } }) : route.fallback();
    await page.route('**/api/v1/profile', profileOutage);
    await page.route('**/api/v1/metrics', metricOutage);
    let verifiedColdStarts = 0;
    page.on('response', response => { if (new URL(response.url()).pathname === '/auth/me' && response.status() === 200) verifiedColdStarts += 1; });
    await page.reload();
    await expect.poll(() => verifiedColdStarts).toBeGreaterThan(0);
    await expect(page.getByTestId('today-weight-card')).toContainText('87.9 kg');
    await page.route('**/auth/me', outage);
    await page.reload();
    await expect(page.getByTestId('today-weight-card')).toContainText('87.9 kg');
    await expect(page.getByText('360 kcal', { exact: true }).first()).toBeVisible();
    await page.unroute('**/api/v1/profile', profileOutage);
    await page.unroute('**/api/v1/metrics', metricOutage);
    let writes = 0;
    await page.route('**/api/v1/metrics', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        writes += 1;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 900, date: '2026-07-21', weight: 87.9 }) });
    });
    await page.unroute('**/auth/me', outage);
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    expect(writes).toBe(1);
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
});


test('network loss still persists a local weigh-in immediately', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'Daily balance', exact: true })).toBeVisible();
    await page.evaluate(async () => { await navigator.serviceWorker.ready; });
    await activateFixtureOffline(page);
    await page.getByRole('button', { name: "Today's weight. Weigh in. Log weight", exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Weight entry' });
    await sheet.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('87.9');
    await sheet.getByRole('button', { name: 'Log weight', exact: true }).click();
    await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await page.route('**/auth/me', (route) => route.abort('internetdisconnected'));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await page.getByRole('button', { name: 'Review saved changes', exact: true }).click();
    const pending = page.getByRole('dialog', { name: 'Saved on this device' });
    await expect(pending).toContainText('Weight: 87.9 kg');
    await pending.getByRole('button', { name: /close/i }).click();
    await page.getByRole('button', { name: "Today's weight. 87.9 kg. Edit weight", exact: true }).click();
    await sheet.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('87.8');
    await sheet.getByRole('button', { name: 'Save weight', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await expect(page.getByTestId('today-weight-card')).toContainText('87.8 kg');
    await page.getByRole('button', { name: "Today's weight. 87.8 kg. Edit weight", exact: true }).click();
    await sheet.getByRole('button', { name: 'Delete weigh-in', exact: true }).click();
    await sheet.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await page.reload();
    await expect(page.getByTestId('today-weight-card')).toContainText('Weigh in');
    await expect(page.getByTestId('offline-workspace-status')).toContainText('3 pending changes');
});

test('offline food additions and repeated edits are visible after restart and replay once before deletion', async ({ page, ux }) => {
    await ux.install('populated');
    let food: Array<{ id: number; name: string; calories: number; meal_period: string }> = [];
    const receipts = new Map<string, unknown>();
    let creations = 0;
    let edits = 0;
    let deletions = 0;
    await page.route('**/api/v1/food**', async route => {
        const url = new URL(route.request().url());
        const method = route.request().method();
        if (url.pathname === '/api/v1/food' && method === 'GET') return route.fulfill({ json: food });
        if (url.pathname === '/api/v1/food' && method === 'POST') {
            const key = route.request().headers()['x-client-operation-id'];
            if (!receipts.has(key)) {
                const payload = route.request().postDataJSON();
                const row = { id: 901, name: payload.name, calories: payload.calories, meal_period: payload.meal_period };
                food.push(row); receipts.set(key, row); creations += 1;
            }
            return route.fulfill({ json: receipts.get(key) });
        }
        if (url.pathname === '/api/v1/food/901' && method === 'PATCH') {
            food = food.map(row => ({ ...row, ...route.request().postDataJSON() })); edits += 1;
            return route.fulfill({ json: food[0] });
        }
        if (url.pathname === '/api/v1/food/901' && method === 'DELETE') {
            food = []; deletions += 1; return route.fulfill({ status: 204 });
        }
        return route.fallback();
    });
    await page.goto('/food-log');
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    const outage = async (route: import('@playwright/test').Route) => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
    await page.route('**/auth/me', outage);
    await page.reload();
    await page.getByRole('button', { name: 'Add food', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add food', exact: true });
    await add.getByRole('radio', { name: 'Quick', exact: true }).click();
    await add.getByRole('textbox', { name: 'Calories', exact: true }).fill('200');
    await add.getByRole('textbox', { name: 'Food name (optional)', exact: true }).fill('Offline oats');
    await add.getByRole('button', { name: 'Add & close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Offline oats', exact: true })).toBeVisible();
    for (const calories of ['300', '350']) {
        await page.getByRole('button', { name: 'Edit Offline oats', exact: true }).click();
        const edit = page.getByRole('dialog', { name: 'Edit food', exact: true });
        await edit.getByRole('textbox', { name: 'Calories', exact: true }).fill(calories);
        await edit.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.getByText(calories + ' kcal', { exact: true }).first()).toBeVisible();
    }
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Offline oats', exact: true })).toBeVisible();
    await expect(page.getByText('350 kcal', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Delete Offline oats', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Offline oats', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('offline-workspace-status')).toContainText('4 pending changes', { timeout: 15_000 });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Offline oats', exact: true })).toHaveCount(0);
    await page.unroute('**/auth/me', outage);
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    expect({ creations, edits, deletions }).toEqual({ creations: 1, edits: 2, deletions: 1 });
    expect(food).toEqual([]);
});

test('a failed local creation offers explicit discard instead of saving unreachable corrections', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/food-log');
    await expect(page.getByRole('button', { name: 'Add food', exact: true })).toBeVisible();
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    await page.route('**/auth/me', route => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } }));
    await page.reload();
    await page.getByRole('button', { name: 'Add food', exact: true }).click();
    const add = page.getByRole('dialog', { name: 'Add food', exact: true });
    await add.getByRole('radio', { name: 'Quick', exact: true }).click();
    await add.getByRole('textbox', { name: 'Calories', exact: true }).fill('200');
    await add.getByRole('textbox', { name: 'Food name (optional)', exact: true }).fill('Failed oats');
    await add.getByRole('button', { name: 'Add & close', exact: true }).click();
    await page.getByRole('button', { name: 'Edit Failed oats', exact: true }).click();
    const edit = page.getByRole('dialog', { name: 'Edit food', exact: true });
    await edit.getByRole('textbox', { name: 'Calories', exact: true }).fill('300');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('2 pending changes');
    // Simulate a persisted nonretryable creation result; exercise the real IndexedDB queue and recovery UI.
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('calibrate-offline');
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('queued_mutations', 'readwrite');
            const store = tx.objectStore('queued_mutations');
            const rows = store.getAll();
            rows.onsuccess = () => {
                const creation = rows.result.find(row => row.operation === 'food.create');
                store.put({ ...creation, state: 'failed', lastError: 'My food not found' });
            };
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => reject(tx.error);
        };
        open.onerror = () => reject(open.error);
    }));
    await page.reload();
    await page.getByRole('button', { name: 'Delete Failed oats', exact: true }).click();
    await expect(edit).toContainText('A correction cannot pass the failed write.');
    await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await edit.getByRole('button', { name: 'Discard failed entry', exact: true }).click();
    await expect(edit).toContainText('Other queued changes are kept.');
    await edit.getByRole('button', { name: 'Confirm discard failed entry', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Edit Failed oats', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('offline-workspace-status')).toContainText('0 pending changes');
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Failed oats', exact: true })).toHaveCount(0);
});

test('logout terminates the browser session while tracking awaits reconnection', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.includes('offline-workspace')))).toBe(true);
    let terminated = false;
    let logoutRequests = 0;
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 401 });
    await page.route('**/auth/me', route => route.fulfill({ status: terminated ? 401 : 503, json: terminated ? { error: 'Not authenticated', code: 'NOT_AUTHENTICATED' } : { error: 'Unavailable', retryable: true } }));
    await page.route('**/auth/logout', route => {
        logoutRequests += 1;
        terminated = true;
        return route.fulfill({ json: { message: 'Signed out' } });
    });
    await page.goto('/security');
    await expect(page.getByTestId('offline-workspace-status')).toContainText('Pending reconnection');
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/login');
    await expect.poll(() => logoutRequests).toBe(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
});

test('offline logout stays signed out through reload, revokes after reconnect and permits a different account', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/security');
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    const original = await page.evaluate(async () => (await (await fetch('/auth/me', { credentials: 'include' })).json()).user);
    let sessionUser = original;
    let disconnected = false;
    let revocations = 0;
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 401 });
    await page.route('**/auth/me', route => disconnected ? route.abort('internetdisconnected') : sessionUser
        ? route.fulfill({ json: { user: sessionUser } })
        : route.fulfill({ status: 401, json: { code: 'NOT_AUTHENTICATED', error: 'Not authenticated' } }));
    await page.route('**/auth/logout', route => {
        if (disconnected) return route.abort('internetdisconnected');
        revocations += 1; sessionUser = null;
        return route.fulfill({ json: { message: 'Signed out' } });
    });
    await page.route('**/api/v1/client-config', route => route.fulfill({ json: { api_version: 1, api_versions: { supported: ['v1'] }, server_version: '0.37.0', min_supported_mobile_version: '0.0.0', min_supported_wear_version: '0.0.0', capabilities: {} } }));
    await page.route('**/auth/login', route => {
        expect(revocations).toBe(1);
        sessionUser = { ...original, id: 18, email: 'other@example.invalid' };
        return route.fulfill({ json: { user: sessionUser } });
    });
    await page.evaluate(async () => { localStorage.setItem('unrelated-local-data', 'keep'); await navigator.serviceWorker.ready; });
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'Daily balance', exact: true })).toBeVisible();
    await page.getByRole('button', { name: "Today's weight. Weigh in. Log weight", exact: true }).click();
    const weight = page.getByRole('dialog', { name: 'Weight entry' });
    await expect(weight.getByRole('textbox', { name: 'Weight in kilograms', exact: true })).toBeVisible();
    disconnected = true;
    await activateFixtureOffline(page);
    await weight.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('87.9');
    await weight.getByRole('button', { name: /^(Log|Save) weight$/ }).click();
    await page.goto('/security');
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect(revocations).toBe(0);
    disconnected = false;
    await page.context().setOffline(false);
    await expect.poll(() => revocations).toBe(1);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    // The exported app deliberately rejects HTTP sign-in. HTTPS preview exercises replacement-account login.
    if (new URL(page.url()).protocol === 'https:') {
        await page.getByRole('textbox', { name: 'Email', exact: true }).fill('other@example.invalid');
        await page.getByRole('textbox', { name: 'Password', exact: true }).fill('synthetic-password');
        await page.getByRole('button', { name: 'Sign in', exact: true }).click();
        await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
    }
    expect(revocations).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('unrelated-local-data'))).toBe('keep');
    const queued = await page.evaluate(() => new Promise<Array<{ namespace: string; operation: string }>>((resolve, reject) => {
        const open = indexedDB.open('calibrate-offline');
        open.onsuccess = () => { const db = open.result; const tx = db.transaction('queued_mutations'); const rows = tx.objectStore('queued_mutations').getAll(); rows.onsuccess = () => { resolve(rows.result); db.close(); }; rows.onerror = () => reject(rows.error); };
        open.onerror = () => reject(open.error);
    }));
    expect(queued).toEqual([expect.objectContaining({ namespace: expect.stringContaining('::user:17'), operation: 'metric.add' })]);
});


test('failed edits on a server row require explicit recovery before correction or deletion', async ({ page, ux }) => {
    await ux.install('populated');
    await page.goto('/food-log');
    await expect(page.getByRole('button', { name: 'Edit Fixture breakfast', exact: true })).toBeVisible();
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    const outage = async (route: import('@playwright/test').Route) => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
    await page.route('**/auth/me', outage);
    await page.reload();
    const edit = page.getByRole('dialog', { name: 'Edit food', exact: true });
    for (const value of ['400', '450']) {
        await page.getByRole('button', { name: 'Edit Fixture breakfast', exact: true }).click();
        await edit.getByRole('textbox', { name: 'Calories', exact: true }).fill(value);
        await edit.getByRole('button', { name: 'Save', exact: true }).click();
    }
    await expect(page.getByTestId('offline-workspace-status')).toContainText('2 pending changes');
    const markFailed = () => page.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('calibrate-offline');
        open.onsuccess = () => { const db = open.result; const tx = db.transaction('queued_mutations', 'readwrite'); const store = tx.objectStore('queued_mutations'); const read = store.getAll();
            read.onsuccess = () => { const first = read.result.find(row => row.operation === 'food.update'); store.put({ ...first, state: 'failed', lastError: 'Food day paused' }); };
            tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        open.onerror = () => reject(open.error);
    }));
    await markFailed(); await page.reload();
    await page.getByRole('button', { name: 'Delete Fixture breakfast', exact: true }).click();
    await expect(edit).toContainText('Saving another correction cannot pass the failed write.');
    await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await edit.getByRole('button', { name: 'Retry original change', exact: true }).click();
    await expect(edit.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await markFailed(); await page.reload();
    await page.getByRole('button', { name: 'Edit Fixture breakfast', exact: true }).click();
    await edit.getByRole('button', { name: 'Discard queued changes', exact: true }).click();
    await expect(edit).toContainText('This does not delete or undo any server record');
    await edit.getByRole('button', { name: 'Confirm discard queued changes', exact: true }).click();
    await expect(edit).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('0 pending changes');
    await page.getByRole('button', { name: 'Edit Fixture breakfast', exact: true }).click();
    await expect(edit.getByRole('textbox', { name: 'Calories', exact: true })).toHaveValue('360');
    await edit.getByRole('textbox', { name: 'Calories', exact: true }).fill('500');
    await edit.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    const writes: unknown[] = [];
    await page.route('**/api/v1/food/*', async route => {
        if (route.request().method() !== 'PATCH') return route.fallback();
        writes.push(route.request().postDataJSON());
        return route.fulfill({ json: { id: 31, name: 'Fixture breakfast', date: '2026-07-21', meal_period: 'breakfast', calories: 500 } });
    });
    await page.unroute('**/auth/me', outage);
    await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    expect(writes).toEqual([expect.objectContaining({ calories: 500 })]);
});


for (const failedOperation of ['metric.add', 'metric.delete']) {
    test('failed weight recovery blocks trapped corrections for ' + failedOperation, async ({ page, ux }) => {
        await ux.install('populated');
        const existing = failedOperation === 'metric.delete';
        if (existing) await page.route('**/api/v1/metrics', route => route.request().method() === 'GET'
            ? route.fulfill({ json: [{ id: 900, date: '2026-07-21', weight: 88 }] }) : route.fallback());
        await page.goto('/weight');
        const weight = page.getByRole('dialog', { name: 'Weight entry' });
        await expect(weight.getByRole('textbox', { name: 'Weight in kilograms', exact: true })).toBeVisible();
        await page.evaluate(({ operation, existing }) => new Promise<void>((resolve, reject) => {
            const open = indexedDB.open('calibrate-offline');
            open.onsuccess = () => { const db = open.result; const tx = db.transaction('queued_mutations', 'readwrite'); const store = tx.objectStore('queued_mutations');
                const base = { namespace: location.origin + '::user:17', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 };
                store.add({ ...base, id: 'failed-weight', operation, payloadJson: JSON.stringify(existing ? { id: 900, date: '2026-07-21' } : { date: '2026-07-21', weight: 87.9 }), state: 'failed', attemptCount: 1, lastError: 'Rejected' });
                store.add({ ...base, id: 'old-correction', operation: 'metric.add', payloadJson: JSON.stringify({ date: '2026-07-21', weight: 88.5 }), state: 'pending' });
                store.add({ ...base, id: 'other-date', operation: 'metric.add', payloadJson: JSON.stringify({ date: '2026-07-22', weight: 90 }), state: 'pending' });
                tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
            open.onerror = () => reject(open.error);
        }), { operation: failedOperation, existing });
        expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
        const outage = async (route: import('@playwright/test').Route) => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
        await page.route('**/auth/me', outage); await page.reload();
        await expect(weight).toContainText('Related corrections cannot synchronize');
        await weight.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('89');
        await expect(weight.getByRole('button', { name: /^(Log|Save) weight$/ })).toBeDisabled();
        await expect(weight.getByRole('button', { name: 'Delete weigh-in', exact: true })).toBeDisabled();
        await weight.getByRole('button', { name: 'Discard related queued changes', exact: true }).click();
        await expect(weight).toContainText('This does not undo anything that reached the server.');
        await weight.getByRole('button', { name: 'Confirm discard related changes', exact: true }).click();
        await expect(weight.getByRole('button', { name: 'Retry original request', exact: true })).toHaveCount(0);
        await page.reload();
        await weight.getByRole('textbox', { name: 'Weight in kilograms', exact: true }).fill('89');
        await weight.getByRole('button', { name: /^(Log|Save) weight$/ }).click();
        await expect(page.getByText('Saved on this device', { exact: true })).toBeVisible();
        await page.goto('/today');
        await expect(page.getByTestId('offline-workspace-status')).toContainText('2 pending changes');
        const writes: Array<{ date: string; weight: number }> = [];
        await page.route('**/api/v1/metrics', route => {
            if (route.request().method() !== 'POST') return route.fallback();
            const payload = route.request().postDataJSON(); writes.push(payload);
            return route.fulfill({ json: { id: payload.date === '2026-07-21' ? 900 : 901, ...payload } });
        });
        await page.unroute('**/auth/me', outage);
        await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
        await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
        expect(writes).toEqual([{ date: '2026-07-22', weight: 90 }, { date: '2026-07-21', weight: 89 }]);
    });
}


test('failed tracking controls have explicit shared recovery without losing unrelated weight', async ({ page, ux }) => {
    await ux.install('populated'); await page.goto('/today');
    await expect(page.getByRole('heading', { name: 'Daily balance', exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const open = indexedDB.open('calibrate-offline');
        open.onsuccess = () => { const db = open.result; const tx = db.transaction('queued_mutations', 'readwrite'); const store = tx.objectStore('queued_mutations');
            const base = { namespace: location.origin + '::user:17', attemptCount: 0, lastError: null, createdAt: 1, updatedAt: 1 };
            store.add({ ...base, id: 'failed-pause', operation: 'food-tracking-pause.start', payloadJson: JSON.stringify({ starts_on: '2026-07-21', expected_resume_on: '2026-07-25' }), state: 'failed', attemptCount: 1, lastError: 'Rejected' });
            store.add({ ...base, id: 'later-status', operation: 'food-day.set-status', payloadJson: JSON.stringify({ date: '2026-07-22', status: 'OPEN' }), state: 'pending' });
            store.add({ ...base, id: 'keep-weight', operation: 'metric.add', payloadJson: JSON.stringify({ date: '2026-07-23', weight: 90 }), state: 'pending' });
            tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error); };
        open.onerror = () => reject(open.error);
    }));
    expectApiFailure(page, { method: 'GET', pathname: '/auth/me', status: 503 });
    await page.route('**/auth/me', route => route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } }));
    await page.reload();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('needs attention before synchronization can continue');
    await page.getByRole('button', { name: 'Review saved changes', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Saved on this device', exact: true });
    await review.getByRole('button', { name: 'Discard related queued changes', exact: true }).click();
    await expect(review).toContainText('Other changes and accounts are kept.');
    await review.getByRole('button', { name: 'Confirm discard related changes', exact: true }).click();
    await expect(review.getByRole('button', { name: 'Retry original request', exact: true })).toHaveCount(0);
    await expect(review).toContainText('Weight: 90 kg');
    await review.getByRole('button', { name: /close/i }).click();
    await page.reload();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
});


test('a stale second tab queues day completion after durable food intent', async ({ page, context, ux }) => {
    await ux.install('populated');
    await page.goto('/today');
    await expect(page.getByRole('button', { name: 'Complete day', exact: true })).toBeVisible();
    const other = await context.newPage(); await ux.installOnPage(other);
    await other.goto('/food-log');
    // The shared fixture uses a per-tab deterministic UUID counter; give this tab its own deterministic prefix.
    await other.evaluate(() => { const original = crypto.randomUUID.bind(crypto); Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => original().replace(/^00000000/, '00000001') }); });
    let held = true; const applied: string[] = [];
    for (const tab of [page, other]) {
        expectApiFailure(tab, { method: 'POST', pathname: '/api/v1/food', status: 503 });
        await tab.route('**/api/v1/food', route => {
            if (route.request().method() !== 'POST') return route.fallback();
            if (held) return route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
            applied.push('food'); return route.fulfill({ json: { id: 950, ...route.request().postDataJSON() } });
        });
        await tab.route('**/api/v1/food-days', route => {
            if (route.request().method() !== 'PATCH') return route.fallback();
            applied.push('complete'); return route.fulfill({ json: { date: '2026-07-21', status: 'COMPLETE', is_complete: true, is_representative: true } });
        });
    }
    await other.getByRole('button', { name: 'Add food', exact: true }).click();
    const add = other.getByRole('dialog', { name: 'Add food', exact: true });
    await add.getByRole('radio', { name: 'Quick', exact: true }).click();
    await add.getByRole('textbox', { name: 'Calories', exact: true }).fill('200');
    await add.getByRole('textbox', { name: 'Food name (optional)', exact: true }).fill('Other tab oats');
    await add.getByRole('button', { name: 'Add & close', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Edit Other tab oats', exact: true })).toBeVisible();
    // The first tab has not refreshed its provider snapshot since the other tab queued the food.
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    await page.getByRole('button', { name: 'Complete day', exact: true }).click();
    await expect(page.getByTestId('offline-workspace-status')).toContainText('pending changes');
    expect(applied).toEqual([]);
    const queued = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('calibrate-offline'); open.onsuccess = () => { const db = open.result; const request = db.transaction('queued_mutations').objectStore('queued_mutations').getAll(); request.onsuccess = () => { resolve(request.result.map(row => row.operation)); db.close(); }; request.onerror = () => reject(request.error); }; open.onerror = () => reject(open.error);
    }));
    expect(queued).toEqual(['food.create', 'food-day.set-status']);
    held = false;
    await activateFixtureOffline(page);
    await page.context().setOffline(false);
    await expect.poll(() => applied).toEqual(['food', 'complete']);
    await other.close();
});

test('logout still clears the UI and revokes the browser session when intent storage rejects writes', async ({ page, ux }) => {
    await ux.install('populated'); await page.goto('/security');
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    let revocations = 0;
    await page.route('**/auth/logout', route => { revocations += 1; return route.fulfill({ json: { message: 'Signed out' } }); });
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
            if (key.includes('calibrate.logout.')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect.poll(() => revocations).toBe(1);
});


test('logout warns when storage and revocation fail and retries from memory after reconnect', async ({ page, ux }) => {
    await ux.install('populated'); await page.goto('/security');
    await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
    let unavailable = true; let revocations = 0;
    expectApiFailure(page, { method: 'POST', pathname: '/auth/logout', status: 503 });
    await page.route('**/auth/logout', route => {
        if (unavailable) return route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
        revocations += 1; return route.fulfill({ json: { message: 'Signed out' } });
    });
    await page.evaluate(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
            if (key.includes('calibrate.logout.')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
            return original.call(this, key, value);
        };
    });
    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByText('Signed out in this app. Device storage is unavailable and server sign-out is pending. Reconnect before closing this app.', { exact: true })).toBeVisible();
    expect(revocations).toBe(0);
    unavailable = false;
    await activateFixtureOffline(page);
    await page.context().setOffline(false);
    await expect.poll(() => revocations).toBe(1);
    await expect(page.getByText('Reconnect before closing this app.', { exact: false })).toHaveCount(0);
});

test('queued resume stays resolved through reload and refetch and replays one request identity', async ({ page, ux }, testInfo) => {
    const options: import('./fixtures').AuthenticatedApiOptions = { foodDayStatus: 'PAUSED' };
    await ux.install('paused', options);
    let recovering = false; let writes = 0;
    const ids: string[] = [];
    const pause = () => ({ active: options.foodDayStatus === 'PAUSED', id: 9, starts_on: '2026-07-20', expected_resume_on: '2026-07-21', resumed_on: null, started_at: null, resumed_at: null, materialized_through: '2026-07-21', resume_confirmation_due: options.foodDayStatus === 'PAUSED' });
    await page.route('**/api/v1/food-days/pause', route => route.fulfill({ json: { pause: pause() } }));
    expectApiFailure(page, { method: 'POST', pathname: '/api/v1/food-days/resume', status: 503 });
    await page.route('**/api/v1/food-days/resume', async route => {
        ids.push(route.request().headers()['x-client-operation-id']);
        if (!recovering) return route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } });
        writes++; options.foodDayStatus = 'OPEN';
        return route.fulfill({ json: { pause: pause(), day: { date: '2026-07-21', status: 'OPEN' } } });
    });
    await page.goto('/today');
    const prompt = page.getByRole('dialog', { name: 'Ready to resume tracking?' });
    await expect(prompt).toBeVisible();
    await prompt.getByRole('button', { name: 'Resume tracking', exact: true }).click();
    await expect(prompt).toHaveCount(0);
    for (let restart = 0; restart < 2; restart++) {
        await page.reload();
        await expect(page.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
        await expect(prompt).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Resume tracking', exact: true })).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath('queued-resume-after-restart.png') });
    expect(new Set(ids).size).toBe(1);
    recovering = true;
    await activateFixtureOffline(page);
    await page.context().setOffline(false);
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    expect(writes).toBe(1); expect(new Set(ids).size).toBe(1);
    await expect(prompt).toHaveCount(0);
});

test('a stale second tab cannot copy server food before another tabs saved food replays', async ({ page, context, ux }) => {
    await ux.install('populated'); await page.goto('/food-log');
    await expect(page.getByRole('button', { name: 'Copy day', exact: true })).toBeEnabled();
    const other = await context.newPage(); await ux.installOnPage(other); await other.goto('/food-log');
    await other.evaluate(() => { const original = crypto.randomUUID.bind(crypto); Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => original().replace(/^00000000/, '00000002') }); });
    for (const tab of [page, other]) {
        expectApiFailure(tab, { method: 'POST', pathname: '/api/v1/food', status: 503 });
        await tab.route('**/api/v1/food', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } }) : route.fallback());
    }
    let copies = 0;
    await page.route('**/api/v1/food/copy', route => { copies++; return route.fulfill({ json: { copied_count: 1, target_date: '2026-07-20' } }); });
    await other.getByRole('button', { name: 'Add food', exact: true }).click();
    const add = other.getByRole('dialog', { name: 'Add food', exact: true });
    await add.getByRole('radio', { name: 'Quick', exact: true }).click();
    await add.getByRole('textbox', { name: 'Calories', exact: true }).fill('200');
    await add.getByRole('textbox', { name: 'Food name (optional)', exact: true }).fill('Unreplayed oats');
    await add.getByRole('button', { name: 'Add & close', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Edit Unreplayed oats', exact: true })).toBeVisible();
    await expect(page.getByTestId('offline-workspace-status')).toHaveCount(0);
    await page.getByRole('button', { name: 'Copy day', exact: true }).click();
    const copy = page.getByRole('dialog', { name: 'Copy day', exact: true });
    await copy.getByLabel('Copy to date').fill('2026-07-20');
    await copy.getByRole('button', { name: 'Copy day', exact: true }).click();
    await expect(copy).toContainText('Synchronize saved changes before copying food.');
    expect(copies).toBe(0); await other.close();
});

test('a stale completed-day action cannot reopen a pause queued in another tab', async ({ page, context, ux }) => {
    const options: import('./fixtures').AuthenticatedApiOptions = { foodDayStatus: 'COMPLETE' };
    await ux.install('populated', options); await page.goto('/today');
    await expect(page.getByRole('button', { name: 'Day completed', exact: true })).toBeVisible();
    const other = await context.newPage(); await ux.installOnPage(other); await other.goto('/today');
    await other.evaluate(() => { const original = crypto.randomUUID.bind(crypto); Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => original().replace(/^00000000/, '00000003') }); });
    await other.route('**/api/v1/food-days', route => { options.foodDayStatus = 'OPEN'; return route.fulfill({ json: { date: '2026-07-21', status: 'OPEN' } }); });
    await other.getByRole('button', { name: 'Day completed', exact: true }).click();
    await other.getByRole('button', { name: 'Choose date', exact: true }).click();
    await expect(other.getByRole('button', { name: 'Pause tracking', exact: true })).toBeVisible();
    expectApiFailure(other, { method: 'POST', pathname: '/api/v1/food-days/pause', status: 503 });
    await other.route('**/api/v1/food-days/pause', route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Unavailable', retryable: true } }) : route.fallback());
    await other.getByRole('button', { name: 'Pause tracking', exact: true }).click();
    await other.getByRole('button', { name: 'Until I resume', exact: true }).click();
    await expect(other.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await expect(page.getByRole('button', { name: 'Day completed', exact: true })).toBeVisible();
    let writes = 0;
    await page.route('**/api/v1/food-days**', route => { if (route.request().method() !== 'GET') writes++; return route.fallback(); });
    await page.getByRole('button', { name: 'Day completed', exact: true }).click();
    await expect(page.getByText('Tracking changed to paused. Resume tracking or explicitly backfill this day before changing its status.', { exact: true })).toBeVisible();
    expect(writes).toBe(0);
    await expect(other.getByTestId('offline-workspace-status')).toContainText('1 pending changes');
    await other.close();
});
