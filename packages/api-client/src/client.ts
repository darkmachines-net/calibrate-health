import type {
    AccountExport,
    AccountSessionSummary,
    ActivityDaysResponse,
    BrowserAuthRequest,
    BrowserAuthResponse,
    BrowserRegistrationRequest,
    BrowserPushSubscriptionPayload,
    CalibrationStatusResponse,
    CaloriePlanOptionsRequest,
    CaloriePlanOptionsResponse,
    ClientDiagnosticInput,
    ClientDiagnosticResponse,
    ClientConfigResponse,
    ConnectedAppSummary,
    CreateMyFoodPayload,
    NutritionLabelDraft,
    ServerFeatures,
    ServerSettingsResponse,
    CreateRecipeFromFoodLogsPayload,
    FoodLogCopyPayload,
    FoodLogCopyResponse,
    FoodLogCreatePayload,
    FoodLogDay,
    FoodLogDayRange,
    FoodLogDayStatus,
    FoodTrackingPause,
    FoodLogEntry,
    FoodLogUpdatePayload,
    FoodSearchResponse,
    GoalEntry,
    GoalPaceOptions,
    GoalPaceRequest,
    HealthConnectSyncPayload,
    HealthConnectSyncResponse,
    InAppNotificationPageResponse,
    InAppNotificationsQuery,
    InAppNotificationsResponse,
    LoseItImportSummary,
    MetricEntry,
    MetricSaveResponse,
    MobileAuthRequest,
    MobileAuthResponse,
    MobileRegistrationRequest,
    MobileSessionSummary,
    EmailVerificationConfirmRequest,
    EmailVerificationConfirmResponse,
    EmailVerificationResendRequest,
    LegalAcceptanceStatus,
    LegalAcceptanceRequest,
    MarkAllInAppNotificationsReadResponse,
    MessageResponse,
    PasswordResetConfirmRequest,
    PasswordResetRequest,
    WearPairingCredentialRequest,
    WearPairingCredentialResponse,
    WearPairingExchangeRequest,
    WearMobileAuthResponse,
    WatchMutationRequest,
    WatchMutationResponse,
    WatchSnapshotFetchResult,
    CreateRecipePayload,
    MyFoodDetail,
    MyFoodsLibraryQuery,
    MyFoodsLibraryResponse,
    MyFoodSummary,
    MobileRefreshResponse,
    NativePushSubscriptionPayload,
    OnboardingCompleteRequest,
    OnboardingCompleteResponse,
    RecentFoodsQuery,
    RecentFoodsResponse,
    SyncChangesResponse,
    ScheduledCalibrationChange,
    TrendMetricsResponse,
    UpdateMyFoodPayload,
    UserClientPayload,
    UserProfileResponse
} from './types';
import {
    NATIVE_CLIENT_HEADERS,
    isClientUpgradeRequirement,
    type ClientUpgradeRequirement,
    type NativeClientIdentity
} from '@calibrate/shared/clientCompatibility';

export type ApiFieldErrors = Readonly<Record<string, readonly string[]>>;

export type ParsedApiError = {
    code: string | null;
    fieldErrors?: ApiFieldErrors;
    retryable?: boolean;
    requestId: string | null;
};

const MAX_ERROR_CODE_LENGTH = 128;
const MAX_REQUEST_ID_LENGTH = 128;
const MAX_FIELD_NAME_LENGTH = 128;
const MAX_FIELD_MESSAGE_LENGTH = 1_000;
const MAX_FIELD_COUNT = 32;
const MAX_MESSAGES_PER_FIELD = 8;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const nonEmptyBoundedString = (value: unknown, maxLength: number): string | null => {
    if (typeof value !== 'string') return null;
    const normalized = value.trim();
    return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
};

const boundedToken = (value: unknown, maxLength: number): string | null => {
    const parsed = nonEmptyBoundedString(value, maxLength);
    return parsed && SAFE_TOKEN_PATTERN.test(parsed) ? parsed : null;
};

const parseFieldErrors = (value: unknown): ApiFieldErrors | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;

    const parsed: Record<string, readonly string[]> = {};
    for (const [field, messages] of Object.entries(value).slice(0, MAX_FIELD_COUNT)) {
        const normalizedField = nonEmptyBoundedString(field, MAX_FIELD_NAME_LENGTH);
        // eslint-disable-next-line no-control-regex -- Reject control characters in server-provided field names.
        if (!normalizedField || /[\u0000-\u001f\u007f]/.test(normalizedField) || !Array.isArray(messages)) continue;

        const normalizedMessages = messages.slice(0, MAX_MESSAGES_PER_FIELD)
            .map((message) => nonEmptyBoundedString(message, MAX_FIELD_MESSAGE_LENGTH))
            .filter((message): message is string => message !== null);
        if (normalizedMessages.length > 0) parsed[normalizedField] = normalizedMessages;
    }

    return Object.keys(parsed).length > 0 ? parsed : undefined;
};

/** Read additive v1 metadata while remaining compatible with legacy message-only servers. */
export function parseApiError(body: unknown, requestIdHeader?: string | null): ParsedApiError {
    const record = body && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : null;
    const headerRequestId = nonEmptyBoundedString(requestIdHeader, MAX_REQUEST_ID_LENGTH);

    return {
        code: boundedToken(record?.code, MAX_ERROR_CODE_LENGTH),
        fieldErrors: parseFieldErrors(record?.field_errors),
        retryable: typeof record?.retryable === 'boolean' ? record.retryable : undefined,
        requestId: boundedToken(headerRequestId, MAX_REQUEST_ID_LENGTH)
            ?? boundedToken(record?.request_id, MAX_REQUEST_ID_LENGTH)
    };
}

export type ApiClientOptions = {
    baseUrl: string;
    /** Native identity is attached to every request so a self-host can enforce release floors continuously. */
    clientIdentity?: NativeClientIdentity;
    onClientUpgradeRequired?: (requirement: ClientUpgradeRequirement) => void | Promise<void>;
    getAccessToken?: () => string | null | Promise<string | null>;
    /** Refresh native credentials after a protected request returns 401. */
    refreshAccessToken?: () => boolean | Promise<boolean>;
    onUnauthorized?: () => void | Promise<void>;
    /** Observes completed failures, including parsed server errors and client-generated timeouts. */
    onRequestError?: (error: unknown) => void;
    fetchImpl?: typeof fetch;
    requestTimeoutMs?: number;
    /** Browser clients opt in explicitly when the API uses an HttpOnly cookie session. */
    requestCredentials?: RequestCredentials;
};

/** React Native uploads identify a local URI, while browsers must submit a real Blob/File. */
export type LoseItImportFile = { uri: string; name: string; type: string } | Blob;

const isNativeLoseItImportFile = (file: LoseItImportFile): file is { uri: string; name: string; type: string } =>
    'uri' in file;

/** Expo web returns an object URL; native DocumentPicker URIs must stay opaque for React Native FormData. */
const isBrowserBlobUri = (uri: string): boolean => uri.toLowerCase().startsWith('blob:');

export class ApiError extends Error {
    readonly status: number;
    readonly body: unknown;
    readonly code: string | null;
    readonly fieldErrors?: ApiFieldErrors;
    readonly retryable?: boolean;
    readonly requestId: string | null;

    constructor(message: string, status: number, body: unknown, parsed = parseApiError(body)) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
        this.code = parsed.code;
        this.fieldErrors = parsed.fieldErrors;
        this.retryable = parsed.retryable;
        this.requestId = parsed.requestId;
    }
}

type RequestOptions = RequestInit & {
    timeoutMs?: number;
    auth?: boolean;
    json?: unknown;
    acceptNotModified?: boolean;
    responseMetadata?: boolean;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const CLIENT_OPERATION_ID_HEADER = 'x-client-operation-id';

/** Attach an operation identifier only when the caller is opting into idempotent replay. */
const buildOperationHeaders = (operationId?: string): HeadersInit | undefined =>
    operationId ? { [CLIENT_OPERATION_ID_HEADER]: operationId } : undefined;

const trimTrailingSlash = (value: string): string => value.replace(/\/+$/, '');

type FoodLogDayResponse = Pick<FoodLogDay, 'date' | 'is_complete' | 'completed_at'>
    & Partial<Omit<FoodLogDay, 'date' | 'is_complete' | 'completed_at'>>;

const FOOD_LOG_DAY_STATUSES: ReadonlySet<string> = new Set(['OPEN', 'COMPLETE', 'INCOMPLETE', 'PAUSED']);

/** Older servers expose only is_complete; treat their unresolved days as open and editable. */
const normalizeFoodLogDay = (day: FoodLogDayResponse): FoodLogDay => {
    let status: FoodLogDayStatus = day.is_complete ? 'COMPLETE' : 'OPEN';
    if (typeof day.status === 'string' && FOOD_LOG_DAY_STATUSES.has(day.status)) {
        status = day.status as FoodLogDayStatus;
    }

    return {
        date: day.date,
        status,
        origin: day.origin ?? null,
        source: day.source ?? 'STORED',
        is_representative: day.is_representative ?? status === 'COMPLETE',
        is_complete: status === 'COMPLETE',
        completed_at: day.completed_at ?? null,
        updated_at: day.updated_at ?? null,
        ...(day.calorie_comparison === undefined ? {} : { calorie_comparison: day.calorie_comparison })
    };
};

const buildUrl = (baseUrl: string, path: string): string => {
    const requestedPath = path.startsWith('/') ? path : `/${path}`;
    // Keep method declarations readable while ensuring all shared API calls use the stable v1 mount.
    const normalizedPath = requestedPath.startsWith('/api/')
        ? `/api/v1/${requestedPath.slice('/api/'.length)}`
        : requestedPath;
    return `${trimTrailingSlash(baseUrl)}${normalizedPath}`;
};

const getErrorMessage = (body: unknown, fallback: string): string => {
    if (body && typeof body === 'object' && 'message' in body) {
        const message = (body as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim().length > 0) {
            return message;
        }
    }

    return fallback;
};

/**
 * Typed fetch wrapper for the Calibrate HTTP API.
 */
export class CalibrateApiClient {
    private readonly baseUrl: string;
    private readonly getAccessToken?: ApiClientOptions['getAccessToken'];
    private readonly clientIdentity?: NativeClientIdentity;
    private readonly onClientUpgradeRequired?: ApiClientOptions['onClientUpgradeRequired'];
    private readonly refreshAccessToken?: ApiClientOptions['refreshAccessToken'];
    private readonly onUnauthorized?: ApiClientOptions['onUnauthorized'];
    private readonly onRequestError?: ApiClientOptions['onRequestError'];
    private readonly fetchImpl: typeof fetch;
    private readonly requestTimeoutMs: number;
    private readonly requestCredentials?: RequestCredentials;
    private refreshPromise: Promise<boolean> | null = null;
    private refreshGeneration = 0;

    constructor(options: ApiClientOptions) {
        this.baseUrl = options.baseUrl;
        this.clientIdentity = options.clientIdentity;
        this.onClientUpgradeRequired = options.onClientUpgradeRequired;
        this.getAccessToken = options.getAccessToken;
        this.refreshAccessToken = options.refreshAccessToken;
        this.onUnauthorized = options.onUnauthorized;
        this.onRequestError = options.onRequestError;
        // Preserve the browser global as fetch's receiver; some web hosts reject detached Window.fetch calls.
        this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.requestCredentials = options.requestCredentials;
    }

    /** Share one refresh across concurrent 401 responses to avoid rotating the same token twice. */
    private async refreshAccessTokenOnce(): Promise<boolean> {
        if (!this.refreshAccessToken) return false;

        if (!this.refreshPromise) {
            this.refreshPromise = Promise.resolve(this.refreshAccessToken())
                .then((refreshed) => {
                    if (refreshed) this.refreshGeneration += 1;
                    return refreshed;
                })
                .finally(() => {
                    this.refreshPromise = null;
                });
        }

        return this.refreshPromise;
    }

    private async request<T>(path: string, options: RequestOptions = {}, allowRefresh = true): Promise<T> {
        try {
            return await this.requestInternal<T>(path, options, allowRefresh);
        } catch (error) {
            try { this.onRequestError?.(error); } catch { /* Observers cannot replace the request's error. */ }
            throw error;
        }
    }

    private async requestInternal<T>(path: string, options: RequestOptions, allowRefresh: boolean): Promise<T> {
        const requestRefreshGeneration = this.refreshGeneration;
        const {
            auth = true,
            json,
            acceptNotModified = false,
            responseMetadata = false,
            timeoutMs = this.requestTimeoutMs,
            ...fetchOptions
        } = options;
        const headers = new Headers(options.headers);
        if (this.clientIdentity) {
            // Constructor-owned identity wins over per-request headers so feature code cannot spoof another client.
            headers.set(NATIVE_CLIENT_HEADERS.PLATFORM, this.clientIdentity.platform);
            headers.set(NATIVE_CLIENT_HEADERS.VERSION, this.clientIdentity.version);
        }
        if (json !== undefined) {
            headers.set('content-type', 'application/json');
        }

        if (auth && this.getAccessToken) {
            const token = await this.getAccessToken();
            if (token) {
                headers.set('authorization', `Bearer ${token}`);
            }
        }

        const timeoutController = new AbortController();
        let timedOut = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const timeoutError = () => new Error(
            `Request timed out while connecting to ${this.baseUrl}. Check the server URL and network access.`
        );
        // Some React Native transports do not settle fetch after AbortController fires. The explicit
        // rejection keeps offline mutations bounded while still aborting transports that honor it.
        const timeout = new Promise<never>((_resolve, reject) => {
            timeoutId = setTimeout(() => {
                timedOut = true;
                timeoutController.abort();
                reject(timeoutError());
            }, timeoutMs);
        });
        const callerSignal = options.signal;
        const abortFromCaller = () => timeoutController.abort();
        callerSignal?.addEventListener('abort', abortFromCaller, { once: true });
        if (callerSignal?.aborted) {
            // An abort event that fired before listener registration must still cancel this request.
            abortFromCaller();
        }

        let response: Response;
        try {
            response = await Promise.race([
                this.fetchImpl(buildUrl(this.baseUrl, path), {
                    ...fetchOptions,
                    credentials: fetchOptions.credentials ?? this.requestCredentials,
                    headers,
                    signal: timeoutController.signal,
                    body: json !== undefined ? JSON.stringify(json) : options.body
                }),
                timeout
            ]);
        } catch (error) {
            if (timedOut) {
                throw timeoutError();
            }
            throw error;
        } finally {
            if (timeoutId !== undefined) clearTimeout(timeoutId);
            callerSignal?.removeEventListener('abort', abortFromCaller);
        }

        const text = await response.text();
        let body: unknown = null;
        if (text.length > 0) {
            try {
                body = JSON.parse(text);
            } catch {
                // Reverse proxies and self-hosted gateways can return plain text or HTML failures.
                body = text;
            }
        }

        if (response.status === 304 && acceptNotModified) {
            return {
                body: null,
                etag: response.headers.get('etag'),
                notModified: true
            } as T;
        }

        if (!response.ok) {
            if (response.status === 426 && isClientUpgradeRequirement(body)) {
                await this.onClientUpgradeRequired?.(body);
            }
            if (response.status === 401 && auth && allowRefresh && this.refreshAccessToken) {
                // A slower response may have left with the access token that another request just
                // refreshed. Retry against that replacement instead of rotating the token pair again.
                if (requestRefreshGeneration !== this.refreshGeneration) {
                    return this.request<T>(path, options, false);
                }
                const refreshed = await this.refreshAccessTokenOnce();
                if (refreshed) {
                    return this.request<T>(path, options, false);
                }
            }
            if (response.status === 401 && auth) {
                await this.onUnauthorized?.();
            }
            const parsedError: ParsedApiError = parseApiError(body, response.headers.get('x-request-id'));
            throw new ApiError(
                getErrorMessage(body, `Request failed with status ${response.status}`),
                response.status,
                body,
                parsedError
            );
        }

        if (response.status === 204) return undefined as T;
        if (responseMetadata) {
            return {
                body,
                etag: response.headers.get('etag'),
                notModified: false
            } as T;
        }
        return body as T;
    }

    private async requestForm<T>(path: string, formData: FormData): Promise<T> {
        return this.request<T>(path, {
            method: 'POST',
            body: formData
        });
    }

    getClientConfig(options: Pick<RequestInit, 'cache'> = {}): Promise<ClientConfigResponse> {
        return this.request<ClientConfigResponse>('/api/client-config', { ...options, auth: false });
    }

    getServerSettings(signal?: AbortSignal): Promise<ServerSettingsResponse> {
        return this.request<ServerSettingsResponse>('/api/server-settings', { cache: 'no-store', signal });
    }

    updateServerSettings(features: ServerFeatures): Promise<ServerSettingsResponse> {
        return this.request<ServerSettingsResponse>('/api/server-settings', {
            method: 'PATCH', cache: 'no-store', json: { features }
        });
    }

    reportClientDiagnostic(input: ClientDiagnosticInput): Promise<ClientDiagnosticResponse> {
        const isAnonymousRootFailure = input.event === 'client_failure'
            && input.operation === 'root_render';
        return this.request<ClientDiagnosticResponse>('/api/client-diagnostics', {
            method: 'POST',
            auth: !isAnonymousRootFailure,
            ...(input.event === 'web_vital' ? { keepalive: true } : {}),
            headers: input.request_id ? { 'x-correlation-id': input.request_id } : undefined,
            json: input
        });
    }

    loginBrowser(payload: BrowserAuthRequest): Promise<BrowserAuthResponse> {
        return this.request<BrowserAuthResponse>('/auth/login', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    registerBrowser(payload: BrowserRegistrationRequest): Promise<BrowserAuthResponse> {
        return this.request<BrowserAuthResponse>('/auth/register', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    resendEmailVerification(payload: EmailVerificationResendRequest = {}): Promise<MessageResponse> {
        return this.request<MessageResponse>('/auth/email-verification/resend', {
            method: 'POST',
            json: payload
        });
    }

    confirmEmailVerification(
        payload: EmailVerificationConfirmRequest
    ): Promise<EmailVerificationConfirmResponse> {
        return this.request<EmailVerificationConfirmResponse>('/auth/email-verification/confirm', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    requestPasswordReset(payload: PasswordResetRequest): Promise<MessageResponse> {
        return this.request<MessageResponse>('/auth/password-reset/request', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    confirmPasswordReset(payload: PasswordResetConfirmRequest): Promise<MessageResponse> {
        return this.request<MessageResponse>('/auth/password-reset/confirm', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    logoutBrowser(): Promise<{ message: string }> {
        return this.request<{ message: string }>('/auth/logout', {
            method: 'POST'
        });
    }

    loginMobile(payload: MobileAuthRequest): Promise<MobileAuthResponse> {
        return this.request<MobileAuthResponse>('/auth/mobile/login', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    registerMobile(payload: MobileRegistrationRequest): Promise<MobileAuthResponse> {
        return this.request<MobileAuthResponse>('/auth/mobile/register', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    refreshMobile<TResponse extends MobileRefreshResponse = MobileRefreshResponse>(refreshToken: string): Promise<TResponse> {
        return this.request<TResponse>('/auth/mobile/refresh', {
            method: 'POST',
            auth: false,
            json: { refresh_token: refreshToken }
        });
    }

    logoutMobile(refreshToken?: string): Promise<{ ok: true }> {
        return this.request<{ ok: true }>('/auth/mobile/logout', {
            method: 'POST',
            auth: false,
            json: refreshToken ? { refresh_token: refreshToken } : {}
        });
    }

    getAccountSessions(): Promise<{ sessions: AccountSessionSummary[] }> {
        return this.request<{ sessions: AccountSessionSummary[] }>('/auth/sessions');
    }

    getConnectedApps(): Promise<{ connections: ConnectedAppSummary[] }> {
        return this.request<{ connections: ConnectedAppSummary[] }>('/api/user/connected-apps');
    }

    revokeConnectedApp(connectionId: string): Promise<{ ok: true }> {
        return this.request<{ ok: true }>(
            '/api/user/connected-apps/' + encodeURIComponent(connectionId),
            { method: 'DELETE' }
        );
    }

    revokeAccountSession(sessionId: string): Promise<{ ok: true; revoked: boolean }> {
        return this.request<{ ok: true; revoked: boolean }>(
            '/auth/sessions/' + encodeURIComponent(sessionId),
            { method: 'DELETE' }
        );
    }

    revokeOtherAccountSessions(): Promise<{ ok: true; revoked: number }> {
        return this.request<{ ok: true; revoked: number }>('/auth/sessions/revoke-others', {
            method: 'POST'
        });
    }

    getMobileSessions(): Promise<{ sessions: MobileSessionSummary[] }> {
        return this.request<{ sessions: MobileSessionSummary[] }>('/auth/mobile/sessions');
    }

    revokeMobileSession(sessionId: number): Promise<{ ok: true; revoked: boolean }> {
        return this.request<{ ok: true; revoked: boolean }>(`/auth/mobile/sessions/${sessionId}`, {
            method: 'DELETE'
        });
    }

    revokeOtherMobileSessions(): Promise<{ ok: true; revoked: number }> {
        return this.request<{ ok: true; revoked: number }>('/auth/mobile/sessions/revoke-others', {
            method: 'POST'
        });
    }

    issueWearPairingCredential(payload: WearPairingCredentialRequest): Promise<WearPairingCredentialResponse> {
        return this.request<WearPairingCredentialResponse>('/auth/mobile/wear/pairing-credential', {
            method: 'POST',
            json: payload
        });
    }

    exchangeWearPairingCredential(payload: WearPairingExchangeRequest): Promise<WearMobileAuthResponse> {
        return this.request<WearMobileAuthResponse>('/auth/mobile/wear/pair', {
            method: 'POST',
            auth: false,
            json: payload
        });
    }

    getWatchSnapshot(ifNoneMatch?: string): Promise<WatchSnapshotFetchResult> {
        return this.request<WatchSnapshotFetchResult>('/api/watch', {
            headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : undefined,
            acceptNotModified: true,
            responseMetadata: true
        });
    }

    executeWatchMutation(payload: WatchMutationRequest, operationId: string): Promise<WatchMutationResponse> {
        return this.request<WatchMutationResponse>('/api/watch/mutations', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getMe(): Promise<{ user: UserClientPayload }> {
        return this.request<{ user: UserClientPayload }>('/auth/me');
    }

    getUserProfile(): Promise<UserProfileResponse> {
        return this.request<UserProfileResponse>('/api/user/profile');
    }

    getLegalStatus(): Promise<LegalAcceptanceStatus> {
        return this.request<LegalAcceptanceStatus>('/api/legal/status');
    }

    acceptLegalDocuments(payload: LegalAcceptanceRequest): Promise<LegalAcceptanceStatus> {
        return this.request<LegalAcceptanceStatus>('/api/legal/acceptance', {
            method: 'POST',
            json: payload
        });
    }


    completeOnboarding(
        payload: OnboardingCompleteRequest,
        operationId: string
    ): Promise<OnboardingCompleteResponse> {
        return this.request<OnboardingCompleteResponse>('/api/onboarding/complete', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getCaloriePlanOptions(payload: CaloriePlanOptionsRequest): Promise<CaloriePlanOptionsResponse> {
        return this.request<CaloriePlanOptionsResponse>('/api/calorie-plan/options', {
            method: 'POST',
            json: payload
        });
    }

    updateProfile(payload: Record<string, unknown>): Promise<{ user: UserClientPayload }> {
        return this.request<{ user: UserClientPayload }>('/api/user/profile', {
            method: 'PATCH',
            json: payload
        });
    }

    updatePreferences(payload: Record<string, unknown>, operationId?: string): Promise<{ user: UserClientPayload }> {
        return this.request<{ user: UserClientPayload }>('/api/user/preferences', {
            method: 'PATCH',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getGoalPaceOptions(): Promise<GoalPaceOptions> {
        return this.request<GoalPaceOptions>('/api/goals/pace-options', { cache: 'no-store' });
    }

    adjustGoalPace(id: number, payload: GoalPaceRequest, operationId: string): Promise<GoalEntry> {
        return this.request<GoalEntry>(`/api/goals/${encodeURIComponent(String(id))}/pace`, {
            method: 'PATCH', headers: buildOperationHeaders(operationId), json: payload
        });
    }

    getGoals(): Promise<GoalEntry | null> {
        return this.request<GoalEntry | null>('/api/goals');
    }

    createGoal(payload: Record<string, unknown>, operationId?: string): Promise<GoalEntry> {
        return this.request<GoalEntry>('/api/goals', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getCalibrationStatus(): Promise<CalibrationStatusResponse> {
        return this.request<CalibrationStatusResponse>('/api/calibration/status');
    }

    applyCalibrationRecommendation(id: number, operationId?: string): Promise<ScheduledCalibrationChange> {
        return this.request<ScheduledCalibrationChange>(
            `/api/calibration/recommendations/${encodeURIComponent(String(id))}/apply`,
            {
                method: 'POST',
                headers: buildOperationHeaders(operationId),
                json: {}
            }
        );
    }

    cancelCalibrationRecommendation(id: number, operationId?: string): Promise<CalibrationStatusResponse> {
        return this.request<CalibrationStatusResponse>(
            `/api/calibration/recommendations/${encodeURIComponent(String(id))}/cancel`,
            {
                method: 'POST',
                headers: buildOperationHeaders(operationId),
                json: {}
            }
        );
    }

    getMetrics(): Promise<MetricEntry[]> {
        return this.request<MetricEntry[]>('/api/metrics');
    }

    getTrendMetrics(params: { range?: 'week' | 'month' | 'year' | 'all'; start?: string; end?: string } = {}): Promise<TrendMetricsResponse> {
        const query = new URLSearchParams();
        query.set('include_trend', 'true');
        if (params.range) query.set('range', params.range);
        if (params.start) query.set('start', params.start);
        if (params.end) query.set('end', params.end);
        return this.request<TrendMetricsResponse>(`/api/metrics?${query.toString()}`);
    }

    addMetric(payload: { weight: number; date: string }, operationId?: string): Promise<MetricSaveResponse> {
        return this.request<MetricSaveResponse>('/api/metrics', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    deleteMetric(id: number, operationId?: string): Promise<void> {
        return this.request<void>(`/api/metrics/${encodeURIComponent(String(id))}`, {
            method: 'DELETE',
            headers: buildOperationHeaders(operationId)
        });
    }

    getFoodLog(date: string): Promise<FoodLogEntry[]> {
        return this.request<FoodLogEntry[]>(`/api/food?date=${encodeURIComponent(date)}`);
    }

    createFoodLog(payload: FoodLogCreatePayload, operationId?: string): Promise<FoodLogEntry> {
        return this.request<FoodLogEntry>('/api/food', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    copyFoodLogs(payload: FoodLogCopyPayload): Promise<FoodLogCopyResponse> {
        return this.request<FoodLogCopyResponse>('/api/food/copy', {
            method: 'POST',
            json: payload
        });
    }

    deleteFoodLog(id: number, operationId?: string): Promise<void> {
        return this.request<void>(`/api/food/${encodeURIComponent(String(id))}`, {
            method: 'DELETE',
            headers: buildOperationHeaders(operationId)
        });
    }

    updateFoodLog(id: number, payload: FoodLogUpdatePayload, operationId?: string): Promise<FoodLogEntry> {
        return this.request<FoodLogEntry>(`/api/food/${encodeURIComponent(String(id))}`, {
            method: 'PATCH',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    searchFood(query: string, barcode?: string): Promise<FoodSearchResponse> {
        const params = new URLSearchParams();
        if (query.trim()) params.set('q', query.trim());
        if (barcode?.trim()) params.set('barcode', barcode.trim());
        return this.request<FoodSearchResponse>(`/api/food/search?${params.toString()}`);
    }

    getRecentFoods(params: RecentFoodsQuery = {}): Promise<RecentFoodsResponse> {
        const query = new URLSearchParams();
        if (params.q?.trim()) query.set('q', params.q.trim());
        if (typeof params.limit === 'number') query.set('limit', String(params.limit));
        if (params.meal_period) query.set('meal_period', params.meal_period);
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return this.request<RecentFoodsResponse>(`/api/food/recent${suffix}`);
    }

    getMyFoods(): Promise<MyFoodSummary[]> {
        return this.request<MyFoodSummary[]>('/api/my-foods');
    }

    getMyFoodsLibrary(options: MyFoodsLibraryQuery = {}): Promise<MyFoodsLibraryResponse> {
        const query = new URLSearchParams();
        if (options.q !== undefined) query.set('q', options.q);
        if (options.type !== undefined) query.set('type', options.type);
        if (options.cursor !== undefined) query.set('cursor', options.cursor);
        if (options.limit !== undefined) query.set('limit', String(options.limit));
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return this.request<MyFoodsLibraryResponse>(`/api/my-foods/library${suffix}`);
    }

    getMyFood(id: number): Promise<MyFoodDetail> {
        return this.request<MyFoodDetail>(`/api/my-foods/${encodeURIComponent(String(id))}`);
    }

    setMyFoodPinned(id: number, isPinned: boolean): Promise<MyFoodSummary> {
        return this.request<MyFoodSummary>(`/api/my-foods/${encodeURIComponent(String(id))}/pin`, {
            method: 'PATCH',
            json: { is_pinned: isPinned }
        });
    }

    scanNutritionLabel(image: Blob | { uri: string; name: string; type: string }, signal?: AbortSignal): Promise<NutritionLabelDraft> {
        const form = new FormData();
        if (typeof Blob !== 'undefined' && image instanceof Blob) form.append('image', image, 'nutrition-label.jpg');
        else form.append('image', image as unknown as Blob);
        // OCR has its own server deadline; leave time for photo upload as well.
        return this.request<NutritionLabelDraft>('/api/nutrition-labels/scan', {
            method: 'POST', body: form, signal, timeoutMs: 60_000
        });
    }

    createMyFood(payload: CreateMyFoodPayload): Promise<MyFoodSummary> {
        return this.request<MyFoodSummary>('/api/my-foods/foods', {
            method: 'POST',
            json: payload
        });
    }

    createRecipe(payload: CreateRecipePayload): Promise<MyFoodSummary> {
        return this.request<MyFoodSummary>('/api/my-foods/recipes', {
            method: 'POST',
            json: payload
        });
    }

    createRecipeFromFoodLogs(payload: CreateRecipeFromFoodLogsPayload): Promise<MyFoodSummary> {
        return this.request<MyFoodSummary>('/api/my-foods/recipes/from-food-logs', {
            method: 'POST',
            json: payload
        });
    }

    updateMyFood(id: number, payload: UpdateMyFoodPayload): Promise<MyFoodSummary> {
        return this.request<MyFoodSummary>(`/api/my-foods/${encodeURIComponent(String(id))}`, {
            method: 'PATCH',
            json: payload
        });
    }

    deleteMyFood(id: number): Promise<void> {
        return this.request<void>(`/api/my-foods/${encodeURIComponent(String(id))}`, {
            method: 'DELETE'
        });
    }

    async previewLoseItImport(file: LoseItImportFile): Promise<LoseItImportSummary> {
        const formData = await this.createLoseItImportForm(file);
        return this.requestForm<LoseItImportSummary>('/api/imports/loseit/preview', formData);
    }

    async executeLoseItImport(file: LoseItImportFile): Promise<LoseItImportSummary> {
        const formData = await this.createLoseItImportForm(file);
        return this.requestForm<LoseItImportSummary>('/api/imports/loseit/execute', formData);
    }

    /** Convert the web DocumentPicker blob URL to a real browser Blob; native keeps its URI descriptor. */
    private async createLoseItImportForm(file: LoseItImportFile): Promise<FormData> {
        const formData = new FormData();
        if (!isNativeLoseItImportFile(file)) {
            const fileName = typeof File !== 'undefined' && file instanceof File ? file.name : 'loseit-export.zip';
            formData.append('file', file, fileName);
            return formData;
        }

        if (isBrowserBlobUri(file.uri)) {
            const response = await this.fetchImpl(file.uri);
            if (!response.ok) {
                throw new Error('Unable to read the selected Lose It export in this browser.');
            }
            formData.append('file', await response.blob(), file.name);
            return formData;
        }

        formData.append('file', file as unknown as Blob);
        return formData;
    }

    async getFoodDay(date: string): Promise<FoodLogDay> {
        const day = await this.request<FoodLogDayResponse>(`/api/food-days?date=${encodeURIComponent(date)}`);
        return normalizeFoodLogDay(day);
    }

    async getFoodDays(start: string, end: string): Promise<FoodLogDayRange> {
        const query = new URLSearchParams({ start, end });
        const range = await this.request<Omit<FoodLogDayRange, 'days'> & { days: FoodLogDayResponse[] }>(
            `/api/food-days/range?${query.toString()}`
        );
        return { ...range, days: range.days.map(normalizeFoodLogDay) };
    }

    getFoodTrackingPause(): Promise<{ pause: FoodTrackingPause }> {
        return this.request<{ pause: FoodTrackingPause }>('/api/food-days/pause');
    }

    async updateFoodDay(payload: { date: string; is_complete: boolean }, operationId?: string): Promise<FoodLogDay> {
        const day = await this.request<FoodLogDayResponse>('/api/food-days', {
            method: 'PATCH',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
        return normalizeFoodLogDay(day);
    }

    async setFoodDayStatus(
        payload: { date: string; status: Exclude<FoodLogDayStatus, 'PAUSED'> },
        operationId?: string
    ): Promise<FoodLogDay> {
        const day = await this.request<FoodLogDayResponse>('/api/food-days', {
            method: 'PATCH',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
        return normalizeFoodLogDay(day);
    }

    startFoodTrackingPause(
        payload: { starts_on: string; expected_resume_on: string | null },
        operationId?: string
    ): Promise<{ pause: FoodTrackingPause }> {
        return this.request<{ pause: FoodTrackingPause }>('/api/food-days/pause', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    updateFoodTrackingPause(
        payload: { expected_resume_on: string | null },
        operationId?: string
    ): Promise<{ pause: FoodTrackingPause }> {
        return this.request<{ pause: FoodTrackingPause }>('/api/food-days/pause', {
            method: 'PATCH',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    resumeFoodTracking(
        payload: { resumed_on: string },
        operationId?: string
    ): Promise<{ pause: FoodTrackingPause; day: FoodLogDay }> {
        return this.request<{ pause: FoodTrackingPause; day: FoodLogDay }>('/api/food-days/resume', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getTrackingHistory(): Promise<{ tracking_start_date: string }> {
        return this.request<{ tracking_start_date: string }>('/api/user/tracking-history');
    }

    getSyncChanges(after = '0', limit?: number): Promise<SyncChangesResponse> {
        const query = new URLSearchParams({ after });
        if (limit !== undefined) query.set('limit', String(limit));
        return this.request<SyncChangesResponse>(`/api/sync/changes?${query.toString()}`);
    }

    getActivityDays(params: { start?: string; end?: string } = {}): Promise<ActivityDaysResponse> {
        const query = new URLSearchParams();
        if (params.start) query.set('start', params.start);
        if (params.end) query.set('end', params.end);
        const suffix = query.toString() ? `?${query.toString()}` : '';
        return this.request<ActivityDaysResponse>(`/api/activity/days${suffix}`);
    }

    syncHealthConnect(
        payload: HealthConnectSyncPayload,
        operationId: string
    ): Promise<HealthConnectSyncResponse> {
        return this.request<HealthConnectSyncResponse>('/api/activity/health-connect/sync', {
            method: 'POST',
            headers: buildOperationHeaders(operationId),
            json: payload
        });
    }

    getInAppNotifications(): Promise<InAppNotificationsResponse>;
    getInAppNotifications(query: InAppNotificationsQuery): Promise<InAppNotificationPageResponse>;
    getInAppNotifications(
        query?: InAppNotificationsQuery
    ): Promise<InAppNotificationsResponse | InAppNotificationPageResponse> {
        if (!query) {
            return this.request<InAppNotificationsResponse>('/api/notifications/in-app');
        }

        const params = new URLSearchParams({ view: query.view });
        if (query.limit !== undefined) params.set('limit', String(query.limit));
        if (query.cursor !== undefined) params.set('cursor', query.cursor);
        return this.request<InAppNotificationPageResponse>('/api/notifications/in-app?' + params.toString());
    }

    getBrowserPushPublicKey(): Promise<{ publicKey: string }> {
        return this.request<{ publicKey: string }>('/api/notifications/public-key');
    }

    registerBrowserPushSubscription(payload: BrowserPushSubscriptionPayload): Promise<{ ok: true }> {
        return this.request<{ ok: true }>('/api/notifications/subscription', {
            method: 'POST',
            json: payload
        });
    }

    unregisterBrowserPushSubscription(endpoint: string): Promise<{ ok: true }> {
        return this.request<{ ok: true }>('/api/notifications/subscription', {
            method: 'DELETE',
            json: { endpoint }
        });
    }

    dismissInAppNotification(id: number): Promise<{ ok: true }> {
        return this.request<{ ok: true }>(`/api/notifications/in-app/${encodeURIComponent(String(id))}/dismiss`, {
            method: 'PATCH'
        });
    }

    markInAppNotificationRead(id: number): Promise<{ ok: true }> {
        return this.request<{ ok: true }>(`/api/notifications/in-app/${encodeURIComponent(String(id))}/read`, {
            method: 'PATCH'
        });
    }

    markAllInAppNotificationsRead(): Promise<MarkAllInAppNotificationsReadResponse> {
        return this.request<MarkAllInAppNotificationsReadResponse>('/api/notifications/in-app/read-all', {
            method: 'PATCH'
        });
    }

    updateProfileImage(dataUrl: string): Promise<{ user: UserClientPayload }> {
        return this.request<{ user: UserClientPayload }>('/api/user/profile-image', {
            method: 'PUT',
            json: { data_url: dataUrl }
        });
    }

    deleteProfileImage(): Promise<{ user: UserClientPayload }> {
        return this.request<{ user: UserClientPayload }>('/api/user/profile-image', {
            method: 'DELETE'
        });
    }

    changePassword(payload: { current_password: string; new_password: string }): Promise<{ message: string }> {
        return this.request<{ message: string }>('/api/user/password', {
            method: 'PATCH',
            json: payload
        });
    }

    exportAccount(): Promise<AccountExport> {
        return this.request<AccountExport>('/api/user/account/export');
    }

    deleteAccount(currentPassword: string): Promise<void> {
        return this.request<void>('/api/user/account', {
            method: 'DELETE',
            json: { current_password: currentPassword }
        });
    }

    registerNativePushSubscription(payload: NativePushSubscriptionPayload): Promise<{ ok: true }> {
        return this.request<{ ok: true }>('/api/notifications/native-subscription', {
            method: 'POST',
            json: payload
        });
    }

    unregisterNativePushSubscription(payload: Partial<NativePushSubscriptionPayload>): Promise<{ ok: true }> {
        return this.request<{ ok: true }>('/api/notifications/native-subscription', {
            method: 'DELETE',
            json: payload
        });
    }
}
