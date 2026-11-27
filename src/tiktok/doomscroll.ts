import { remote, type Browser } from 'webdriverio';

import { loadRegisteredDevices, resolveDeviceCoordinates, WdaRemoteControl } from '@git-agni/phone-farm-core';
import { coordinateProfile, registeredAccounts } from './runtime-settings.js';
import { switchTikTokAccount, tapCoordinate, setScreenSize } from './actions.js';
import { detectEngagementControls } from './engagement-controls.js';
import {
    parseScreenIcons,
    screenParserConfigFromEnv,
    screenParserReady,
    tiktokEngagementState,
    type EngagementState,
} from './screen-parser.js';
import {
    PROFILES,
    clampToDeadline,
    decideLike,
    decideLinger,
    decideSave,
    hasTimeRemaining,
    isPersonality,
    pickWatchDurationMs,
} from './doomscroll-profile.js';
import { isEnabled, humanDelay, swipeSequence } from './humanizer.js';

function positiveInteger(name: string, fallback: number): number {
    const rawValue = process.env[name] ?? String(fallback);
    const value = Number.parseInt(rawValue, 10);
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer; received ${rawValue}`);
    }
    return value;
}

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
    const value = positiveInteger(name, fallback);
    if (value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}; received ${value}`);
    }
    return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be 'true' or 'false'; received ${raw}`);
}

const udid = process.env.IOS_UDID;
if (!udid) {
    throw new Error('IOS_UDID is required. Copy .env.example to .env and set the connected device UDID.');
}

const personalityRaw = process.env.DOOMSCROLL_PERSONALITY ?? 'casual';
if (!isPersonality(personalityRaw)) {
    throw new Error(`DOOMSCROLL_PERSONALITY must be one of skimmer, casual, engaged; received ${personalityRaw}`);
}
const personality = personalityRaw;
const profile = PROFILES[personality];

const durationMinutes = boundedInteger('DOOMSCROLL_DURATION_MINUTES', 5, 1, 180);
const likeEnabled = booleanEnv('DOOMSCROLL_LIKE_ENABLED', true);
const saveEnabled = booleanEnv('DOOMSCROLL_SAVE_ENABLED', true);
const switchAccountName = process.env.TIKTOK_SWITCH_ACCOUNT?.trim() || undefined;
// Optional icon-detection service. Unset means the original behaviour.
const screenParser = screenParserConfigFromEnv();
const registeredDevice = (await loadRegisteredDevices()).find((device) => device.udid === udid);
const coordinates = resolveDeviceCoordinates(coordinateProfile(registeredDevice), registeredDevice?.coordinates);
setScreenSize(coordinates.screenSize);
const tiktokCoordinates = coordinates.tiktok;
const accountSwitchCoords = {
    profileTabX: tiktokCoordinates.profileTab.x,
    profileTabY: tiktokCoordinates.profileTab.y,
    switcherTriggerX: tiktokCoordinates.accountSwitcher.x,
    switcherTriggerY: tiktokCoordinates.accountSwitcher.y,
};
// switchTikTokAccount ends on the Profile tab (it re-checks there to verify
// the switch). The scroll loop below expects the Home feed, so only
// doomscroll needs to navigate back — tiktok-post.ts's Create button works
// from any bottom-nav tab.
const { x: homeTabX, y: homeTabY } = tiktokCoordinates.homeTab;

// Fail fast, before unlocking or launching TikTok, if the requested account
// isn't one this device is registered for.
const allowedAccounts = switchAccountName
    ? registeredAccounts(registeredDevice)
    : [];
if (switchAccountName && !allowedAccounts.includes(switchAccountName)) {
    throw new Error(`TikTok account "${switchAccountName}" is not listed in devices.json for device ${udid}`);
}
let screenSize = coordinates.screenSize;
let { x: likeX, y: likeY } = tiktokCoordinates.like;
let { x: saveX, y: saveY } = tiktokCoordinates.save;
const { x: swipeX, startY: swipeStartY, endY: swipeEndY, durationMs: swipeDurationMs } = tiktokCoordinates.swipe;
const wdaUrl = process.env.WDA_URL;
const tiktokBundleId = process.env.TIKTOK_BUNDLE_ID ?? 'com.zhiliaoapp.musically';

const capabilities: WebdriverIO.Capabilities & Record<string, unknown> = {
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:udid': udid,
    'appium:bundleId': tiktokBundleId,
    'appium:noReset': true,
    'appium:forceAppLaunch': true,
    'appium:shouldTerminateApp': true,
    'appium:newCommandTimeout': 120,
    'appium:wdaLaunchTimeout': 120000,
    'appium:wdaConnectionTimeout': 120000,
    // TikTok's video feed never becomes fully idle. Waiting for quiescence can
    // make otherwise-completed gestures block until the WDA proxy times out.
    'appium:waitForIdleTimeout': 0,
    'appium:showXcodeLog': process.env.SHOW_XCODE_LOG === 'true',
};

if (wdaUrl) {
    capabilities['appium:webDriverAgentUrl'] = wdaUrl;
    capabilities['appium:wdaRemotePort'] = positiveInteger('WDA_REMOTE_PORT', 8100);
} else if (process.env.XCODE_ORG_ID) {
    capabilities['appium:xcodeOrgId'] = process.env.XCODE_ORG_ID;
    capabilities['appium:xcodeSigningId'] = process.env.XCODE_SIGNING_ID ?? 'Apple Development';
}
if (!wdaUrl && process.env.WDA_BUNDLE_ID) {
    capabilities['appium:updatedWDABundleId'] = process.env.WDA_BUNDLE_ID;
}
if (!wdaUrl && process.env.ALLOW_PROVISIONING_DEVICE_REGISTRATION === 'true') {
    capabilities['appium:allowProvisioningDeviceRegistration'] = true;
}
if (!wdaUrl && process.env.WDA_BOOTSTRAP_PATH) {
    capabilities['appium:useXctestrunFile'] = true;
    capabilities['appium:bootstrapPath'] = process.env.WDA_BOOTSTRAP_PATH;
}

// Cooperative cancellation: a Stop request sends SIGTERM (see
// src/automations/runner.ts). Every wait below races against stopPromise so
// a stop interrupts immediately instead of waiting out the current sleep.
let stopRequested = false;
let resolveStop: () => void = () => {};
const stopPromise = new Promise<void>((resolve) => { resolveStop = resolve; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
        stopRequested = true;
        resolveStop();
    });
}

function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        void stopPromise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });
}

function interactionPauseMs(): number {
    return Math.round(200 + Math.random() * 400);
}

// After this many parser errors in a row the run stops asking it, so a dead
// service costs a few seconds, not a timeout on every video.
const MAX_PARSER_FAILURES = 3;
const VERIFY_SETTLE_MS = 700;
let parserActive = false;
let parserFailures = 0;

async function readEngagement(remoteControl: WdaRemoteControl): Promise<EngagementState | undefined> {
    if (!screenParser || !parserActive) return undefined;
    try {
        const screenshot = await remoteControl.getScreenshot(udid!);
        const icons = await parseScreenIcons(screenParser, screenshot);
        parserFailures = 0;
        return tiktokEngagementState(icons, screenSize, screenParser.minConfidence);
    } catch (error) {
        parserFailures += 1;
        console.log(`Screen parser failed (${parserFailures}/${MAX_PARSER_FAILURES}); using fallback coordinates: ${error instanceof Error ? error.message : String(error)}`);
        if (parserFailures >= MAX_PARSER_FAILURES) {
            parserActive = false;
            console.log('Screen parser disabled for the rest of this run');
        }
        return undefined;
    }
}

async function doubleTapCoordinate(driver: Browser, x: number, y: number, label: string): Promise<void> {
    await tapCoordinate(driver, x, y, label);
    // Short, fixed gap so TikTok's gesture recognizer reads this as a
    // double-tap-to-like rather than two separate taps.
    await driver.pause(130);
    await tapCoordinate(driver, x, y, label);
}

let driver: Browser | undefined;
let videosViewed = 0;
let swipes = 0;
let likes = 0;
let saves = 0;
let parserLikes = 0;
let parserSaves = 0;
let likesConfirmed = 0;
let savesConfirmed = 0;
let alreadyLiked = 0;
let alreadySaved = 0;
const runStartedAt = Date.now();

console.log(`Starting doomscroll: profile=${personality} requestedDurationMinutes=${durationMinutes} likeEnabled=${likeEnabled} saveEnabled=${saveEnabled}`);

try {
    const remoteControl = new WdaRemoteControl({
        deviceUdid: udid,
        wdaUrl,
        passcodeKeypadLayout: coordinates.passcodeKeypad,
    });
    console.log('Checking device lock state');
    await remoteControl.unlock(udid);

    console.log(`Opening TikTok on ${udid}`);
    driver = await remote({
        hostname: process.env.APPIUM_HOST ?? '127.0.0.1',
        port: positiveInteger('APPIUM_PORT', 4725),
        path: '/',
        logLevel: 'info',
        connectionRetryCount: 0,
        connectionRetryTimeout: 180000,
        capabilities,
    });

    await driver.updateSettings({ defaultActiveApplication: tiktokBundleId });
    await driver.pause(3000);

    if (switchAccountName) {
        console.log(`Switching to TikTok account "${switchAccountName}"`);
        await switchTikTokAccount(driver, remoteControl, udid, switchAccountName, accountSwitchCoords);
        // switchTikTokAccount leaves the app on the Profile tab; the loop
        // below expects the Home feed.
        await tapCoordinate(driver, homeTabX, homeTabY, 'Home tab');
        await driver.pause(1500);
    }

    try {
        const [screenshot, screen] = await Promise.all([
            remoteControl.getScreenshot(udid),
            remoteControl.getScreenInfo(udid),
        ]);
        screenSize = screen.screenSize;
        const detected = await detectEngagementControls(screenshot, screen.scale);
        if (detected) {
            ({ x: likeX, y: likeY } = detected.like);
            ({ x: saveX, y: saveY } = detected.save);
            console.log(`Detected TikTok engagement controls: like=(${likeX}, ${likeY}) save=(${saveX}, ${saveY}) confidence=${detected.confidence.toFixed(3)}`);
        } else {
            console.log(`Could not confidently detect TikTok engagement controls; using ${coordinateProfile(registeredDevice)} profile coordinates`);
        }
    } catch (error) {
        console.log(`Engagement control detection failed; using profile coordinates: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (screenParser) {
        parserActive = await screenParserReady(screenParser);
        console.log(parserActive
            ? `Screen parser ready at ${screenParser.url}; like/save are located on every video`
            : `Screen parser at ${screenParser.url} is not ready; using fallback coordinates for this run`);
    }

    const deadline = Date.now() + durationMinutes * 60_000;

    while (!stopRequested && hasTimeRemaining(Date.now(), deadline)) {
        await cancellableDelay(clampToDeadline(Date.now(), deadline, pickWatchDurationMs(profile)));
        videosViewed += 1;
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        // One parse per video serves both decisions; a confirmation parse
        // after a tap replaces it, so save always sees the latest frame.
        let engagement: EngagementState | undefined;
        let engagementRead = false;
        const currentEngagement = async (): Promise<EngagementState | undefined> => {
            if (!engagementRead) {
                engagement = await readEngagement(remoteControl);
                engagementRead = true;
            }
            return engagement;
        };
        const confirmEngagement = async (): Promise<EngagementState | undefined> => {
            await cancellableDelay(VERIFY_SETTLE_MS);
            engagement = await readEngagement(remoteControl);
            return engagement;
        };

        if (likeEnabled && decideLike(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            const like = (await currentEngagement())?.like;
            if (stopRequested) break;
            if (like?.active) {
                alreadyLiked += 1;
                console.log('Video is already liked; not tapping');
            } else if (like) {
                // The parser saw the unfilled heart, so one tap on the icon
                // likes it. (A double-tap on the button itself would toggle.)
                await tapCoordinate(driver, like.x, like.y, `Like (parser ${like.confidence.toFixed(2)})`);
                likes += 1;
                parserLikes += 1;
                if ((await confirmEngagement())?.like?.active) likesConfirmed += 1;
                else console.log('Like not confirmed on the next frame');
            } else {
                await doubleTapCoordinate(driver, likeX, likeY, 'Like');
                likes += 1;
            }
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        if (saveEnabled && decideSave(profile)) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
            if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;
            const save = (await currentEngagement())?.save;
            if (stopRequested) break;
            if (save?.active) {
                alreadySaved += 1;
                console.log('Video is already saved; not tapping');
            } else if (save) {
                await tapCoordinate(driver, save.x, save.y, `Save (parser ${save.confidence.toFixed(2)})`);
                saves += 1;
                parserSaves += 1;
                if ((await confirmEngagement())?.save?.active) savesConfirmed += 1;
                else console.log('Save not confirmed on the next frame');
            } else {
                await tapCoordinate(driver, saveX, saveY, 'Save');
                saves += 1;
            }
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        const { linger, extraMs } = decideLinger(profile);
        if (linger) {
            await cancellableDelay(clampToDeadline(Date.now(), deadline, extraMs));
        }
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        await cancellableDelay(clampToDeadline(Date.now(), deadline, interactionPauseMs()));
        if (stopRequested || !hasTimeRemaining(Date.now(), deadline)) break;

        // Coordinate actions bypass XCTest's expensive application-element
        // lookup, which can hang on TikTok's continuously updating feed.
        if (isEnabled()) {
            const seq = swipeSequence(swipeX, swipeStartY, swipeX, swipeEndY, coordinates.screenSize.width, coordinates.screenSize.height);
            await driver.performActions([{
                type: 'pointer',
                id: 'finger',
                parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, x: seq.path[0].x, y: seq.path[0].y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: 100 },
                    ...seq.path.slice(1).flatMap((point, i) => {
                        return { type: 'pointerMove', duration: seq.durations[i], x: point.x, y: point.y };
                    }),
                    { type: 'pointerUp', button: 0 },
                ],
            }]);
            await driver.releaseActions();
        } else {
            await driver.performActions([{
                type: 'pointer',
                id: 'finger',
                parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, x: swipeX, y: swipeStartY },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: 100 },
                    { type: 'pointerMove', duration: swipeDurationMs, x: swipeX, y: swipeEndY },
                    { type: 'pointerUp', button: 0 },
                ],
            }]);
            await driver.releaseActions();
        }
        swipes += 1;
    }

    const elapsedMs = Date.now() - runStartedAt;
    const reason = stopRequested ? 'stopped' : 'completed';
    console.log(`Finished doomscroll: videosViewed=${videosViewed} swipes=${swipes} likes=${likes} saves=${saves} elapsedMs=${elapsedMs} reason=${reason}`);
    if (screenParser) {
        console.log(`Screen parser: likes=${likesConfirmed}/${parserLikes} confirmed, saves=${savesConfirmed}/${parserSaves} confirmed, alreadyLiked=${alreadyLiked}, alreadySaved=${alreadySaved}, fallbackLikes=${likes - parserLikes}, fallbackSaves=${saves - parserSaves}`);
    }
} finally {
    if (driver) {
        await driver.deleteSession();
    }
}
