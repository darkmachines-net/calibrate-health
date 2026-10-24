/** @file Browser and native authentication routes, credential recovery, account sessions, and watch pairing exchange. */

import { verifyLocalPassword } from '../services/credentialVerification';
import express from 'express';
import { BrowserLoginRejected } from '../utils/browserLoginCredentials';
import passport from 'passport';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { normalizeEmailCredential, validatePasswordCredential } from '../utils/authCredentials';
import {
    serializeUserForClient,
    USER_CLIENT_SELECT,
    type UserForClient
} from '../utils/userSerialization';
import {
    exchangeWearPairingCredential,
    formatMobileAuthResponse,
    issueMobileAuthPayload,
    issueVerifiedMobileAuthPayload,
    issueWearPairingCredential,
    listMobileSessionsForUser,
    normalizePairingServerOrigin,
    parseMobileDevicePayload,
    refreshMobileSession,
    revokeMobileSessionByAccessToken,
    revokeMobileSessionByRefreshToken,
    revokeMobileSessionForUser,
    revokeOtherMobileSessionsForUser
} from '../services/mobileAuth';
import { diagnosticsRegistry, logSafeOperationalError } from '../observability';
import { clearSessionCookie } from '../utils/sessionCookie';
import { getAuthenticatedUser } from '../middleware/authenticatedUser';
import {
    CURRENT_PRIVACY_VERSION,
    CURRENT_TERMS_VERSION
} from '../../../shared/legalVersions';
import {
    EMAIL_DELIVERY_MODES,
    isEmailVerificationRequired,
    resolveEmailDeliveryConfig
} from '../config/emailDelivery';
import {
    confirmEmailVerification,
    resetPasswordWithToken,
    sendEmailVerification,
    sendPasswordReset
} from '../services/accountTokens';
import {
    listAccountSessionsForUser,
    parseAccountSessionId,
    revokeAccountSessionForUser,
    revokeOtherAccountSessionsForUser
} from '../services/accountSessions';

/**
 * Session-based auth endpoints (register/login/logout/me).
 *
 * Routes return a sanitized user payload for client state hydration.
 */
const router = express.Router();

const INVALID_LOGIN_MESSAGE = 'Invalid email or password';
const REGISTRATION_FAILED_MESSAGE = 'Unable to create account';
const GENERIC_EMAIL_RESPONSE = 'If the account is eligible, email instructions will be sent.';

const invalidLegalResponse = (code: 'INVALID_LEGAL_ACCEPTANCE' | 'INVALID_LEGAL_VERSION') => ({
    message: code === 'INVALID_LEGAL_VERSION'
        ? 'Accept the current Terms and Privacy Policy versions.'
        : 'Terms and Privacy acceptance is required.',
    code,
    retryable: false
});

const validateRegistrationLegalAcceptance = (body: unknown):
    | { ok: true }
    | { ok: false; code: 'INVALID_LEGAL_ACCEPTANCE' | 'INVALID_LEGAL_VERSION' } => {
    const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    if (record.accept_terms !== true || record.accept_privacy !== true) {
        return { ok: false, code: 'INVALID_LEGAL_ACCEPTANCE' };
    }
    if (
        record.terms_version !== CURRENT_TERMS_VERSION ||
        record.privacy_version !== CURRENT_PRIVACY_VERSION
    ) {
        return { ok: false, code: 'INVALID_LEGAL_VERSION' };
    }
    return { ok: true };
};

const isUniqueConstraintError = (err: unknown): boolean =>
    Boolean(err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002');

const destroyRequestSession = async (req: express.Request): Promise<void> => {
    if (!req.session) return;
    await new Promise<void>((resolve, reject) => {
        req.session.destroy((error) => error ? reject(error) : resolve());
    });
};

const scheduleAccountEmail = (task: () => Promise<unknown>): void => {
    setImmediate(() => {
        void task().catch(() => {
            // Public request responses remain enumeration-safe; delivery state is intentionally hidden.
        });
    });
};

router.post('/register', async (req, res) => {
    const email = normalizeEmailCredential(req.body?.email);
    if (!email) {
        return res.status(400).json({ message: 'Invalid email' });
    }

    const password = req.body?.password;
    const passwordError = validatePasswordCredential(password);
    if (passwordError) {
        return res.status(400).json({ message: passwordError });
    }
    const emailConfig = resolveEmailDeliveryConfig();
    if (emailConfig.hostedRequired) {
        const legal = validateRegistrationLegalAcceptance(req.body);
        if (!legal.ok) {
            return res.status(400).json(invalidLegalResponse(legal.code));
        }
    }
    if (emailConfig.hostedRequired && emailConfig.mode === EMAIL_DELIVERY_MODES.DISABLED) {
        return res.status(503).json({
            message: 'Account email delivery is temporarily unavailable.',
            code: 'EMAIL_DELIVERY_UNAVAILABLE',
            retryable: true
        });
    }
    const verificationRequired = isEmailVerificationRequired(emailConfig);

    try {
        const existingUser = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { id: true }
        });
        if (existingUser) {
            return res.status(400).json({ message: REGISTRATION_FAILED_MESSAGE });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUser = await prisma.user.create({
            data: {
                email,
                password_hash,
                email_verified_at: verificationRequired ? null : new Date(),
                legal_acceptances: emailConfig.hostedRequired ? {
                    create: {
                        terms_version: CURRENT_TERMS_VERSION,
                        privacy_version: CURRENT_PRIVACY_VERSION
                    }
                } : undefined
            },
            select: USER_CLIENT_SELECT
        });

        if (verificationRequired) {
            const delivered = await sendEmailVerification(newUser.id);
            if (!delivered) {
                await prisma.user.delete({ where: { id: newUser.id } });
                return res.status(503).json({
                    message: 'Account email delivery is temporarily unavailable.',
                    code: 'EMAIL_DELIVERY_UNAVAILABLE',
                    retryable: true
                });
            }
        }

        req.login(newUser, (err) => {
            if (err) {
                logSafeOperationalError('auth.register_session', err, res.locals?.requestId);
                res.status(500).json({ message: 'Server error' });
                return;
            }
            res.json({ user: serializeUserForClient(newUser) });
        });
    } catch (err) {
        if (isUniqueConstraintError(err)) {
            return res.status(400).json({ message: REGISTRATION_FAILED_MESSAGE });
        }
        logSafeOperationalError('auth.register', err, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/mobile/register', async (req, res) => {
    const email = normalizeEmailCredential(req.body?.email);
    if (!email) {
        return res.status(400).json({ message: 'Invalid email' });
    }

    const password = req.body?.password;
    const passwordError = validatePasswordCredential(password);
    if (passwordError) {
        return res.status(400).json({ message: passwordError });
    }
    const device = parseMobileDevicePayload(req.body);
    if (!device.ok) {
        return res.status(400).json({ message: device.message });
    }
    if (device.device.devicePlatform === 'WEAR_OS') {
        return res.status(400).json({ message: 'Wear OS sessions require phone pairing' });
    }

    const emailConfig = resolveEmailDeliveryConfig();
    if (emailConfig.hostedRequired) {
        const legal = validateRegistrationLegalAcceptance(req.body);
        if (!legal.ok) {
            return res.status(400).json(invalidLegalResponse(legal.code));
        }
    }
    if (emailConfig.hostedRequired && emailConfig.mode === EMAIL_DELIVERY_MODES.DISABLED) {
        return res.status(503).json({
            message: 'Account email delivery is temporarily unavailable.',
            code: 'EMAIL_DELIVERY_UNAVAILABLE',
            retryable: true
        });
    }
    const verificationRequired = isEmailVerificationRequired(emailConfig);

    try {
        const existingUser = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { id: true }
        });
        if (existingUser) {
            return res.status(400).json({ message: REGISTRATION_FAILED_MESSAGE });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(password, salt);
        const newUser = await prisma.user.create({
            data: {
                email,
                password_hash,
                email_verified_at: verificationRequired ? null : new Date(),
                legal_acceptances: emailConfig.hostedRequired ? {
                    create: {
                        terms_version: CURRENT_TERMS_VERSION,
                        privacy_version: CURRENT_PRIVACY_VERSION
                    }
                } : undefined
            },
            select: USER_CLIENT_SELECT
        });

        if (verificationRequired) {
            const delivered = await sendEmailVerification(newUser.id);
            if (!delivered) {
                await prisma.user.delete({ where: { id: newUser.id } });
                return res.status(503).json({
                    message: 'Account email delivery is temporarily unavailable.',
                    code: 'EMAIL_DELIVERY_UNAVAILABLE',
                    retryable: true
                });
            }
        }

        const authPayload = await issueMobileAuthPayload({
            userId: newUser.id,
            device: device.device
        });
        if (!authPayload) {
            return res.status(500).json({ message: 'Server error' });
        }

        res.json(formatMobileAuthResponse(authPayload));
    } catch (err) {
        if (isUniqueConstraintError(err)) {
            return res.status(400).json({ message: REGISTRATION_FAILED_MESSAGE });
        }
        logSafeOperationalError('auth.mobile_register', err, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/email-verification/resend', async (req, res) => {
    try {
        let userId: number | null = null;
        if (req.isAuthenticated()) {
            userId = getAuthenticatedUser(req).id;
        } else {
            const email = normalizeEmailCredential(req.body?.email);
            if (email) {
                const user = await prisma.user.findFirst({
                    where: { email: { equals: email, mode: 'insensitive' } },
                    select: { id: true }
                });
                userId = user?.id ?? null;
            }
        }
        if (userId) {
            scheduleAccountEmail(() => sendEmailVerification(userId));
        }
    } catch {
        // Enumeration-safe responses deliberately hide account and delivery state.
    }
    return res.status(202).json({ message: GENERIC_EMAIL_RESPONSE });
});

router.post('/email-verification/confirm', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token || token.length > 512) {
        return res.status(400).json({
            message: 'This verification link is invalid or expired.',
            code: 'INVALID_OR_EXPIRED_TOKEN',
            retryable: false
        });
    }
    try {
        const accountAccess = await confirmEmailVerification(token);
        if (!accountAccess) {
            return res.status(400).json({
                message: 'This verification link is invalid or expired.',
                code: 'INVALID_OR_EXPIRED_TOKEN',
                retryable: false
            });
        }
        return res.json({
            message: 'Email verified.',
            account_access: accountAccess
        });
    } catch (error) {
        logSafeOperationalError('auth.email_verification_confirm', error, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/password-reset/request', async (req, res) => {
    try {
        const email = normalizeEmailCredential(req.body?.email);
        if (email) {
            const user = await prisma.user.findFirst({
                where: { email: { equals: email, mode: 'insensitive' } },
                select: { id: true, email: true }
            });
            if (user) {
                scheduleAccountEmail(() => sendPasswordReset(user.id, user.email));
            }
        }
    } catch {
        // Enumeration-safe responses deliberately hide account and delivery state.
    }
    return res.status(202).json({ message: GENERIC_EMAIL_RESPONSE });
});

router.post('/password-reset/confirm', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    const newPassword = req.body?.new_password;
    const passwordError = validatePasswordCredential(newPassword, 'New password');
    if (passwordError) return res.status(400).json({ message: passwordError });
    if (!token || token.length > 512) {
        return res.status(400).json({
            message: 'This password reset link is invalid or expired.',
            code: 'INVALID_OR_EXPIRED_TOKEN',
            retryable: false
        });
    }

    try {
        const reset = await resetPasswordWithToken(token, newPassword);
        if (!reset) {
            return res.status(400).json({
                message: 'This password reset link is invalid or expired.',
                code: 'INVALID_OR_EXPIRED_TOKEN',
                retryable: false
            });
        }
        await destroyRequestSession(req);
        clearSessionCookie(res);
        return res.json({ message: 'Password reset. Sign in with your new password.' });
    } catch (error) {
        logSafeOperationalError('auth.password_reset_confirm', error, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/login', (req, res, next) => {
    const email = normalizeEmailCredential(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ message: INVALID_LOGIN_MESSAGE });
    }

    // Keep LocalStrategy lookup normalized while still letting Passport own session establishment.
    req.body.email = email;

    passport.authenticate('local', (err: Error | null, user: Express.User | false | null) => {
        if (err) return next(err);
        if (!user) {
            return res.status(401).json({ message: INVALID_LOGIN_MESSAGE });
        }

        req.login(user, async (loginErr) => {
            if (loginErr) {
                delete req.user;
                try { await destroyRequestSession(req); }
                catch (error) { logSafeOperationalError('auth.login_cleanup', error, res.locals?.requestId); }
                // Express must not retry saving authenticated state after a rejected store write.
                req.session = null as unknown as express.Request['session'];
                clearSessionCookie(res);
                if (loginErr instanceof BrowserLoginRejected) {
                    return res.status(401).json({ message: INVALID_LOGIN_MESSAGE });
                }
                return next(loginErr);
            }
            return res.json({
                user: serializeUserForClient(user as UserForClient)
            });
        });
    })(req, res, next);
});

router.post('/mobile/login', async (req, res) => {
    const email = normalizeEmailCredential(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== 'string' || password.length === 0) {
        return res.status(400).json({ message: INVALID_LOGIN_MESSAGE });
    }

    const device = parseMobileDevicePayload(req.body);
    if (!device.ok) {
        return res.status(400).json({ message: device.message });
    }
    if (device.device.devicePlatform === 'WEAR_OS') {
        return res.status(400).json({ message: 'Wear OS sessions require phone pairing' });
    }

    try {
        const user = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
            select: { ...USER_CLIENT_SELECT, password_hash: true, credential_security_version: true }
        });
        const isMatch = await verifyLocalPassword(password, user?.password_hash);
        if (!user || !isMatch) {
            return res.status(401).json({ message: INVALID_LOGIN_MESSAGE });
        }

        const authPayload = await issueVerifiedMobileAuthPayload({
            userId: user.id,
            credentialSecurityVersion: user.credential_security_version,
            device: device.device
        });
        if (!authPayload) {
            return res.status(401).json({ message: INVALID_LOGIN_MESSAGE });
        }

        res.json(formatMobileAuthResponse(authPayload));
    } catch (err) {
        logSafeOperationalError('auth.mobile_login', err, res.locals?.requestId);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/mobile/refresh', async (req, res) => {
    const startedAt = Date.now();
    const refreshToken =
        req.body && typeof req.body === 'object' && typeof (req.body as { refresh_token?: unknown }).refresh_token === 'string'
            ? (req.body as { refresh_token: string }).refresh_token.trim()
            : '';

    if (!refreshToken) {
        diagnosticsRegistry.recordOperation('auth_mobile_refresh', 'rejected', Date.now() - startedAt);
        return res.status(400).json({ message: 'refresh_token is required' });
    }

    try {
        const authPayload = await refreshMobileSession(refreshToken);
        if (!authPayload) {
            diagnosticsRegistry.recordOperation('auth_mobile_refresh', 'rejected', Date.now() - startedAt);
            return res.status(401).json({ message: 'Invalid or expired refresh token' });
        }

        diagnosticsRegistry.recordOperation('auth_mobile_refresh', 'success', Date.now() - startedAt);
        res.json(formatMobileAuthResponse(authPayload));
    } catch (err) {
        diagnosticsRegistry.recordOperation('auth_mobile_refresh', 'failure', Date.now() - startedAt);
        logSafeOperationalError('auth.mobile_refresh', err, res.locals?.requestId);
        res.status(500).json({ message: 'Server error' });
    }
});

router.post('/mobile/wear/pairing-credential', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }
    const user = getAuthenticatedUser(req);
    const issuingSessionId = res.locals.mobileAuthSessionId as number | undefined;
    if (!issuingSessionId) {
        return res.status(403).json({
            message: 'Wear pairing requires an authenticated Android phone session',
            code: 'PAIRING_PHONE_SESSION_REQUIRED',
            retryable: false
        });
    }
    const pairingRequest = req.body && typeof req.body === 'object'
        ? req.body as Record<string, unknown>
        : {};
    const serverOrigin = pairingRequest.server_origin;
    const normalizedServerOrigin = normalizePairingServerOrigin(serverOrigin);
    if (!normalizedServerOrigin) {
        return res.status(400).json({
            message: 'valid server_origin is required',
            code: 'INVALID_PAIRING_REQUEST',
            retryable: false
        });
    }

    try {
        const result = await issueWearPairingCredential({
            userId: user.id,
            issuingSessionId,
            serverOrigin: normalizedServerOrigin,
            watchDeviceId: pairingRequest.watch_device_id,
            watchDeviceName: pairingRequest.watch_device_name,
            protocolVersion: pairingRequest.protocol_version,
            watchPublicKeySpki: pairingRequest.watch_public_key_spki
        });
        if (!result.ok) {
            return res.status(result.status).json({
                message: result.message,
                code: result.code,
                retryable: false
            });
        }
        const credential = result.credential;
        return res.status(201).json({
            pairing_token: credential.pairingToken,
            server_origin: credential.serverOrigin,
            watch_device_id: credential.watchDeviceId,
            protocol_version: credential.protocolVersion,
            challenge: credential.challenge,
            expires_at: credential.expiresAt.toISOString()
        });
    } catch (error) {
        logSafeOperationalError('auth.wear_pairing_issue', error, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/mobile/wear/pair', async (req, res) => {
    try {
        const result = await exchangeWearPairingCredential(req.body);
        if (!result.ok) {
            return res.status(result.status).json({
                message: result.message,
                code: result.code,
                retryable: false
            });
        }
        return res.json(formatMobileAuthResponse(result.payload));
    } catch (error) {
        logSafeOperationalError('auth.wear_pairing_exchange', error, res.locals?.requestId);
        return res.status(500).json({ message: 'Server error' });
    }
});

router.post('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) { return next(err); }
        req.session.destroy((destroyError) => {
            if (destroyError) return next(destroyError);
            clearSessionCookie(res);
            res.json({ message: 'Logged out' });
        });
    });
});

router.post('/mobile/logout', async (req, res) => {
    const refreshToken =
        req.body && typeof req.body === 'object' && typeof (req.body as { refresh_token?: unknown }).refresh_token === 'string'
            ? (req.body as { refresh_token: string }).refresh_token.trim()
            : '';
    const authorization = req.get('authorization');
    const accessToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

    try {
        if (refreshToken) {
            await revokeMobileSessionByRefreshToken(refreshToken);
        } else if (accessToken) {
            await revokeMobileSessionByAccessToken(accessToken);
        }

        res.json({ ok: true });
    } catch (err) {
        logSafeOperationalError('auth.mobile_logout', err, res.locals?.requestId);
        res.status(500).json({ message: 'Server error' });
    }
});

router.get('/sessions', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }

    const user = getAuthenticatedUser(req);
    const currentMobileSessionId = res.locals.mobileAuthSessionId as number | undefined;
    const sessions = await listAccountSessionsForUser({
        userId: user.id,
        currentBrowserSessionId: currentMobileSessionId ? undefined : req.sessionID,
        currentMobileSessionId
    });
    res.json({ sessions });
});

router.delete('/sessions/:sessionId', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }
    if (!parseAccountSessionId(req.params.sessionId)) {
        return res.status(400).json({ message: 'Invalid account session id' });
    }

    const user = getAuthenticatedUser(req);
    const currentMobileSessionId = res.locals.mobileAuthSessionId as number | undefined;
    const result = await revokeAccountSessionForUser({
        userId: user.id,
        sessionId: req.params.sessionId,
        currentBrowserSessionId: currentMobileSessionId ? undefined : req.sessionID,
        currentMobileSessionId
    });
    if (result.current) {
        return res.status(400).json({ message: 'Sign out to end the current session.' });
    }
    res.json({ ok: true, revoked: result.revoked });
});

router.post('/sessions/revoke-others', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }

    const user = getAuthenticatedUser(req);
    const currentMobileSessionId = res.locals.mobileAuthSessionId as number | undefined;
    const revoked = await revokeOtherAccountSessionsForUser({
        userId: user.id,
        currentBrowserSessionId: currentMobileSessionId ? undefined : req.sessionID,
        currentMobileSessionId
    });
    res.json({ ok: true, revoked });
});

router.get('/mobile/sessions', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }

    const user = getAuthenticatedUser(req);
    const sessions = await listMobileSessionsForUser(user.id, res.locals.mobileAuthSessionId);
    res.json({ sessions });
});

router.delete('/mobile/sessions/:sessionId', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }

    const sessionId = Number(req.params.sessionId);
    if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
        return res.status(400).json({ message: 'Invalid mobile session id' });
    }

    const user = getAuthenticatedUser(req);
    const revoked = await revokeMobileSessionForUser(user.id, sessionId);
    res.json({ ok: true, revoked });
});

router.post('/mobile/sessions/revoke-others', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ message: 'Not authenticated' });
    }

    const user = getAuthenticatedUser(req);
    const revoked = await revokeOtherMobileSessionsForUser(user.id, res.locals.mobileAuthSessionId);
    res.json({ ok: true, revoked });
});

router.get('/me', async (req, res) => {
    if (req.isAuthenticated()) {
        const user = getAuthenticatedUser(req);
        try {
            // Refresh from the database to avoid stale session snapshots.
            const dbUser = await prisma.user.findUnique({ where: { id: user.id }, select: USER_CLIENT_SELECT });
            if (!dbUser) {
                return res.status(401).json({ message: 'Not authenticated' });
            }

            res.json({ user: serializeUserForClient(dbUser) });
        } catch (err) {
            logSafeOperationalError('auth.me', err, res.locals?.requestId);
            res.status(500).json({ message: 'Server error' });
        }
    } else {
        res.status(401).json({ message: 'Not authenticated' });
    }
});

export default router;
