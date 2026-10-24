/** @file IANA timezone validation, option discovery, and user-facing timezone labels. */

import type { ComboboxOption } from '../components/Combobox';

type TimeZoneDefinition = {
    value: string;
    label: string;
};

const CURATED_TIME_ZONES: TimeZoneDefinition[] = [
    { value: 'UTC', label: 'UTC' },
    { value: 'Pacific/Honolulu', label: 'Hawaii (Honolulu)' },
    { value: 'America/Anchorage', label: 'Alaska (Anchorage)' },
    { value: 'America/Los_Angeles', label: 'Pacific Time (Los Angeles)' },
    { value: 'America/Phoenix', label: 'Arizona (Phoenix)' },
    { value: 'America/Denver', label: 'Mountain Time (Denver)' },
    { value: 'America/Chicago', label: 'Central Time (Chicago)' },
    { value: 'America/New_York', label: 'Eastern Time (New York)' },
    { value: 'America/Halifax', label: 'Atlantic Time (Halifax)' },
    { value: 'America/Sao_Paulo', label: 'Brazil (Sao Paulo)' },
    { value: 'Europe/London', label: 'United Kingdom (London)' },
    { value: 'Europe/Paris', label: 'Central Europe (Paris)' },
    { value: 'Europe/Helsinki', label: 'Eastern Europe (Helsinki)' },
    { value: 'Europe/Moscow', label: 'Moscow' },
    { value: 'Africa/Johannesburg', label: 'South Africa (Johannesburg)' },
    { value: 'Asia/Dubai', label: 'Gulf Time (Dubai)' },
    { value: 'Asia/Kolkata', label: 'India (Kolkata)' },
    { value: 'Asia/Bangkok', label: 'Indochina (Bangkok)' },
    { value: 'Asia/Shanghai', label: 'China (Shanghai)' },
    { value: 'Asia/Tokyo', label: 'Japan (Tokyo)' },
    { value: 'Asia/Seoul', label: 'Korea (Seoul)' },
    { value: 'Australia/Perth', label: 'Western Australia (Perth)' },
    { value: 'Australia/Adelaide', label: 'Central Australia (Adelaide)' },
    { value: 'Australia/Sydney', label: 'Eastern Australia (Sydney)' },
    { value: 'Pacific/Auckland', label: 'New Zealand (Auckland)' }
];

/** Mirrors backend validation using the runtime's IANA timezone database. */
export function isValidIanaTimeZone(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date(0));
        return true;
    } catch {
        return false;
    }
}

/** Read the native device's configured timezone through Intl without requesting location access. */
export function detectDeviceTimeZone(
    resolver: () => string | undefined = () => Intl.DateTimeFormat().resolvedOptions().timeZone
): string | null {
    try {
        const detected = resolver()?.trim();
        return detected && isValidIanaTimeZone(detected) ? detected : null;
    } catch {
        return null;
    }
}

/** Prefer a device suggestion only while the account still has an untouched profile. */
export function resolveOnboardingTimeZone(
    accountTimeZone: string | null | undefined,
    deviceTimeZone: string | null,
    hasStartedProfile: boolean
): string {
    const savedTimeZone = accountTimeZone?.trim();
    if (hasStartedProfile && savedTimeZone && isValidIanaTimeZone(savedTimeZone)) return savedTimeZone;
    if (deviceTimeZone && isValidIanaTimeZone(deviceTimeZone)) return deviceTimeZone;
    if (savedTimeZone && isValidIanaTimeZone(savedTimeZone)) return savedTimeZone;
    return 'UTC';
}

/** Uses curated timezone labels or derives a readable location from the IANA identifier. */
export function formatTimeZoneLabel(value: string): string {
    const curated = CURATED_TIME_ZONES.find((option) => option.value === value);
    if (curated) return curated.label;

    const parts = value.split('/').filter(Boolean).map((part) => part.replace(/_/g, ' '));
    if (parts.length <= 1) return parts[0] || value;
    const city = parts.at(-1);
    return `${city} (${parts.slice(0, -1).join(' / ')})`;
}

/** Formats the current clock and UTC offset for a valid IANA timezone, otherwise null. */
export function formatTimeZoneClock(value: string, now = new Date()): string | null {
    if (!isValidIanaTimeZone(value)) return null;
    try {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: value,
            hour: 'numeric',
            minute: '2-digit',
            timeZoneName: 'shortOffset'
        }).formatToParts(now);
        const time = parts
            .filter(({ type }) => type === 'hour' || type === 'minute' || type === 'dayPeriod')
            .map(({ value: part, type }) => type === 'minute' ? `:${part}` : type === 'dayPeriod' ? ` ${part}` : part)
            .join('');
        const offset = parts.find(({ type }) => type === 'timeZoneName')?.value;
        return [time, offset].filter(Boolean).join(' | ');
    } catch {
        return null;
    }
}

/** Builds distinct valid timezone options with device/selected context and current clock labels. */
export function getTimeZoneOptions(
    selectedTimeZone: string,
    deviceTimeZone: string | null,
    now = new Date()
): Array<ComboboxOption<string>> {
    const values = [deviceTimeZone, selectedTimeZone, ...CURATED_TIME_ZONES.map(({ value }) => value)]
        .filter((value): value is string => typeof value === 'string' && isValidIanaTimeZone(value));
    const uniqueValues = [...new Set(values)];

    return uniqueValues.map((value) => {
        const context: string[] = [];
        if (value === deviceTimeZone) context.push('Device time zone');
        if (value === selectedTimeZone) context.push('Selected');
        const clock = formatTimeZoneClock(value, now);
        if (clock) context.push(clock);
        context.push(value);
        return {
            value,
            label: formatTimeZoneLabel(value),
            description: context.join(' | ')
        };
    });
}
