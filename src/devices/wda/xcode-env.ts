import { execFileSync } from 'node:child_process';

const DEFAULT_DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

type XcodeSelect = () => string | undefined;

function xcodeSelectPath(): string | undefined {
    try {
        return execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * The Xcode developer directory for xcodebuild/devicectl: `XCODE_DEVELOPER_DIR`
 * if set, else whatever `xcode-select -p` points at (unless that is only the
 * Command Line Tools, which can't build for a device), else the standard
 * /Applications/Xcode.app location.
 */
export function resolveDeveloperDir(env: NodeJS.ProcessEnv = process.env, select: XcodeSelect = xcodeSelectPath): string {
    const configured = env.XCODE_DEVELOPER_DIR?.trim();
    if (configured) return configured;
    const selected = select();
    if (selected && !selected.includes('CommandLineTools')) return selected;
    return DEFAULT_DEVELOPER_DIR;
}
