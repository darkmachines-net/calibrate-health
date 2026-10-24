/** @file Regression coverage for keyboard Layout Config: Android keyboard layout configuration. */

const appConfig = require('../../app.json') as {
    expo?: { android?: { softwareKeyboardLayoutMode?: string } };
};

describe('Android keyboard layout configuration', () => {
    it('resizes the app window instead of panning inputs behind the keyboard', () => {
        expect(appConfig.expo?.android?.softwareKeyboardLayoutMode).toBe('resize');
    });
});
