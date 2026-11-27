/**
 * True when an Appium/WDA error means the local WDA port forward went away
 * (WDA exited on the phone), as opposed to a slow or failed command.
 */
export function isWdaConnectionLost(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ECONNREFUSED|ECONNRESET|socket hang up|Could not proxy command to the remote server/i.test(message);
}

export const WDA_LOST_DURING_VERIFY = 'WebDriverAgent stopped during the touch check and did not come back. '
    + 'This is usually a second WDA launch on the same phone (another terminal running wda:start, wda:prepare or wda:service, '
    + 'Xcode running a test target, or a separate Appium script) or a beta Xcode. '
    + 'Close anything else that talks to the phone, run "Register and prepare WDA" again, then verify.';
