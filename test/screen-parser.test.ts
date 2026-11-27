import assert from 'node:assert/strict';
import test from 'node:test';

import {
    iconsFromResponse,
    parseScreenIcons,
    screenParserConfigFromEnv,
    screenParserReady,
    tiktokEngagementState,
    type ParsedIcon,
    type ScreenParserConfig,
} from '../src/tiktok/screen-parser.js';

const SCREEN = { width: 375, height: 667 };
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const CONFIG: ScreenParserConfig = { url: 'http://127.0.0.1:8000', timeoutMs: 1000, minConfidence: 0.35 };

function icon(label: string, confidence: number, cx: number, cy: number): ParsedIcon {
    return { label, confidence, centerPct: [cx, cy] };
}

test('screenParserConfigFromEnv is off when SCREEN_PARSER_URL is unset or blank', () => {
    assert.equal(screenParserConfigFromEnv({}), undefined);
    assert.equal(screenParserConfigFromEnv({ SCREEN_PARSER_URL: '  ' }), undefined);
});

test('screenParserConfigFromEnv reads url, token and limits', () => {
    assert.deepEqual(screenParserConfigFromEnv({ SCREEN_PARSER_URL: 'http://127.0.0.1:8000/' }), {
        url: 'http://127.0.0.1:8000', timeoutMs: 5000, minConfidence: 0.35,
    });
    assert.deepEqual(screenParserConfigFromEnv({
        SCREEN_PARSER_URL: 'https://parser.local',
        SCREEN_PARSER_TOKEN: 'secret',
        SCREEN_PARSER_TIMEOUT_MS: '2500',
        SCREEN_PARSER_MIN_CONFIDENCE: '0.5',
    }), { url: 'https://parser.local', token: 'secret', timeoutMs: 2500, minConfidence: 0.5 });
    assert.throws(() => screenParserConfigFromEnv({ SCREEN_PARSER_URL: 'ftp://x' }), /http\(s\) URL/);
    assert.throws(() => screenParserConfigFromEnv({ SCREEN_PARSER_URL: 'not a url' }), /http\(s\) URL/);
    assert.throws(() => screenParserConfigFromEnv({ SCREEN_PARSER_URL: 'http://x', SCREEN_PARSER_TIMEOUT_MS: '10' }), /between 500/);
    assert.throws(() => screenParserConfigFromEnv({ SCREEN_PARSER_URL: 'http://x', SCREEN_PARSER_MIN_CONFIDENCE: '2' }), /between 0.01/);
});

test('iconsFromResponse keeps well-formed icons and rejects a missing array', () => {
    assert.deepEqual(iconsFromResponse({
        icons: [
            { label: 'tt_like', confidence: 0.9, centerPct: [93.1, 45.2], box: [1, 2, 3, 4] },
            { label: 'tt_save', confidence: 'high', centerPct: [93, 60] },
            { label: 'tt_share', confidence: 0.8, centerPct: [93] },
            null,
        ],
    }), [icon('tt_like', 0.9, 93.1, 45.2)]);
    assert.throws(() => iconsFromResponse({}), /no icons array/);
    assert.throws(() => iconsFromResponse(null), /no icons array/);
});

test('tiktokEngagementState maps the right-rail heart and bookmark to points', () => {
    const state = tiktokEngagementState([
        icon('tt_like', 0.92, 93.6, 48),
        icon('tt_save', 0.88, 93.6, 66),
        icon('tt_comment', 0.9, 93.6, 57),
    ], SCREEN, 0.35);
    assert.deepEqual(state, {
        like: { x: 351, y: 320, active: false, confidence: 0.92 },
        save: { x: 351, y: 440, active: false, confidence: 0.88 },
    });
});

test('tiktokEngagementState reports filled icons as already active', () => {
    const state = tiktokEngagementState([icon('tt_liked', 0.9, 93, 48), icon('tt_saved', 0.7, 93, 66)], SCREEN, 0.35);
    assert.equal(state.like?.active, true);
    assert.equal(state.save?.active, true);
});

test('tiktokEngagementState picks the most confident of plain and filled', () => {
    const state = tiktokEngagementState([icon('tt_like', 0.4, 93, 48), icon('tt_liked', 0.8, 93, 48)], SCREEN, 0.35);
    assert.equal(state.like?.active, true);
});

test('tiktokEngagementState ignores low-confidence and off-rail icons', () => {
    assert.deepEqual(tiktokEngagementState([
        icon('tt_like', 0.2, 93, 48),
        icon('tt_like', 0.95, 40, 70),
        icon('tt_save', 0.95, 10, 66),
    ], SCREEN, 0.35), {});
});

test('tiktokEngagementState clamps targets inside the screen', () => {
    const state = tiktokEngagementState([icon('tt_like', 0.9, 100, 100)], SCREEN, 0.35);
    assert.deepEqual({ x: state.like?.x, y: state.like?.y }, { x: 374, y: 666 });
});

test('parseScreenIcons posts the PNG with auth and returns icons', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fakeFetch = (async (url: string, init: RequestInit) => {
        seen = { url, init };
        return new Response(JSON.stringify({ icons: [{ label: 'tt_like', confidence: 0.9, centerPct: [93, 48] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const icons = await parseScreenIcons({ ...CONFIG, token: 't0ken' }, PNG, fakeFetch);
    assert.deepEqual(icons, [icon('tt_like', 0.9, 93, 48)]);
    assert.equal(seen?.url, 'http://127.0.0.1:8000/v1/parse');
    assert.equal(seen?.init.method, 'POST');
    const headers = seen?.init.headers as Record<string, string>;
    assert.equal(headers['content-type'], 'image/png');
    assert.equal(headers.authorization, 'Bearer t0ken');
});

test('parseScreenIcons sends non-PNG bytes as JPEG and surfaces HTTP errors', async () => {
    let contentType: string | undefined;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
        contentType = (init.headers as Record<string, string>)['content-type'];
        return new Response('{}', { status: 503 });
    }) as unknown as typeof fetch;
    await assert.rejects(parseScreenIcons(CONFIG, Buffer.from([0xff, 0xd8, 0xff, 0xe0]), fakeFetch), /HTTP 503/);
    assert.equal(contentType, 'image/jpeg');
});

test('screenParserReady is false on errors and non-2xx, true on 200', async () => {
    const ok = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const notReady = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    const down = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    assert.equal(await screenParserReady(CONFIG, ok), true);
    assert.equal(await screenParserReady(CONFIG, notReady), false);
    assert.equal(await screenParserReady(CONFIG, down), false);
});
