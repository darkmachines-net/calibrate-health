/** @file Include native inputs copied by our CNG plugins but located outside Expo's discovery roots. */
module.exports = {
  // Tests and documentation do not contribute code to the production native binary.
  // Kotlin daemon session/cache files appear during Gradle execution, then disappear on exit.
  ignorePaths: ['**/.kotlin/**', '**/__tests__/**', '**/__mocks__/**', '**/src/test/**', '**/src/androidTest/**',
    '**/*.test.*', '**/*.spec.*', '**/docs/**', '**/README*', '**/AGENTS.md'],
  extraSources: [
    { type: 'dir', filePath: 'gradle/native-release/phone', reasons: ['Phone Gradle integrity templates'] },
    { type: 'file', filePath: '../wear/gradle/wrapper/gradle-wrapper.jar', reasons: ['CNG Gradle wrapper'] }
  ]
};
