/** @file Regression coverage for release Entry: Android release entry. */

import fs from 'node:fs';
import path from 'node:path';

describe('Android release entry', () => {
    it('uses a project-local Expo Router shim for hoisted workspace dependencies', () => {
        const packageJson = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8')
        ) as { main?: string };
        const entrySource = fs.readFileSync(path.resolve(__dirname, '../../index.js'), 'utf8');

        expect(packageJson.main).toBe('index.js');
        expect(entrySource).toContain("import 'expo-router/entry';");
    });
});
