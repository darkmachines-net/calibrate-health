/** @file Express server startup, route mounting, session middleware, and process lifecycle. */

import 'dotenv/config';
import { markVerifiedBrowserLogin, serializeBrowserLoginUser } from './utils/browserLoginCredentials';
import { verifyLocalPassword } from './services/credentialVerification';

import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import { resolveBrowserOriginPolicy } from './config/cors';
import prisma, { pgPool } from './config/database';
import { isProductionOrStagingEnv } from './config/environment';
import { getNativePushModeConfigurationWarning } from './config/nativePush';
import { resolveMcpConfiguration } from './config/mcp';
import { validateCredentialProviderConfiguration } from './config/credentialProvider';
import { configureFrontendStaticAssets } from './frontendStatic';
import authRoutes from './routes/auth';
import clientConfigRoutes from './routes/clientConfig';
import serverSettingsRoutes from './routes/serverSettings';
import clientDiagnosticsRoutes from './routes/clientDiagnostics';
import devRoutes from './routes/dev';
import devTestRoutes from './routes/devTest';
import foodRoutes from './routes/food';
import foodDayRoutes from './routes/foodDays';
import goalRoutes from './routes/goals';
import importRoutes from './routes/imports';
import metricRoutes from './routes/metrics';
import activityRoutes from './routes/activity';
import myFoodsRoutes from './routes/myFoods';
import nutritionLabelsRoutes from './routes/nutritionLabels';
import notificationRoutes from './routes/notifications';
import syncRoutes from './routes/sync';
import userRoutes from './routes/user';
import watchRoutes from './routes/watch';
import calibrationRoutes from './routes/calibration';
import caloriePlanRoutes from './routes/caloriePlan';
import legalRoutes from './routes/legal';
import onboardingRoutes from './routes/onboarding';
import { authenticateMobileBearerToken } from './middleware/mobileAuth';
import { enforceNativeClientCompatibility } from './middleware/clientCompatibility';
import { enforceAccountAccess } from './middleware/accountAccess';
import { createCorsOptionsDelegate } from './middleware/cors';
import {
  apiRouteNotFoundHandler,
  apiRequestErrorHandler,
  createApiErrorResponseMiddleware
} from './middleware/apiErrorResponse';
import {
  createAuthRateLimiters,
  createBrowserMutationOriginGuard,
  createClientDiagnosticsRateLimiter
} from './middleware/security';
import { startReminderScheduler } from './services/reminderScheduler';
import { createCalibrateMcpHttpApp, isCalibrateMcpPath } from './mcp/server';
import { checkDatabaseReadiness } from './services/readiness';
import { normalizeEmailCredential } from './utils/authCredentials';
import { autoLoginTestUser } from './utils/devAuth';
import { DEFAULT_SESSION_TTL_MS, PostgresSessionStore } from './utils/postgresSessionStore';
import { USER_CLIENT_SELECT } from './utils/userSerialization';
import {
  createDiagnosticsMetricsHandler,
  createRequestObservabilityMiddleware,
  emitDiagnosticEvent,
  logSafeOperationalError,
  resolveObservabilityConfig
} from './observability';

const SESSION_TTL_MS = DEFAULT_SESSION_TTL_MS;
validateCredentialProviderConfiguration();

type SameSiteSetting = 'lax' | 'none' | 'strict';

/**
 * Map SESSION_COOKIE_SAMESITE to an express-session SameSite value.
 * Defaults to 'lax' because localhost and subdomains remain same-site in typical deployments.
 */
const parseSameSite = (value: string | undefined): SameSiteSetting => {
  if (!value) return 'lax';

  const normalized = value.trim().toLowerCase();
  if (normalized === 'none') return 'none';
  if (normalized === 'strict') return 'strict';
  return 'lax';
};

/**
 * Resolve the express-session signing secret for cookie/session integrity.
 *
 * In production/staging we fail fast because a missing secret weakens session security and will
 * silently invalidate cookies across deploys. In development we allow a fixed default to keep
 * local setups lightweight.
 */
function resolveSessionSecret(isProductionOrStaging: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.SESSION_SECRET?.trim();
  if (secret) return secret;

  if (isProductionOrStaging) {
    throw new Error('SESSION_SECRET is required in production/staging (set it to a long random string).');
  }

  console.warn(
    'SESSION_SECRET is not set; using development default. Set SESSION_SECRET to keep sessions stable across restarts.'
  );
  return 'development_secret_key';
}

/**
 * Initialize Express middleware (CORS, sessions, Passport) and start the HTTP server.
 */
const bootstrap = async (): Promise<void> => {
  const app = express();
  const PORT = process.env.PORT || 3000;
  const isProductionOrStaging = isProductionOrStagingEnv(process.env.NODE_ENV);
  const observabilityConfig = resolveObservabilityConfig(process.env);
  const nativePushConfigurationWarning = getNativePushModeConfigurationWarning(process.env);
  const mcpConfiguration = resolveMcpConfiguration(process.env);

  // Reduce fingerprinting surface for minimal Express signature.
  app.disable('x-powered-by');
  app.use(createRequestObservabilityMiddleware({ config: observabilityConfig }));
  app.use(createApiErrorResponseMiddleware());
  app.use(helmet({
    // A deployment-aware CSP needs to account for self-hosted proxy and food-image origins.
    contentSecurityPolicy: false,
    ...(isProductionOrStaging ? {} : { strictTransportSecurity: false })
  }));
  app.get('/internal/diagnostics/metrics', createDiagnosticsMetricsHandler({ config: observabilityConfig }));
  const authRateLimiters = createAuthRateLimiters();
  const clientDiagnosticsRateLimiter = createClientDiagnosticsRateLimiter();

  const secureCookieEnv = process.env.SESSION_COOKIE_SECURE;
  const useSecureCookies = secureCookieEnv ? secureCookieEnv === 'true' : isProductionOrStaging;
  const sameSite = parseSameSite(process.env.SESSION_COOKIE_SAMESITE);
  const sessionSecret = resolveSessionSecret(isProductionOrStaging);

  if (
    observabilityConfig.enabled &&
    observabilityConfig.metricsToken !== null &&
    !observabilityConfig.metricsEnabled
  ) {
    console.warn(
      'CALIBRATE_DIAGNOSTICS_METRICS_TOKEN must contain at least 32 characters; the diagnostics metrics endpoint is disabled.'
    );
  }

  if (nativePushConfigurationWarning) {
    console.warn(nativePushConfigurationWarning);
  }

  if (useSecureCookies) {
    app.set('trust proxy', 1);
  }

  const mcpHttpApp = mcpConfiguration.enabled
    ? createCalibrateMcpHttpApp({
      publicUrl: mcpConfiguration.publicUrl,
      allowedHosts: mcpConfiguration.allowedHosts,
      trustedProxyHops: useSecureCookies ? 1 : 0,
      // Share one credential-guess budget across ordinary and connected-assistant login.
      oauthApprovalRateLimiter: authRateLimiters.login
    })
    : null;
  // MCP and its OAuth protocol endpoints own cross-origin policy and bearer auth. Mount them
  // before browser CORS and mobile bearer middleware so remote public clients can connect safely.
  app.use((req, res, next) => {
    if (!mcpHttpApp || !isCalibrateMcpPath(req.path)) {
      next();
      return;
    }
    mcpHttpApp(req, res, next);
  });

  const browserOriginPolicy = resolveBrowserOriginPolicy(process.env.CORS_ORIGINS, isProductionOrStaging);
  const allowedOriginSet = browserOriginPolicy.exactOrigins;

  app.use(cors(createCorsOptionsDelegate({
    originPolicy: browserOriginPolicy,
    isProductionOrStaging,
    useSecureRequestOrigin: useSecureCookies
  })));
  app.use(['/api/v1/client-diagnostics', '/api/client-diagnostics'], clientDiagnosticsRateLimiter);
  app.use('/auth/register', authRateLimiters.registration);
  app.use('/auth/mobile/register', authRateLimiters.registration);
  app.use('/auth/login', authRateLimiters.login);
  app.use('/auth/mobile/login', authRateLimiters.login);
  app.use('/auth/mobile/refresh', authRateLimiters.refresh);
  app.use('/auth/email-verification/resend', authRateLimiters.accountEmailRequest);
  app.use('/auth/password-reset/request', authRateLimiters.accountEmailRequest);
  app.use('/auth/email-verification/confirm', authRateLimiters.accountTokenConfirm);
  app.use('/auth/password-reset/confirm', authRateLimiters.accountTokenConfirm);
  app.use('/auth/mobile/wear/pairing-credential', authRateLimiters.pairingIssueIp);
  app.use('/auth/mobile/wear/pair', authRateLimiters.pairingExchange);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));

  const sessionStore = new PostgresSessionStore(pgPool, SESSION_TTL_MS);
  await sessionStore.initialize();

  app.use(
    session({
      store: sessionStore,
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      proxy: useSecureCookies,
      name: process.env.SESSION_COOKIE_NAME || 'cal.sid',
      cookie: {
        httpOnly: true,
        secure: useSecureCookies,
        sameSite,
        domain: process.env.SESSION_COOKIE_DOMAIN,
        maxAge: SESSION_TTL_MS,
      },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());
  app.use(authenticateMobileBearerToken);
  app.use(enforceNativeClientCompatibility);
  app.use(createBrowserMutationOriginGuard({
    trustedOrigins: allowedOriginSet,
    useSecureRequestOrigin: useSecureCookies,
    allowDevelopmentLoopbackOrigins: browserOriginPolicy.allowDevelopmentLoopbackOrigins
  }));
  app.use('/auth/mobile/wear/pairing-credential', authRateLimiters.pairingIssue);
  app.use(autoLoginTestUser);
  app.use(enforceAccountAccess);

  passport.use(
    new LocalStrategy({ usernameField: 'email' }, async (email, password, done) => {
      try {
        const normalizedEmail = normalizeEmailCredential(email);
        if (!normalizedEmail || typeof password !== 'string' || password.length === 0) {
          return done(null, false, { message: 'Invalid email or password' });
        }

        const user = await prisma.user.findFirst({
          where: { email: { equals: normalizedEmail, mode: 'insensitive' } },
          orderBy: { id: 'asc' },
          select: { ...USER_CLIENT_SELECT, password_hash: true, credential_security_version: true },
        });
        const isMatch = await verifyLocalPassword(password, user?.password_hash);
        if (!user || !isMatch) {
          return done(null, false, { message: 'Invalid email or password' });
        }

        // Avoid keeping password hashes on req.user or in the session.
        const { password_hash: _passwordHash, credential_security_version: version, ...safeUser } = user;
        markVerifiedBrowserLogin(safeUser, user.id, version);
        return done(null, safeUser);
      } catch (err) {
        return done(err);
      }
    })
  );

  passport.serializeUser(serializeBrowserLoginUser);

  passport.deserializeUser(async (id: number, done) => {
    try {
      // Keep req.user small and non-sensitive; routes can fetch extra columns as needed.
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          weight_unit: true,
          height_unit: true,
          timezone: true,
          date_of_birth: true,
          sex: true,
          height_mm: true,
          activity_level: true,
        },
      });
      done(null, user);
    } catch (err) {
      done(err);
    }
  });

  app.use('/auth', authRoutes);
  const apiRouter = express.Router();
  // Versioned clients use /api/v1; /api remains a compatibility alias during migration.
  app.use('/api/v1', apiRouter);
  app.use('/api', apiRouter);

  apiRouter.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  apiRouter.get('/readyz', async (_req, res) => {
    const ready = await checkDatabaseReadiness(() => pgPool.query('SELECT 1'));
    res.status(ready ? 200 : 503).json({ ok: ready });
  });

  apiRouter.use('/client-config', clientConfigRoutes);
  apiRouter.use('/server-settings', serverSettingsRoutes);
  apiRouter.use('/client-diagnostics', clientDiagnosticsRoutes);
  apiRouter.use('/goals', goalRoutes);
  apiRouter.use('/metrics', metricRoutes);
  apiRouter.use('/activity', activityRoutes);
  apiRouter.use('/food', foodRoutes);
  apiRouter.use('/food-days', foodDayRoutes);
  apiRouter.use('/my-foods', myFoodsRoutes);
  apiRouter.use('/nutrition-labels', nutritionLabelsRoutes);
  apiRouter.use('/imports', importRoutes);
  apiRouter.use('/notifications', notificationRoutes);
  apiRouter.use('/sync', syncRoutes);
  apiRouter.use('/watch', watchRoutes);
  apiRouter.use('/calibration', calibrationRoutes);
  apiRouter.use('/calorie-plan', caloriePlanRoutes);
  apiRouter.use('/legal', legalRoutes);
  apiRouter.use('/onboarding', onboardingRoutes);
  apiRouter.use('/user/password', authRateLimiters.passwordChange);
  apiRouter.use('/user', userRoutes);

  // Keep debug/prototype routes (food provider comparisons, etc.) out of production deployments.
  if (!isProductionOrStaging) {
    apiRouter.use('/dev', devRoutes);
    app.use('/dev/test', devTestRoutes);
  }

  app.use(['/api/v1', '/api', '/auth'], apiRouteNotFoundHandler);
  configureFrontendStaticAssets(app, isProductionOrStaging);
  app.use(apiRequestErrorHandler);

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    emitDiagnosticEvent(observabilityConfig, 'backend.ready', {
      port: Number(PORT),
      environment: process.env.NODE_ENV ?? 'development',
      secure_cookies: useSecureCookies,
      cors_origin_count: allowedOriginSet.size,
      metrics_enabled: observabilityConfig.metricsEnabled,
      mcp_enabled: mcpConfiguration.enabled,
      reminder_scheduler_enabled: true
    });
    startReminderScheduler();
  });
};

void bootstrap().catch((err) => {
  logSafeOperationalError('backend.startup', err);
  process.exit(1);
});
