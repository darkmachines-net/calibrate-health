/** @file Regression coverage for manifest Contract: web app manifest. */

import fs from 'node:fs';
import path from 'node:path';

type ManifestIcon = { src: string; sizes: string; type: string; purpose?: string };
type ManifestShortcut = { name: string; url: string; icons?: ManifestIcon[] };

function pngDimensions(filePath: string): { width: number; height: number } {
    const bytes = fs.readFileSync(filePath);
    expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe('web app manifest', () => {
    const publicDir = path.join(process.cwd(), 'public');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8')
    ) as {
        id: string;
        name: string;
        short_name: string;
        start_url: string;
        scope: string;
        display: string;
        background_color: string;
        theme_color: string;
        icons: ManifestIcon[];
        shortcuts: ManifestShortcut[];
    };

    it('uses scope-relative install URLs that stay on the serving hosted or self-hosted origin', () => {
        expect(manifest).toMatchObject({
            id: './',
            name: 'Calibrate Health',
            short_name: 'Calibrate',
            start_url: './',
            scope: './',
            display: 'standalone',
            background_color: '#F6F8F4',
            theme_color: '#2E7D32'
        });
        expect(JSON.stringify(manifest)).not.toMatch(/https?:\/\//);
    });

    it('declares truthful any-purpose and maskable PNG assets', () => {
        const expected = [
            ['calibrate-icon-192.png', 192, 'any'],
            ['calibrate-icon-512.png', 512, 'any'],
            ['calibrate-icon-maskable-512.png', 512, 'maskable']
        ] as const;

        for (const [filename, size, purpose] of expected) {
            expect(manifest.icons).toContainEqual(expect.objectContaining({
                src: `./${filename}`,
                sizes: `${size}x${size}`,
                type: 'image/png',
                purpose
            }));
            expect(pngDimensions(path.join(publicDir, filename))).toEqual({ width: size, height: size });
        }
    });

    it('provides same-scope shortcuts for the three primary authenticated actions', () => {
        expect(manifest.shortcuts.map(({ name, url }) => ({ name, url }))).toEqual([
            { name: 'Today', url: './today' },
            { name: 'Log food', url: './food-log' },
            { name: 'Log weight', url: './weight' }
        ]);
    });
});
