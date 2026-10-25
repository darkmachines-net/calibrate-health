/** @file +html: Web-only document metadata shared by every statically rendered Expo route. */

import { type PropsWithChildren } from 'react';
import { ScrollViewStyleReset, useServerDocumentContext } from 'expo-router/html';
import { WEB_ACCESSIBILITY_STYLES } from '../src/accessibility/webAccessibilityStyles';
import { resolveRouteMetadata } from '../src/navigation/routeMetadata';

const ONE_TIME_TOKEN_BOOTSTRAP = `
(function () {
  try {
    var pathname = window.location.pathname;
    if (pathname !== '/reset-password' && pathname !== '/verify-email') return;
    var hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    var queryParams = new URLSearchParams(window.location.search);
    var token = hashParams.get('token') || queryParams.get('token');
    if (!token) return;
    window.__calibrateOneTimeToken = { pathname: pathname, token: token };
    queryParams.delete('token');
    var query = queryParams.toString();
    window.history.replaceState(window.history.state, '', pathname + (query ? '?' + query : ''));
  } catch (_) {}
})();`;

/** Web-only document metadata shared by every statically rendered Expo route. */
export default function RootHtml({ children, pathname }: PropsWithChildren<{ pathname: string }>) {
    const { htmlAttributes, bodyAttributes, headNodes, bodyNodes } = useServerDocumentContext();
    const metadata = resolveRouteMetadata(pathname, { authenticated: false });
    return (
        <html lang="en" {...htmlAttributes}>
            <head>
                <title>{metadata.title}</title>
                <meta name="description" content={metadata.description} />
                <meta name="robots" content={metadata.robots} />
                {metadata.canonicalPath ? <link rel="canonical" href={metadata.canonicalPath} /> : null}
                <meta charSet="utf-8" />
                <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
                <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover" />
                <meta name="theme-color" content="#2E7D32" />
                <meta name="color-scheme" content="light dark" />
                <link rel="manifest" href="/manifest.webmanifest" />
                <link rel="icon" href="/calibrate-icon.svg" type="image/svg+xml" />
                <style dangerouslySetInnerHTML={{ __html: WEB_ACCESSIBILITY_STYLES }} />
                <script dangerouslySetInnerHTML={{ __html: ONE_TIME_TOKEN_BOOTSTRAP }} />
                <ScrollViewStyleReset />
                {headNodes}
            </head>
            <body {...bodyAttributes}>
                {children}
                {bodyNodes}
            </body>
        </html>
    );
}
