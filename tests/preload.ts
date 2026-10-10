// Tests may be launched from a managed pi. Never claim its personal execution host.
// Managed fixture children explicitly receive their own descriptor instead.
delete process.env.ZEROLUX_PI_RUNNER;
