// tests/e2e/playwright.config.js
const { defineConfig, devices } = require('@playwright/test');
const path = require('path');

module.exports = defineConfig({
    testDir: '.',
    // Skip perf tests by default; `make perf` opts in via PERF=1.
    testIgnore: process.env.PERF ? undefined : '**/perf.spec.js',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 8,
    reporter: 'html',

    use: {
        // baseURL: `file://${path.resolve('../web/index.html')}`,
        baseURL: 'http://localhost:3000',
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 5000,
        navigationTimeout: 5000,
    },

    timeout: 8000,
    expect: {
        timeout: 3000
    },

    webServer: {
        command: 'npx http-server ../web -a 0.0.0.0 -p 3000',
        port: 3000,
        reuseExistingServer: !process.env.CI,
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
        // Firefox and Webkit aren't currently supporting showDirectoryPicker
        // {
        //     name: 'firefox',
        //     use: { ...devices['Desktop Firefox'] },
        // },
        // {
        //     name: 'webkit',
        //     use: { ...devices['Desktop Safari'] },
        // },
    ],
});
